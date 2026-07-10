# ADR-0009: Deploy state is hosted in the workspace, not in local files

## Status

Accepted

## Decision

Deploy state — the provisioning engine's record of what exists in the cloud —
lives in a Prisma Postgres database inside a reserved, framework-owned project
(`prisma-app-state`) in the deployer's workspace, not in files on the machine
that deployed. Every deploy bootstraps it automatically: find-or-create the
project, verify ownership, mint a fresh database connection for the run.
Possession of the workspace's service token is the only credential; no state
file, password, or connection string is ever shared between machines.

## Reasoning

Start with the failure this kills. A developer deploys an app from their
laptop; a teammate (or a CI runner, or the same developer on another machine)
runs the identical deploy command for the identical app. With Alchemy's default
local state, the second machine has no record that the stack exists — so it
provisions everything again: a second project, a second database, a second set
of services. The first deployment is now orphaned, still running, still billing,
and no machine holds the state needed to destroy it. Nothing failed loudly; the
second deploy was a clean success.

The framework provisions through Alchemy, an engine that (like Terraform) works by
diffing the desired graph against a **state store** — its record of what it
provisioned last time. That store is the source of truth for "what exists":
whoever can read it deploys incrementally, and whoever cannot will duplicate.
Keeping it in files makes it single-machine by construction. The fix is the
one hosted-state products (Terraform Cloud, Pulumi) converged on: state lives
with the platform, scoped to the team's namespace — here, the Prisma
workspace.

Where inside the workspace can it live? Prisma's hierarchy is Workspace →
Project → Database: there is no workspace-level database, so the store must sit
inside *some* project. The application's own project is circular — that project
is itself a resource *tracked in* state (it doesn't exist before the first
apply, and destroying the stack would delete the record of the teardown
mid-flight) — and per-app stores would fragment the workspace view (listing
stacks, cross-stack references, and the fresh-machine bootstrap all need one
place to look). So the store gets a dedicated project outside any user
topology: framework-owned operational infrastructure, never declared by a
system, never destroyed by a stack.

That project is discovered by name — and the platform allows several projects
to share a name, so a name match alone proves nothing. Bootstrap therefore
verifies ownership by looking inside the candidate's default database: a
marker table identifies a store as ours; a database containing only our schema
is adopted and marked; an empty database (a freshly created project) is
initialized; a database holding foreign tables is refused loudly, naming the
project so an operator can act. With several candidates, they are tried
oldest-first, so every machine converges on the same store deterministically.
Discovery also filters candidates by workspace, and workspace ids circulate in
two shapes — API responses return them prefixed (`wksp_…`), tokens and config
usually carry them bare — so the comparison normalizes both sides; compared
raw, the shapes never match and every deploy would quietly build itself a
fresh store.

Credentials are the part that makes this zero-setup. The platform returns a
database connection string only at connection-creation time — it is write-only
on read. Rather than store or distribute that secret, bootstrap mints a fresh
connection every run and lets it age out (stale ones are swept, best-effort,
at the next bootstrap). The result: a machine needs exactly what it already
needed to deploy at all — the service token and workspace id — and the DSN
never lands in a file anywhere.

The store itself is two tables — one row per provisioned resource, keyed by
stack, stage, and the engine's fully-qualified resource name, plus one row per
stack's outputs — with values passing through Alchemy's own state encoding, so
the wire shape is identical to every other Alchemy store and the engine cannot
tell the difference.

## Consequences

- Any machine holding the workspace's service token deploys any stack
  incrementally: a fresh clone redeploys as a no-op instead of duplicating.
- Concurrent deploys of one stack become a real possibility, which is why they
  are serialized by a lock ([ADR-0010](ADR-0010-deploys-hold-a-session-advisory-lock.md)).
- One `prisma-app-state` project is visible in every workspace that has deployed.
  That visibility is the honest cost of building the store from public
  primitives; the intended end state is a platform-side state API behind the
  workspace's own auth, at which point the visible project disappears and this
  store becomes a client of it.
- Access control is coarse: anyone with a workspace service token can read and
  write all of that workspace's deploy state. Finer RBAC arrives with the
  platform-side API, not before.
- State values are stored as plain rows (the database is encrypted at rest).
  Provisioned credentials passing through state is a standing concern tracked
  independently of where state lives.
- The store accumulates one connection resource per deploy; bootstrap's sweep
  bounds it. Name-squatting of `prisma-app-state` is detected and refused, not
  prevented — reserving the name is a platform capability we do not have.

## Alternatives considered

- **Keep local state as the default** — rejected: the duplicate-stack failure
  above is silent, destructive, and hits exactly when a second machine or
  teammate appears, which is when a team is least equipped to notice.
- **A state database inside the application's own project** — rejected as
  circular: the project is created and destroyed *by* the deploys whose state
  it would hold, and per-app stores fragment every workspace-level question.
- **A platform-hosted state API** (the engine's HTTP state-store client is
  already shipped) — the right end state, but a platform surface we cannot
  build from the client side; this store is the interim that proves the shape.
- **Encrypting values client-side** with a shared key — rejected: it
  reintroduces exactly the secret-distribution problem the mint-per-run
  bootstrap eliminates.

## Related

- [`ADR-0010`](ADR-0010-deploys-hold-a-session-advisory-lock.md) — how
  concurrent deploys against the shared store are serialized.
- [`ADR-0011`](ADR-0011-targets-supply-the-deploy-state-layer.md) — how a
  deploy selects this store without the user opting in.
- [`ADR-0012`](ADR-0012-the-state-store-speaks-sql-directly.md) — the store's
  own data-access choice.
- [`../03-domain-model/layering.md`](../03-domain-model/layering.md) — the
  provisioning-state spectrum (local → workspace-hosted → platform-run).

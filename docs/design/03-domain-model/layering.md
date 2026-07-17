# Layering: Prisma Composer → Alchemy → Prisma Cloud

Prisma Composer's model exists at three planes. The developer authors
in the framework's plane; the framework **lowers** that into the Alchemy/Effect
**provisioning plane**, which provisions it to run as Prisma Cloud hosting
primitives.

This is the same shape as Prisma Next: an authored data contract lowers to an IR
/ plan, which executes against a database. Here, an authored topology lowers to a
resource graph, which deploys to the cloud.

> Naming: the grouping unit is called a **Module** (see
> [ADR-0014](../90-decisions/ADR-0014-one-authoring-primitive.md)
> for the settled name). "Module" thereafter.

## The three planes

- **Authoring plane (Prisma Composer)** — what the developer writes.
  Nouns: **Module**, **Service**, **Resource**, **Input**, **Output**,
  **Data Contract**, **Topology**. Statically analyzable; this is the
  ubiquitous language (see `glossary.md`).
- **Provisioning plane (Alchemy / Effect)** — how the framework represents,
  wires, and provisions. Nouns: Resource, Platform, Binding, Layer, Provider,
  Stack, Config. The framework adopts Alchemy's *definition language*; the
  apply *engine* is an open question (see below).
- **Hosting plane (Prisma Cloud)** — what actually runs. Nouns: ComputeService /
  ComputeVersion, Database (1:1 within an Environment), Stream, endpoint. Prisma
  Cloud is *one* target; another target's pack maps the same authoring nouns to
  its own hosting primitives. The framework's deploy report calls a thing on
  this plane a **Deployment entity** (`DeployedEntity`): its kind, platform id,
  and — only when the target says it is publicly reachable — its URL.

## The mapping

| Authoring (Prisma Composer) | Provisioning (Alchemy/Effect) | Hosting (Prisma Cloud) |
| --- | --- | --- |
| **Module** (bounded context) | a subgraph: Resources/Platforms + a Layer exposing its ports | **no single object** — spans Compute services + a DB schema slice + streams + endpoints |
| **Service** (your code; entrypoint + ingress) | Platform (compute Resource running the bundle) | ComputeService → ComputeVersion (tar.gz bundle + manifest + endpoint) |
| **Resource** (managed lifecycle, state-first) | Alchemy Resource + Provider (`reconcile`/`delete`/…); Postgres via the Prisma Postgres provider | a Database (1:1 in an Environment), bucket, cache, or provisioned third-party |
| **Input/Output — communication** (request/response, stream) | Binding (RPC/HTTP client; stream pub/sub) | endpoint URL + injected client; stream |
| **Data Input** (method TCP/HTTP + contract) | data binding to a Postgres Resource | connection injected, scoped by contract |
| **Data Output** (offered contract hashes) | the Postgres Resource's provided data | the DB schema satisfying the aggregate contract |
| **Configuration** (per-env values, secrets) | `effect/Config` (`Config.redacted`), bound to the Platform env | env var / secret on the running compute — not a node |
| **Topology** (graph of Modules/Resources) | Stack(s) **+ the framework's emit step** (which Alchemy lacks) | the provisioned set + injected wiring |

## Structural claims

1. **A Module is an authoring/reasoning unit, not a hosting unit.** It lowers to a
   *subgraph* of hosting primitives — its Services become Compute services, its
   data becomes a schema slice in a Database, its streams become Stream instances.
   The hosting plane can still co-locate (several Modules sharing one Environment
   Database, carved by the aggregate contract). Boundaries and isolation live at
   the *authoring* plane, not the hosting plane.

2. **The framework owns the lowering and the emit step.** Alchemy gives the
   definition language and (optionally) provisioning; it has no "serialize the
   desired graph as a portable artifact" step. The framework adds that — the
   topology artifact an external orchestrator consumes.

3. **Definition language *and* engine.** The framework adopts Alchemy/Effect for the
   *definition* of resources, bindings, and ports, **and** uses Alchemy's *engine*
   (plan→apply + state) for provisioning — run from the client or a privileged CD
   environment. Prisma services are provisioned by Alchemy providers that call
   Prisma's Management API (Prisma already ships Postgres/Compute wrappers). There
   is **no bespoke orchestrator**; a server-side one is deferred, not precluded.

## What the platform actually provides today

(See the `ignite` reference notes; assume these are the resource set.)

- **Compute** — Bun on Unikraft microVMs, HTTP-first, scale-to-zero. Deploy
  artifact = a tar.gz bundle + a minimal manifest (`{manifestVersion, entrypoint}`).
  A Prisma Composer Service lowers almost directly to this.
- **Postgres** — managed; `Environment:Database` is 1:1, so co-located Services
  share one Database.
- **Streams** — assume a streaming primitive is available.
- **HTTP ingress/egress** — Compute has ingress built in; assume egress too.
- Wiring today is **env vars baked at deploy** (`DATABASE_URL`). The
  framework's no-globals DI is a layer on top: it reads those at the boundary
  and injects typed handles, so user code never reads the environment.

Notes: there is no general Prisma provisioning orchestrator (Foundry deploys
Compute only) — the framework provisions via Alchemy's engine instead (see
below). Prisma offers no first-party object/file storage; a Module that needs
storage uses a **BYO Alchemy resource** (R2, S3, …). Accelerate and Pulse are
discontinued.

## Resources: first-class vs BYO

In Prisma Composer, a Resource is an Alchemy resource surfaced as a
typed **capability**. A Module's Input requires a capability; a Resource's
Output provides one (via an Alchemy
Layer); the wire is valid iff the provided capability satisfies the required one —
Alchemy type-checks it.

- **First-class** (Postgres): framework-native treatment — Postgres data uses
  Prisma Next data contracts (hashed, verifiable). (Compute is a Service's target,
  not a Resource; a stream is a connection style.)
- **BYO** (object storage, cache, queues, third-party): *any* Alchemy resource,
  exposed through a capability Layer. The Module depends on the capability, not
  the vendor — swap R2 for S3 by swapping the Layer; the Module is unchanged.
  This is how a Module uses, e.g., file storage today.

Openness is delegated to Alchemy's resource/Layer ecosystem, not added as a
framework plugin enum. First-class resources lower to the Prisma plane; BYO
resources lower to their own Alchemy providers, provisioned against the user's own
cloud.

**Managed lifecycle.** A Resource's provider implements its lifecycle
(`reconcile`/`delete`/…). Those hooks can call cloud APIs *or* a third-party/partner
API, so a provisioned third-party account — Stripe, Tigris, a Prisma-brokered
Mailchimp — is a Resource. A service you only *call* (you hold a key, nobody
provisions it) is **Configuration**, not a Resource.

**Local emulation is the framework's job.** Alchemy deliberately doesn't
emulate (`alchemy dev` = real cloud). So each Resource ships a **local
stand-in Layer** beside its real provider, and the framework swaps it in for
`prisma dev` — same interface, no cloud. This is what satisfies the
reproduce-in-the-emulator goal (see `../00-purpose/goals.md`).

## Provisioning & state

Provisioning runs through **Alchemy's engine**, invoked from the client or a
privileged CD environment (see claim 3). The engine keeps a **state store** —
the source of truth for what's provisioned. State sits on a spectrum from
local, to workspace-hosted, to eventually platform-run:

- **Local** — Alchemy's local or Cloudflare-backed state. Fine for a solo
  developer; nothing else needs to see it.
- **Workspace-hosted** — a `StateService` implementation
  (`@internal/lowering/state`) backed by a Prisma Postgres database in a
  workspace-scoped project, native to the Workspace → Project → Environment
  hierarchy (Pulumi/Terraform-Cloud-style hosted state, without the
  BYO-state bootstrap). Bootstrap is automatic: the Management API finds or
  creates the store's project and its default database on first use, so a
  deployer needs nothing beyond the service token and workspace id it already
  has. Concurrency is a per-`(stack, stage)` advisory lock, so two deployers
  can never race the same stack. `prismaCloud()` supplies this as the default
  deploy state for every service and Module; an explicit state layer always
  overrides it. This is framework-owned operational infrastructure, not a
  user-topology Resource — ambient per project, never declared by a Module
  (which also sidesteps the chicken-and-egg of provisioning the store
  itself). Like hosted-state backends generally, it also holds state for the
  user's BYO resources in other clouds.
- **Server-side runs** — the platform executes the apply loop itself
  (git-push-style deploys). Once state is workspace-hosted, moving the engine
  server-side is incremental — the same evolution Pulumi/Terraform Cloud
  followed. This step's platform surface is implementing Alchemy's own HTTP
  `StateApi` (bearer auth → workspace RBAC) as a Management API endpoint; once
  it exists, the workspace-hosted store's visible project disappears and the
  platform can answer "what's provisioned in this project" natively (the
  platform side of the inspectable-topology goal).

## Open questions

- **The BYO-provisioning seam** — Prisma resources provision via providers calling
  Prisma's API; BYO resources provision against the user's own cloud credentials.
  How those credential/state paths sit side by side in one deploy is TBD.

> The topology must also be buildable and emittable as a **queryable artifact**
> for inspection (a project goal) independently of running the apply loop.

## Related

- `glossary.md` — the authoring vocabulary in full.
- `domain-map.md` — how the authoring nouns relate.
- `../04-inspirations/Alchemy/` — the substrate (incl. the viability assessment).

# ADR-0024: A stage is a deploy-time environment; the CLI resolves its Project and Branch before Alchemy

## Decision

An app is deployed to a named **stage** — an environment. The topology is
authored stage-neutral; the stage is chosen on the command line:

```sh
prisma-compose deploy module.ts                  # the production environment
prisma-compose deploy module.ts --stage staging  # an isolated "staging" environment
prisma-compose deploy module.ts --stage pr-42    # one isolated environment per PR
```

Every deploy runs in **two phases**:

```
prisma-compose deploy module.ts --stage staging
│
│  Phase 1 — the CLI, against the Management API
│    ensure Project "storefront-auth"    find by app name, create if absent
│    ensure Branch  "staging"            find by gitName,  create if absent
│
└─ Phase 2 — Alchemy, --stage staging
     provision the Apps, Databases, and config inside (Project, Branch)
     deploy state keyed per (Project, Branch)
```

The CLI resolves and ensures the two **containers** — the app's Project and the
stage's Branch — before Alchemy runs; Alchemy provisions only the resources
*within* them. The default stage (no `--stage`) is the production environment
and lives at the Project level: phase 1 ensures only the Project, and no Branch
is created.

## Rationale

The need is mundane: a second environment — staging, or one per pull request —
that mirrors production without disturbing it. Per
[ADR-0023](ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md), an
environment is a Branch of the app's single Project, so "deploy to staging"
means: provision the whole topology into the `staging` Branch.

**The environment axis enters at the deploy plane, not authoring.** A
`module()` graph has no notion of environment; the same graph becomes
production or a preview depending only on where it is deployed. So the stage is
a deploy-time input, threaded through lowering — it never appears in the
authored topology.

**A stage lowers to two things at once.** An *Alchemy stage* gives the
environment its own deploy-state namespace and physical names. A *Branch* gives
it its own compute, data, and configuration. Same environment, seen from the
engine and from the platform.

**Why Alchemy cannot create the containers.** Alchemy provisions by diffing the
desired graph against per-stage state, so everything it manages lives inside
some stage's state namespace:

- The **Branch** is the container that very namespace is scoped to. A resource
  cannot sit inside the state namespace that is named after it.
- The **Project** is shared by *all* the app's environments. If one stage's
  state owned it, destroying that stage would cascade the Project — and every
  other environment — with it.

Both containers therefore live *above* the per-stage deploy: the CLI resolves
them first, then hands Alchemy their ids.

**App identity is the root module's name.** `module('storefront-auth', …)`
names the Project, so identity travels with the code: a fresh checkout with
only a service token deploys — the CLI finds the `storefront-auth` Project or
creates it. When several Projects share the name, the oldest is adopted, so
repeated deploys converge on the same one. `--name` overrides the derived name.

**Production/preview classification belongs to the platform.** Prisma Cloud
assigns a Branch's role (the first Branch of a Project is production, later
ones preview); the framework never reads it. The only classification the
framework writes is mechanical: configuration written to a Branch is
preview-class, configuration written at the Project level is production-class —
derived from Branch presence, never from a role lookup.

## Consequences

- **One command deploys from a fresh checkout.** The first deploy creates the
  containers; every later deploy finds and adopts them.
- **A named stage is a Branch, and the stage name is the Branch's `gitName`.**
  It must be a valid git ref name; the CLI rejects invalid names rather than
  silently normalizing them.
- **The default stage is the Project level.** No Branch is created and no
  Branch id threads through lowering. On a named stage, every resource the
  target provisions carries the Branch id.
- **Destroy names its target explicitly.** `prisma-compose destroy` requires
  `--stage <name>` or `--production`; a bare destroy is an error, so an omitted
  or mistyped stage can never silently tear down production. Destroying a named
  stage removes its resources and then its Branch; the production Branch is
  never deleted.
- **Stage is a first-class deploy-plane input**, threaded from the CLI through
  lowering to the target.
- **Deploy state stays per (Project, Branch)** through Alchemy's existing
  per-stage keying; the state machinery is unchanged.

## Alternatives considered

- **One Project per stage.** Each environment its own Project. Rejected: no
  Project represents the app, environments share nothing, and the platform
  never sees "app X's environments" — the shape
  [ADR-0023](ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md)
  already rejected.
- **Creating the Branch (and Project) inside Alchemy.** Rejected for the
  circularity above: the Branch is the container its own state is scoped to,
  and the shared Project cannot belong to any single stage's state without a
  stage destroy cascading the whole app.
- **The framework asserts the Branch role.** Rejected: production/preview is
  the platform's classification, assigned by the platform. The framework's
  deploys behave the same whichever role a Branch carries, so asserting it buys
  nothing and couples the framework to platform policy.

## Related

- [ADR-0023](ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md) —
  App = one Project, Stage = Branch; the mapping this decision operationalizes.
- [ADR-0009](ADR-0009-deploy-state-is-hosted-in-the-workspace.md) — the
  workspace-hosted deploy state this keying lands in.
- [ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md) — deploy
  derives everything from the root node; app name → Project extends it.
- `docs/design/03-domain-model/glossary.md` — Stage → Environment.

# ADR-0023: A Prisma App is one Project; a Stage is a Branch

## Decision

A Prisma App lowers to **one Prisma Cloud Project**. The Modules inside the app
become that Project's **Apps** (compute services) and **Databases**. Every
deployment environment — production, staging, a per-PR preview — is a **Branch**
of that one Project, and an environment's resources, configuration, and deploy
state are scoped to its Branch.

Concretely, this app:

```ts
export default module('storefront-auth', {}, ({ provision }) => {
  const db = provision('database', postgres({ name: 'database' }));
  const auth = provision('auth', authService, { db });
  provision('storefront', storefrontService, { auth: auth.rpc });
  return {};
});
```

lowers onto Prisma Cloud as:

```
Workspace
└── Project "storefront-auth"          ← the app (named by the root module)
    ├── Branch "main"                  ← the production environment
    │   ├── App "auth"
    │   ├── App "storefront"
    │   ├── Database "database"
    │   └── config (production-class)
    └── Branch "staging"               ← a second, isolated environment
        ├── App "auth"
        ├── App "storefront"
        ├── Database "database"        ← its own data
        └── config (preview-class)
```

One Project, many Branches; the Apps and Databases repeat per Branch. How a
deploy names a stage and resolves it to a Branch is
[ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md).

## Rationale

Prisma Cloud's hierarchy is Workspace → Project → **Branch** → { App, Database }.
The Branch sits *between* the Project and the compute/data resources: the unit
you branch is the Project, and the Apps and Databases are what fork with it.
Each Branch carries its own resources and its own configuration.

The operation that makes this mapping matter: a developer opens a pull request
and wants a preview. What needs previewing is the *whole app* — every Module,
its data, the wiring between them — isolated from production. If the app is one
Project, that is one platform action: a new Branch forks the full set of Apps
and Databases with its own configuration, and tears down as a unit when the PR
closes.

If instead each Module were its own Project, nothing would represent the app. A
preview would mean creating a parallel branch in each of N Projects and
coordinating them by hand — matching names, re-pointing every cross-Module
connection at the right branch's endpoints, destroying them in concert. The
platform would never see "one app, previewed."

Deploy state follows the same shape. The engine keys state by (stack, stage),
and one-Project-per-app gives those keys durable platform identities: the
Project is the stack, the Branch is the stage. Because the Project outlives
every Branch, state anchored at the Project level is never destroyed by tearing
down the environment that wrote it.

## Consequences

- **Modules are siblings inside one Project.** A Module's service lowers to an
  App (compute service); its postgres lowers to a Database — never to a Project
  of its own.
- **Environment isolation is Branch isolation.** Each Branch has its own
  compute, its own data, and its own configuration. A fresh Branch's Postgres
  starts empty; whatever schema the app needs is established per Branch.
- **Deploy state is per (Project, Branch)**, anchored at the Project — the
  container that outlives every environment.
- **Branch lifecycle lives outside Alchemy.** Alchemy diffs and provisions the
  resources *within* a (Project, Branch); it cannot create or destroy the
  Branch, because the Branch is the container its own per-stage state is scoped
  to. The deploy CLI creates the containers before Alchemy runs
  ([ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)).
- **Whole-topology PR previews become a platform-native operation**, not a
  framework-orchestrated one.

## Alternatives considered

- **One Project per Module.** Each Module its own Project with its own default
  Branch. Rejected: nothing represents the app, so branching — the mechanism
  behind previews and per-branch configuration — fragments across N Projects
  and must be hand-coordinated, and the platform never sees the app as a single
  branchable unit. The isolation it offers is expressed as well by sibling Apps
  and Databases under one Project.

## Related

- [ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)
  — how a deploy names a stage and resolves it to this Project + Branch.
- [ADR-0034](ADR-0034-deploy-state-lives-in-the-stage-branch.md) — deploy state
  hosted per stage in the Branch this mapping defines.
- `docs/design/03-domain-model/glossary.md` — Stage → Environment.

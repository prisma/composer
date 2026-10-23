# ADR-0051: A node's address is its logical ID on the platform

> Superseded by [ADR-0057](ADR-0057-a-nodes-address-is-its-full-path-from-the-app-name.md): a node's address starts with the app name (`shop.catalog`), and resource IDs, environment variable keys and `serviceOrigin()` are built from it.

> Amended 2026-10-16: on the app's own Project and Branch, the row holding a node's `logicalId` is that node's row, and a deploy uses it even without a record of it in deploy state. The first version said Composer must never take over a row because it holds the same `logicalId`. See Consequences.

## Decision

Every node's address is its identity on Prisma Cloud. Composer writes the address, byte for byte, as the `logicalId` of the one platform row that represents the node, and submits the same string as the node's `logicalId` in the branch's application topology. Nothing else is ever written to `logicalId`.

```ts
export default module('shop', ({ provision }) => {
  const catalog = provision(rawPostgres({ name: 'catalog' }));
  const auth = provision(authModule, { deps: { db: catalog } }); // module `auth`, containing compute service `api`
  provision(webService, { deps: { db: catalog, auth: auth.rpc } }); // compute service `web`
});
```

```
node address   topology node          platform row
────────────   ────────────────────   ─────────────────────────────────────────
shop           logicalId "shop"       Project   logicalId "shop"
catalog        logicalId "catalog"    Database  logicalId "catalog"   id db_cm3x…
auth           logicalId "auth"       (a module has no row)
auth.api       logicalId "auth.api"   App       logicalId "auth.api"  id app_7f2…
web            logicalId "web"        App       logicalId "web"       id app_k91…
```

Deploying the same configuration to the stage `pr-123` creates new App and Database rows on that stage's Branch, with different `id`s and the same `logicalId`s. That is how the platform knows `web` on `pr-123` is the same service as `web` on `main`.

## Reasoning

Prisma Cloud's Project, App, Database and Bucket rows each carry three identifiers, each with one job:

| Identifier | Set by | Identifies | Unique within |
| --- | --- | --- | --- |
| `id` | the platform | one physical row | everywhere |
| `logicalId` | the configuration | the declared entity, on every branch | its Branch (a Project: its workspace) |
| `displayName` | Composer or the platform; Console can change it | nothing; it is a label | nothing |

Composer already has an identity for every node: its **address**. The address is the path of provision IDs from the root, assigned by Load (`auth.api`). A node's provision ID is its `name` unless `provision(node, { id })` sets one, so the name an author writes is, by default, part of the node's identity. The root's direct children have bare addresses, and the root's address is the application's name: the root's name, or `--name` for a deploy (ADR-0006). Provision IDs are letters and digits only, so below the root an address contains only letters, digits and dots. Addresses are unique within a graph, they are derived from code, and git carries them between branches with the rest of the configuration. That is exactly what `logicalId` is for, so the address is the value. The platform's side of this design is the pdp-control-plane [branch topology spec](https://github.com/prisma/pdp-control-plane/blob/main/projects/branch-topology/spec.md).

The platform depends on the two copies being equal. The application topology Composer submits on each deploy names every node by `logicalId` and contains no platform `id`s, because the rows don't exist yet when it is written. Console and CI then join topology nodes to rows by plain string equality on `logicalId`. A node with no matching row was declared but not created. A row whose `logicalId` matches no node is no longer declared. A row with no `logicalId` matches nothing. Comparing a database on a preview branch with its counterpart on `main` is the same lookup on two branches. If the row's `logicalId` differs from the node's by even one character, every one of these reads silently finds nothing.

So the value must be the address, not something that resembles it. In particular, it is never:

- **an Alchemy resource ID.** Alchemy is the deploy engine Composer lowers to. Composer names Alchemy resources after the address plus a role suffix (`catalog-db`, `catalog-conn`, `web-svc`), because one node lowers to several resources. Those names are Composer's internal naming and appear nowhere in the topology. Below the root an address never contains `-`, so a value like `catalog-db` on an App, Database or Bucket row is always one of these. Alchemy's own documentation calls its resource ID a "logical ID". That is a different value from the platform's `logicalId`, and the shared words must not be read as the same thing. Upstream Alchemy's Prisma resources default `logicalId` to their fully qualified resource ID, which for Composer is the resource ID, so Composer always passes `logicalId` explicitly.
- **a display name.** It is a label. Composer often derives it from the address, so the two can look alike, but it carries no identity.
- **a platform `id`.** It differs on every branch and doesn't exist until the row does.

Only the node's own row carries the `logicalId`. A compute service's row is its App, a postgres resource's row is its Database, a bucket's row is its Bucket, and the root's row is the Project. Other platform rows the lowering creates for a node, such as connections, deployments, environment variables and bucket access keys, are not topology nodes and carry none. A module has no row of its own.

One writer owns each row's `logicalId`. For App, Database and Bucket rows, it is the upstream Alchemy resource that creates the row, through its `logicalId` prop (ADR-0048). For the Project, it is container resolution, which creates the Project with its `logicalId` before Alchemy runs and finds it by that `logicalId` on later deploys (ADR-0024). No separate resource or later API call writes a `logicalId`.

## Consequences

- Changing a node's address gives it a new identity, and the platform and the deploy see a different entity. Changing a node's `name` (when `provision()` sets no `id`), changing its provision ID, or moving it into another module all do this. None of these is a rename. Below the root, the deploy deletes the old entity's rows; for a database or a bucket, that deletes its data. For the root, the new name resolves to a different Project, and the old Project is left in place.
- Changing a display name never changes identity.
- The address format is an identity contract. The platform treats `logicalId` as an opaque string and never parses it, so Composer may change how addresses are composed, but any change re-identifies every existing entity.
- Every node kind that lowers to a platform row must pass the node's address as that row's `logicalId`. A new node kind isn't done until it does. An upgrade that gives a resource a `logicalId` prop must pass the address in the same change, or the default writes the Alchemy resource ID.
- A `logicalId` says which node a row is, so on the app's own Project and Branch the row holding a node's `logicalId` is that node's row. A deploy uses that row even when its deploy state has no record of it. The usual case is resuming a create that was interrupted after the platform created the row but before Alchemy recorded its ID. Composer therefore declares its App, Database and Bucket resources as its own (Alchemy's per-resource `adopt(true)`), so Alchemy does not refuse a row it cannot otherwise prove it created. The Project is found the same way, by `logicalId`, in container resolution.
- Composer's environment variables follow the same rule by key. Every key Composer writes is built from the node's address inside the reserved `COMPOSER_` namespace, which apps cannot declare, so on the app's own Branch the key identifies the variable the way `logicalId` identifies a row.
- Using a row means owning it: Composer updates it to the declared configuration, and deletes it when the node is removed, when its address changes, or when the stage is destroyed. A row created outside Composer with one of the app's addresses on its Branch is treated as that node's row. Two apps with the same name in one workspace already share one Project; they now also share rows instead of failing.
- A stage whose Branch holds rows but which has no deploy state at all is still refused before the deploy starts (ADR-0045). The rows could be identified, but the rest of the state could not be rebuilt from them: generated parameter values would be minted again, Connections would not be recognized, and Deployments and bucket access keys would be created twice.
- Destroy does not use rows it has no record of. Destroying a stage right after an interrupted deploy leaves the half-created row: for a named stage, deleting its Branch removes it; for production, deploy once more before destroying, or delete the row by hand.
- Renaming an Alchemy resource ID must go through Alchemy's rename declaration (`renamedFrom`). Otherwise a single deploy could use the existing row under the new ID and delete it under the old one.
- When no Project has the app name as its `logicalId`, container resolution falls back to matching a Project by display name. This is a compatibility path for Projects created before they carried a `logicalId`. That path is not identity and is not extended to other rows.
- Local dev (ADR-0041) creates no platform rows and writes no `logicalId`.

## Alternatives considered

- **Use Alchemy's default (its resource ID).** No extra code, but `catalog-db` never equals the topology's `catalog`. Every join would fail, and the topology would have to submit Composer's internal resource naming instead of the declaration.
- **Write `logicalId` with a separate Composer resource after the row is created.** Duplicates what the upstream resource does (ADR-0048), and puts two resources in charge of one field. When they disagree, they fight on every deploy.
- **Put platform `id`s in the topology.** The `id`s don't exist when the topology is written, before the apply. They also differ on every branch, so they can't say "the same service on `main`".
- **Match on display names.** They are mutable and not unique. Matching Projects by display name forked deploy history when a Project was renamed.
- **Refuse a row Composer cannot prove it created, even when it holds the node's `logicalId`.** This was this decision's first wording. It contradicts what the field is for: the row holding the node's `logicalId` on the app's Branch is that node's row by definition. In practice it left a stage that could not be deployed again after one interrupted create, and Alchemy's error asked for an `--adopt` flag Composer doesn't have; destroying the stage was the only recovery.
- **Have Console read Alchemy's deploy state to map nodes to rows.** That state is Composer's private bookkeeping. Its format belongs to the deploy engine, it contains secrets, and the platform deliberately stores it without reading it.

## Related

- [ADR-0006](ADR-0006-every-node-is-named.md) — every node is named; the root's name names the application. Amended by this ADR.
- [ADR-0023](ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md) — a stage is a Branch.
- [ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md) — container resolution finds the Project. Amended by this ADR.
- [ADR-0048](ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md) — Prisma Cloud resources come from the upstream Alchemy provider.
- [core-model.md](../10-domains/core-model.md), "Deployment identity" — the address.
- [alchemy-lowering.md § Platform identity](../05-prisma-cloud/alchemy-lowering.md#platform-identity-logicalid) — which resource carries the `logicalId` for each node kind, and its current status.
- [glossary.md § Address and logical ID](../03-domain-model/glossary.md#address-and-logical-id).

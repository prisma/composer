# ADR-0051: A node's address is its logical ID on the platform

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

The same configuration deployed to the stage `pr-123` produces different `id`s and the same `logicalId`s. That is how the platform knows `web` on `pr-123` is the same service as `web` on `main`.

## Reasoning

Every Prisma Cloud entity has three identifiers, each with one job:

| Identifier | Set by | Identifies | Unique within |
| --- | --- | --- | --- |
| `id` | the platform | one physical row | everywhere |
| `logicalId` | the configuration | the declared entity, on every branch | its Branch (a Project: its workspace) |
| `displayName` | the user | nothing; it is a label | nothing |

Composer already has an identity for every node: its **address**, the path of provision IDs from the root, assigned by Load (`auth.api`). The root's direct children have bare addresses, and the root's address is the application's name (ADR-0006). Addresses are unique within a graph, they are derived from code, and git carries them between branches with the rest of the configuration. That is exactly what `logicalId` is for, so the address is the value. The platform's side of this design is the pdp-control-plane [branch topology spec](https://github.com/prisma/pdp-control-plane/blob/main/projects/branch-topology/spec.md) and its ADR-011.

The platform depends on the two copies being equal. The application topology Composer submits on each deploy names every node by `logicalId` and contains no platform `id`s, because the rows don't exist yet when it is written. Console and CI then join topology nodes to Project, App, Database and Bucket rows by plain string equality on `logicalId`. A node with no matching row was declared but not created. A row with no matching node is no longer declared. Comparing a database on a preview branch with its counterpart on `main` is the same lookup on two branches. If the row's `logicalId` differs from the node's by even one character, every one of these reads silently finds nothing.

So the value must be the address, not something that resembles it. In particular, it is never:

- **an Alchemy resource ID.** Alchemy is the deploy engine Composer lowers to. Composer names Alchemy resources after the address plus a role suffix (`catalog-db`, `catalog-conn`, `web-svc`), because one node lowers to several resources. Those names are Composer's internal naming and appear nowhere in the topology. Upstream Alchemy's Prisma resources default `logicalId` to their own resource ID, so Composer always passes `logicalId` explicitly.
- **a display name.** Users rename display names freely in Console, and a rename must change nothing.
- **a platform `id`.** It differs on every branch and doesn't exist until the row does.

Only the node's own row carries the `logicalId`. A compute service's row is its App, a postgres resource's row is its Database, a bucket's row is its Bucket, and the root's row is the Project. Supporting rows the lowering creates for a node, such as connections, deployments, environment variables and service keys, are not topology nodes and carry none. A module has no row of its own.

The `logicalId` is written through the upstream Alchemy resource that creates the row, as a prop on that resource (ADR-0048). Composer doesn't write it with a separate resource or a later API call. One resource owns each row, so one resource owns its `logicalId`.

## Consequences

- Changing a node's address changes its identity. The node is then a different entity: the platform and the deploy see a new node, and the old one's rows are deleted. Moving a node into another module, or changing its provision ID, does this. Renaming a display name does not.
- The address format is an identity contract. The platform treats `logicalId` as an opaque string and never parses it, so Composer may change how addresses are composed, but any change re-identifies every existing entity.
- Every node kind that lowers to a platform row must pass the node's address as that row's `logicalId`. A new node kind isn't done until it does.
- A `logicalId` already held by another row on the same Branch fails the deploy. Composer never adopts that row.
- Local dev (ADR-0041) creates no platform rows and writes no `logicalId`.

## Alternatives considered

- **Use Alchemy's default (its resource ID).** No extra code, but `catalog-db` never equals the topology's `catalog`. Every join would fail, and the topology would have to submit Composer's internal resource naming instead of the declaration.
- **Write `logicalId` with a separate Composer resource after the row is created.** Duplicates what the upstream resource does (ADR-0048), and puts two resources in charge of one field. When they disagree, they fight on every deploy.
- **Put platform `id`s in the topology.** The `id`s don't exist when the topology is written, before the apply. They also differ on every branch, so they can't say "the same service on `main`".
- **Match on display names.** They are mutable and not unique. Matching Projects by display name forked deploy history on rename, which is why Projects got a `logicalId` first.
- **Have Console read Alchemy's deploy state to map nodes to rows.** That state is Composer's private bookkeeping. Its format belongs to the deploy engine, it contains secrets, and the platform deliberately stores it without reading it.

## Related

- [ADR-0006](ADR-0006-every-node-is-named.md) — every node is named; the root's name names the application.
- [ADR-0023](ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md) — a stage is a Branch.
- [ADR-0048](ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md) — Prisma Cloud resources come from the upstream Alchemy provider.
- [core-model.md § Deployment identity](../10-domains/core-model.md) — the address.
- [alchemy-lowering.md § Platform identity](../05-prisma-cloud/alchemy-lowering.md#platform-identity-logicalid) — which resource carries the `logicalId` for each node kind.
- [glossary.md § Address and logical ID](../03-domain-model/glossary.md#address-and-logical-id).

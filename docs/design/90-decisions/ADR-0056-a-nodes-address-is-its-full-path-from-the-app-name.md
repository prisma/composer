# ADR-0056: A node's address is its full path from the app name, and every identifier is built from it

## Decision

A node's address is the path of provision IDs starting at the root, and the root's address is the deployed app name. Every child's address therefore starts with the app name: `shop`, `shop.catalog`, `shop.auth.api`. That one string is the node's only identity. Composer writes it, byte for byte, as the platform `logicalId` of the node's row and of its node in the branch's application topology, and builds every other identifier for the node from it.

```ts
export default module('shop', ({ provision }) => {
  const catalog = provision(rawPostgres({ name: 'catalog' }));
  const auth = provision(authModule, { deps: { db: catalog } }); // module `auth`, containing compute service `api`
  provision(webService, {
    deps: { db: catalog, auth: auth.rpc },                      // compute service `web`
    params: { authOrigin: serviceOrigin('shop.auth.api') },
  });
});
```

```
address        platform row                         Alchemy resource IDs                 env keys
─────────────  ───────────────────────────────────  ───────────────────────────────────  ───────────────────────
shop           Project   logicalId "shop"           (none; found before Alchemy runs)
shop.catalog   Database  logicalId "shop.catalog"   shop.catalog, shop.catalog.conn, …
shop.auth      (a module has no row)                (none)
shop.auth.api  App       logicalId "shop.auth.api"  shop.auth.api, shop.auth.api.deploy  COMPOSER_SHOP_AUTH_API_…
shop.web       App       logicalId "shop.web"       shop.web, shop.web.deploy            COMPOSER_SHOP_WEB_…
```

Deploying the same configuration to the stage `pr-123` creates new App and Database rows on that stage's Branch, with different `id`s and the same `logicalId`s. That is how the platform knows `shop.web` on `pr-123` is the same service as `shop.web` on `main`.

An app deployed before this decision used addresses without the app name (`catalog`, `auth.api`) and resource IDs with `-` suffixes (`catalog-db`, `catalog-conn`, `web-svc`). Its next deploy moves every resource to its new ID in place. No database, bucket, generated secret or service key is recreated.

## Reasoning

### One string names a node everywhere

Load, the step that runs the module bodies and builds the in-memory graph, assigns every node its address. A node's provision ID is its `name` unless `provision(node, { id })` sets one, so the names an author writes are, by default, part of the node's identity. A child's address is its parent's address, a dot, and its provision ID. The definition has no special case: the root's address is its own provision ID, which is the app name, so every address below it starts with the app name too.

If children left the app name out, as `auth.api` does, a reference to a node would need a second piece of context to say which app it means: the linked project, or the directory. With the app name in the address, one string is enough. It is what the CLI prints and accepts, what errors and logs name, and what the platform stores. The platform's topology also allows a Branch to hold more than one app; short addresses from two apps would collide there, and full ones do not.

The root's address is the *deployed* app name. That is the root module's name, or the value of `prisma deploy --name` when it is given (ADR-0006). Every place that writes an address uses the deployed name, so the topology's root node and the Project always carry the same `logicalId`.

Below the root, provision IDs are letters and digits only. The app name may also contain `-` and `_`. So an address is the app name, then any number of dots each followed by letters and digits. Addresses are unique within a graph, they are derived from code, and git carries them between branches with the rest of the configuration.

### The address is the platform `logicalId`

Prisma Cloud's Project, App, Database and Bucket rows each carry three identifiers, each with one job:

| Identifier | Set by | Identifies | Unique within |
| --- | --- | --- | --- |
| `id` | the platform | one physical row | everywhere |
| `logicalId` | the configuration | the declared entity, on every branch | its Branch (a Project: its workspace) |
| `displayName` | Composer or the platform; Console can change it | nothing; it is a label | nothing |

The address is exactly what `logicalId` is for, so the address is the value. The platform's side of this design is the pdp-control-plane [branch topology spec](https://github.com/prisma/pdp-control-plane/blob/main/projects/branch-topology/spec.md).

The platform depends on the two copies being equal. The application topology Composer submits on each deploy names every node by `logicalId` and contains no platform `id`s, because the rows don't exist yet when it is written. Console and CI then join topology nodes to rows by plain string equality on `logicalId`. A node with no matching row was declared but not created. A row whose `logicalId` matches no node is no longer declared. A row with no `logicalId` matches nothing. Comparing a database on a preview branch with its counterpart on `main` is the same lookup on two branches. If the row's `logicalId` differs from the node's by even one character, every one of these reads silently finds nothing.

So the value is the address, not something that resembles it. It is never:

- **a display name.** It is a label. Composer often derives it from the address, so the two can look alike, but it carries no identity.
- **a platform `id`.** It differs on every branch and doesn't exist until the row does.
- **chosen by upstream Alchemy.** Alchemy is the deploy engine Composer lowers to. Its Prisma resources default `logicalId` to their own fully qualified resource ID, which is Alchemy's bookkeeping, not Composer's declaration. Composer always passes `logicalId` explicitly. Alchemy's own documentation calls its resource ID a "logical ID"; that is a different field from the platform's `logicalId`, even where the two now hold the same string.

Only the node's own row carries the `logicalId`. A compute service's row is its App, a postgres resource's row is its Database, a bucket's row is its Bucket, and the root's row is the Project. Other platform rows the lowering creates for a node, such as connections, deployments, environment variables and bucket access keys, are not topology nodes and carry none. A module has no row of its own.

One writer owns each row's `logicalId`. For App, Database and Bucket rows, it is the upstream Alchemy resource that creates the row, through its `logicalId` prop (ADR-0048). For the Project, it is container resolution, which creates the Project with its `logicalId` before Alchemy runs and finds it by that `logicalId` on later deploys (ADR-0024). No separate resource or later API call writes a `logicalId`.

### Alchemy resource IDs are built from the address

One node lowers to several Alchemy resources: a postgres resource becomes a Database, a Connection, a warm-up step and a migration. Each needs a resource ID that is unique in the stage's deploy state. The node's main resource, the one that creates its row, uses the address itself. Every other piece adds a dot and a role that names the piece:

| Node | Main resource | Other pieces |
| --- | --- | --- |
| compute service `shop.web` | App `shop.web` | Deployment `shop.web.deploy`, one environment variable row per key |
| postgres resource `shop.catalog` | Database `shop.catalog` | Connection `shop.catalog.conn`, `shop.catalog.warm`, `shop.catalog.migrate` |
| bucket `shop.uploads` | Bucket `shop.uploads` | access key `shop.uploads.key` |

A piece that a node has several of, such as an environment variable row or a generated value, adds a segment that says which one. An RPC service key is minted per calling service and input, so it is named under the calling service; a stream key is minted per providing service, so it is named under the provider. The exact roles are listed in [alchemy-lowering.md](../05-prisma-cloud/alchemy-lowering.md#platform-identity-logicalid).

The `logicalId` names a node and a resource ID names one of the pieces the node becomes. They do the same job at different sizes, so they read the same way.

These IDs cannot collide with an address. Every node is either a module, which has children but no Alchemy resources, or a service or resource, which has Alchemy resources but no children. A resource ID `X.role` is only ever built under a service or resource `X`, which has no child that could be named `X.role`.

### Environment variable keys are built from the full address

Composer passes a service its configuration as environment variables in the reserved `COMPOSER_` namespace, which apps cannot declare. A key is `COMPOSER_`, the address's segments upper-cased and joined with `_`, then the owner and name of the value: the address `my-shop.api` gives `COMPOSER_MY_SHOP_API_…`. App names may contain `-`, which is not valid in a POSIX variable name, so `-` is replaced by `_`. That replacement cannot make two keys collide: one app has one root name, and below the root the segments are letters and digits only.

On the app's own Branch a key identifies the variable the way `logicalId` identifies a row.

### `serviceOrigin` takes the full address

`serviceOrigin('shop.auth.api')` binds a parameter to another service's public origin. It takes the same fully qualified address as everything else. If the app is deployed under a different name from the one in the code (`--name`), the address names no node and the deploy fails at Load with an unknown address. That failure is loud, happens before anything is created, and is fixed in one line.

### Existing deployments migrate on their next deploy

A stage deployed before this decision holds resources under the old IDs: the address without the app name, then `-` and the role (`catalog-db`, `catalog-conn`, `web-svc`, `web-deploy`). Pieces that were not named that way, such as environment variable rows, generated values and service keys, hold whatever ID that release built for them. If the new release simply declared the new IDs, Alchemy would see new resources and old ones to remove. The first deploy after upgrading would create an empty database and delete the old one with its data, generate new secrets and rotate the RPC service keys.

So every Alchemy resource Composer declares also declares the ID it had before, with upstream Alchemy's rename declaration (`renamedFrom` from `alchemy/Rename`). Composer computes the old ID from the address, by the same rule the previous release used. Alchemy then moves the state entry to the new ID and updates the resource in place, instead of deleting and recreating it. Generated values, RPC service keys and stream keys are renamed the same way, so their values do not change.

```ts
const db = yield* Prisma.Database('shop.catalog', { ...props, logicalId: 'shop.catalog' })
  .pipe(asOwnRow, renamedFrom('catalog-db'));
const conn = yield* Prisma.Connection('shop.catalog.conn', { database: db, name: 'catalog' })
  .pipe(renamedFrom('catalog-conn'));
```

The rows' `logicalId`s change from the short address to the full one in the same deploy. Upstream Alchemy updates a changed `logicalId` in place: it clears the field, then sets the new value, as the Management API requires.

Three properties make this safe, and each was checked on the real platform:

- A rename whose old ID is not in the state, as on a new stage, does nothing. The declarations can stay in the code.
- A deploy that fails or is killed partway through the renames can be run again, and it finishes them without recreating anything.
- Dots in resource IDs work in Alchemy and in the platform's hosted deploy state, whose URLs carry the ID.

A rename keeps a resource only if its props allow an in-place update. Any prop whose change makes upstream replace the resource keeps the value it has today. A Connection is replaced when its `name` prop changes, and replacing it rotates the database's credentials, so each Connection keeps the `name` it has today (`catalog`, not `shop.catalog`). The same rule applies to every other name Composer derives from the address, such as a bucket access key's `name`. These names are labels, not identity. A name that upstream updates in place, such as a database's display name, may follow the new address; display names are labels and nothing depends on them.

Local dev creates no platform rows. Its per-directory record of which emulator instance backs each node (ADR-0052) is keyed by address. On the first `prisma dev` after upgrading, Composer rewrites the record's keys to full addresses, and moves anything else keyed by address, so local databases keep their data and services keep their ports.

## Consequences

- Changing a node's address gives it a new identity, and the platform and the deploy see a different entity. Changing a node's `name` (when `provision()` sets no `id`), changing its provision ID, moving it into another module, or deploying under a different app name all do this. None of these is a rename: the rename declarations cover only the move from the old format, not a change the author makes. Below the root, the deploy deletes the old entity's rows; for a database or a bucket, that deletes its data. For the root, the new name resolves to a different Project, and the old Project is left in place.
- Changing a display name never changes identity.
- The address format is an identity contract. The platform treats `logicalId` as an opaque string and never parses it, so Composer may change how addresses are composed, but any change re-identifies every existing entity unless it ships with rename declarations, as this one does.
- Every node kind that lowers to a platform row must pass the node's address as that row's `logicalId`, and build its resource IDs from the address. A new node kind isn't done until it does. An upgrade that gives a resource a `logicalId` prop must pass the address in the same change, or the default writes the Alchemy resource ID.
- Changing any Alchemy resource ID must go through a rename declaration. Otherwise a single deploy could use the existing row under the new ID and delete it under the old one.
- The rename declarations from the old format stay in the code. They do nothing on stages that have migrated or were created after this decision.
- A stage migrated by this decision and then deployed by an older Composer has its resources deleted and recreated under the old IDs, losing their data. Nothing protects against this.
- Longer addresses produce longer platform names. Name validation keeps applying to them and fails with a message naming the address; it never shortens a name.
- A `logicalId` says which node a row is, so on the app's own Project and Branch the row holding a node's `logicalId` is that node's row. A deploy uses that row even when its deploy state has no record of it. The usual case is resuming a create that was interrupted after the platform created the row but before Alchemy recorded its ID. Composer therefore declares its App, Database and Bucket resources, and its `COMPOSER_` environment variables, as its own (Alchemy's per-resource `adopt(true)`), so Alchemy does not refuse a row it cannot otherwise prove it created. The Project is found the same way, by `logicalId`, in container resolution.
- Using a row means owning it: Composer updates it to the declared configuration, and deletes it when the node is removed, when its address changes, or when the stage is destroyed. A row created outside Composer with one of the app's addresses on its Branch is treated as that node's row. Two apps with the same name in one workspace share one Project and share rows instead of failing.
- A stage whose Branch holds rows but which has no deploy state at all is still refused before the deploy starts (ADR-0045). The rows could be identified, but the rest of the state could not be rebuilt from them: generated parameter values would be minted again, Connections would not be recognized, and Deployments and bucket access keys would be created twice.
- Destroy does not use rows it has no record of. Destroying a stage right after an interrupted deploy leaves the half-created row: for a named stage, deleting its Branch removes it; for production, deploy once more before destroying, or delete the row by hand.
- When no Project has the app name as its `logicalId`, container resolution falls back to matching a Project by display name. This is a compatibility path for Projects created before they carried a `logicalId`. That path is not identity and is not extended to other rows.
- Local dev (ADR-0041) creates no platform rows and writes no `logicalId`.

## Alternatives considered

- **Keep children's addresses without the app name, and find the app from context** (the linked project, the directory). Every reference to a node would need that second input, and two apps on one Branch would collide.
- **Two terms: a full "address" for people and the platform, and a shorter "path" for code and internal names.** That is two forms of one identity, and every surface would have to say which one it means. One form is simpler and cannot be mixed up.
- **Keep `-` suffixes on resource IDs** (`shop.catalog-db`), so a resource ID can be told from an address on sight. Its only purpose was to catch a bug where upstream Alchemy wrote its resource ID as the `logicalId`, and passing `logicalId` explicitly already prevents that.
- **Resolve `serviceOrigin`'s argument relative to the module the call is written in.** That is a second way to write an address, and it means different things in different files.
- **Let the first deploy after upgrading recreate everything under the new IDs.** It deletes every database's and bucket's data, regenerates secrets and rotates service keys.
- **Use Alchemy's default `logicalId` (its resource ID).** It happens to equal the address for a node's main resource now, but it would then depend on Composer's internal naming and on upstream's defaulting rule. Composer passes the address explicitly so the topology and the row are written from the same value.
- **Write `logicalId` with a separate Composer resource after the row is created.** Duplicates what the upstream resource does (ADR-0048), and puts two resources in charge of one field. When they disagree, they fight on every deploy.
- **Put platform `id`s in the topology.** The `id`s don't exist when the topology is written, before the apply. They also differ on every branch, so they can't say "the same service on `main`".
- **Match on display names.** They are mutable and not unique. Matching Projects by display name forked deploy history when a Project was renamed.
- **Refuse a row Composer cannot prove it created, even when it holds the node's `logicalId`.** The row holding the node's `logicalId` on the app's Branch is that node's row by definition. Refusing it left a stage that could not be deployed again after one interrupted create.
- **Have Console read Alchemy's deploy state to map nodes to rows.** That state is Composer's private bookkeeping. Its format belongs to the deploy engine, it contains secrets, and the platform deliberately stores it without reading it.

## Related

- Supersedes [ADR-0051](ADR-0051-a-nodes-address-is-its-logical-id-on-the-platform.md), which made the address the `logicalId` with children's addresses leaving out the app name.
- [ADR-0006](ADR-0006-every-node-is-named.md) — every node is named; the root's name names the application.
- [ADR-0019](ADR-0019-the-target-owns-config-serialization.md) — the target owns config serialization, including the env keys.
- [ADR-0023](ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md) — a stage is a Branch.
- [ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md) — container resolution finds the Project.
- [ADR-0048](ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md) — Prisma Cloud resources come from the upstream Alchemy provider.
- [ADR-0052](ADR-0052-composer-maps-its-nodes-to-emulator-instances-per-directory.md) — local dev's per-directory record, keyed by address.
- [core-model.md](../10-domains/core-model.md), "Deployment identity" — the address.
- [alchemy-lowering.md § Platform identity](../05-prisma-cloud/alchemy-lowering.md#platform-identity-logicalid) — which resource carries the `logicalId` for each node kind, and every resource ID.
- [glossary.md § Address and logical ID](../03-domain-model/glossary.md#address-and-logical-id).

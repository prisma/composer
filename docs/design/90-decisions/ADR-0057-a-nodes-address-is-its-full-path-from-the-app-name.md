# ADR-0057: A node's address is its full path from the app name, and every identifier is built from it

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
shop.catalog   Database  logicalId "shop.catalog"   shop.catalog, shop.catalog.connection, …
shop.auth      (a module has no row)                (none)
shop.auth.api  App       logicalId "shop.auth.api"  shop.auth.api, shop.auth.api.deployment  COMPOSER_SHOP_AUTH_API_…
shop.web       App       logicalId "shop.web"       shop.web, shop.web.deployment            COMPOSER_SHOP_WEB_…
```

Deploying the same configuration to the stage `pr-123` creates new App and Database rows on that stage's Branch, with different `id`s and the same `logicalId`s. That is how the platform knows `shop.web` on `pr-123` is the same service as `shop.web` on `main`.

An app deployed before this decision used addresses without the app name (`catalog`, `auth.api`) and resource IDs with `-` suffixes (`catalog-db`, `catalog-conn`, `web-svc`). Its next deploy moves every resource to its new ID in place. No database, bucket, generated secret or service key is recreated. Composer's own Connections and bucket access keys are recreated with new credentials, because their names become the full address.

## Reasoning

### One string names a node everywhere

Load, the step that runs the module bodies and builds the in-memory graph, assigns every node its address. A node's provision ID is its `name` unless `provision(node, { id })` sets one, so the names an author writes are, by default, part of the node's identity. A child's address is its parent's address, a dot, and its provision ID. The definition has no special case: the root's address is its own provision ID, which is the app name, so every address below it starts with the app name too.

If children left the app name out, as `auth.api` does, a reference to a node would need a second piece of context to say which app it means: the linked project, or the directory. With the app name in the address, one string is enough. It is what the CLI prints and accepts, what errors and logs name, and what the platform stores. The platform's topology also allows a Branch to hold more than one app; short addresses from two apps would collide there, and full ones do not.

The root's address is the *deployed* app name. That is the root module's name, or the value of `prisma deploy --name` when it is given (ADR-0006). Every place that writes an address uses the deployed name, so the topology's root node and the Project always carry the same `logicalId`.

Below the root, provision IDs are letters and digits only. The app name must start with a letter or digit and contain only letters, digits, `-` and `_`; Load refuses any other name, whether it comes from the code or from `--name`, before anything is deployed. A `.` would split it, and it becomes part of every environment variable key. So an address is the app name, then any number of dots each followed by letters and digits. Addresses are unique within a graph, they are derived from code, and git carries them between branches with the rest of the configuration.

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
| compute service `shop.web` | App `shop.web` | Deployment `shop.web.deployment`, one environment variable row per key `shop.web.env.<KEY>`, generated values `shop.web.generated.<path>`, RPC service keys `shop.web.servicekey.<input>`, a streams key `shop.web.streamkey` |
| postgres resource `shop.catalog` | Database `shop.catalog` | Connection `shop.catalog.connection`, `shop.catalog.warmup`, `shop.catalog.migration` |
| bucket `shop.uploads` | Bucket `shop.uploads` | access key `shop.uploads.accesskey` |

Every role is a noun naming the piece. Changing a role later would need another rename declaration.

A piece that a node has several of, such as an environment variable row or a generated value, adds a segment that says which one. An RPC service key is minted per calling service and input, so it is named under the calling service; a stream key is minted per providing service, so it is named under the provider. The exact roles are listed in [alchemy-lowering.md](../05-prisma-cloud/alchemy-lowering.md#platform-identity-logicalid).

The `logicalId` names a node and a resource ID names one of the pieces the node becomes. They do the same job at different sizes, so they read the same way.

These IDs cannot collide with an address. Every node is either a module, which has children but no Alchemy resources, or a service or resource, which has Alchemy resources but no children. A resource ID `X.role` is only ever built under a service or resource `X`, which has no child that could be named `X.role`.

### Environment variable keys are built from the full address

Composer passes a service its configuration as environment variables in the reserved `COMPOSER_` namespace, which apps cannot declare. A key is `COMPOSER_`, the address's segments upper-cased and joined with `_`, then the owner and name of the value: the address `my-shop.api` gives `COMPOSER_MY_SHOP_API_…`. App names may contain `-`, which is not valid in a POSIX variable name, so `-` is replaced by `_`. Within this format that replacement cannot make two keys collide: one app has one root name, and below the root the segments are letters and digits only. The move from the previous format can, and is handled below.

On the app's own Branch a key identifies the variable the way `logicalId` identifies a row.

### `serviceOrigin` takes the full address

`serviceOrigin('shop.auth.api')` binds a parameter to another service's public origin. It takes the same fully qualified address as everything else. An app that uses `serviceOrigin()` therefore cannot be deployed under a different name with `--name`: the address in the code starts with the app's own name, which then names no node. Writing the `--name` value into the code instead breaks the deploy without `--name`. This is the accepted cost of having one way to write an address.

A `serviceOrigin()` address that names no service fails the deploy with an unknown address while the deploy builds its plan. By then the Project and the stage Branch have been found or created, and the Branch's application topology has been replaced with the new one. No resource the app declares has been created, changed or deleted, and the deploy state is unchanged; until a deploy succeeds, Console's topology names nodes that no row matches yet.

### Existing deployments migrate on their next deploy

A stage deployed before this decision holds resources under the old IDs: the address without the app name, then `-` and the role (`catalog-db`, `catalog-conn`, `web-svc`, `web-deploy`). Pieces that were not named that way, such as environment variable rows, generated values and service keys, hold whatever ID that release built for them. If the new release simply declared the new IDs, Alchemy would see new resources and old ones to remove. The first deploy after upgrading would create an empty database and delete the old one with its data, generate new secrets and rotate the RPC service keys.

So every Alchemy resource Composer declares also declares the ID it had before, with upstream Alchemy's rename declaration (`renamedFrom` from `alchemy/Rename`). Composer computes the old ID from the address, by the same rule the previous release used. Alchemy then moves the state entry to the new ID and updates the resource in place, instead of deleting and recreating it. Generated values, RPC service keys and stream keys are renamed the same way, so their values do not change.

```ts
const db = yield* Prisma.Database('shop.catalog', { ...props, logicalId: 'shop.catalog' })
  .pipe(asOwnRow, renamedFrom('catalog-db'));
const conn = yield* Prisma.Connection('shop.catalog.connection', { database: db, name: 'shop.catalog' })
  .pipe(renamedFrom('catalog-conn'));
```

The rows' `logicalId`s change from the short address to the full one in the same deploy. Upstream Alchemy updates a changed `logicalId` in place: it clears the field, then sets the new value, as the Management API requires.

Three properties make this safe, and each was checked on the real platform:

- A rename whose old ID is not in the state, as on a new stage, does nothing. The declarations can stay in the code.
- A deploy that fails or is killed partway through the renames can be run again, and it finishes them without recreating anything.
- Dots in resource IDs work in Alchemy and in the platform's hosted deploy state, whose URLs carry the ID.

Every platform name Composer writes is the node's address: the App's `displayName`, a local dev Database's `name`, and the Connection, Bucket and bucket access key `name` (`shop.catalog`, `shop.auth.api`). There is one form of a node's name, and it is the address. Names are labels, never identity. Upstream adds `-` and a 12-character token to every Connection name, so a Connection's platform name is the address plus that suffix (`shop.catalog-<token>`). On the upgrade deploy every one of these names changes from the short address to the full one. App, Database and Bucket names update in place; a Bucket's display name is not its S3 bucket name, so its objects stay where they are. Upstream replaces a Connection when its `name` changes, and a bucket access key when its `name` changes. So the upgrade recreates each of Composer's Connections and access keys with new credentials, and Composer's services receive the new credentials in the same deploy. The replace deletes only the old Connection or key, by the id Composer stored, so the database, the bucket and its objects, and any Connection or key made by hand are untouched. A hosted database takes no name from Composer, because upstream refuses a name together with branch attachment: upstream derives its physical name from the resource ID, and updates it in place when the ID changes.

An environment variable row is replaced whenever its key changes, and every key changes in this migration. That is harmless: Composer writes every row's value on every deploy, so the new row holds the same value as the old one, and a changed environment already makes a new Deployment.

During the move a new key can equal a key the previous release wrote for a different row, because every key is upper-cased and `-` becomes `_`. That happens when a module or service directly below the root has the app's name in any letter case (in the app `shop`, `shop.x` gets `COMPOSER_SHOP_X_…`, the old key of `shop.shop.x` or of the service `shop.shop`'s input `x`), or when modules spell an app name that contains `-` or `_` (`my-shop.x` and `my-shop.my.shop.x`). The old row still holds that key while the deploy runs, so creating the new row would fail partway. Deploy preflight therefore computes every row's new and old key from the graph, and while the old owner's row still holds a clashing key on the stage and has not moved to its new key, it fails before changing anything. The error names the variable, the node that owns it under the old format and the node that takes it over, and the fix: delete that one variable (`prisma project env delete <KEY> --project <id> --role production`, or `--branch <stage>`, or in the Console), then deploy again. Nothing is lost, because the deploy writes every value under its new key and running deployments keep their own copy. A new stage, or one that has moved, never fails this check.

Local dev creates no platform rows. Its per-directory record of which emulator instance backs each node (ADR-0052) is keyed by address, and the local providers find each node's instance by its main resource ID, which is that address. The record now carries a format version. A record without it was written before this decision: on the first `prisma dev` after upgrading, Composer puts the app name in front of every one of its keys and writes the record back with the version, so local services, databases and buckets keep their instances, ports and data. A bucket's objects stay in the folder named by its address without the app name, which is already inside the app's own folder, so nothing moves. Alchemy's local deploy state goes through the same rename declarations as the hosted state.

## Consequences

- Changing a node's address gives it a new identity, and the platform and the deploy see a different entity. Changing a node's `name` (when `provision()` sets no `id`), changing its provision ID, moving it into another module, or deploying under a different app name all do this. None of these is a rename: the rename declarations cover only the move from the old format, not a change the author makes. Below the root, the deploy deletes the old entity's rows; for a database or a bucket, that deletes its data. For the root, the new name resolves to a different Project, and the old Project is left in place.
- Changing a display name never changes identity.
- The address format is an identity contract. The platform treats `logicalId` as an opaque string and never parses it, so Composer may change how addresses are composed, but any change re-identifies every existing entity unless it ships with rename declarations, as this one does.
- Every node kind that lowers to a platform row must pass the node's address as that row's `logicalId`, and build its resource IDs from the address. A new node kind isn't done until it does. An upgrade that gives a resource a `logicalId` prop must pass the address in the same change, or the default writes the Alchemy resource ID.
- Changing any Alchemy resource ID must go through a rename declaration. Otherwise a single deploy could use the existing row under the new ID and delete it under the old one.
- The rename declarations from the old format stay in the code. They do nothing on stages that have migrated or were created after this decision.
- A stage migrated by this decision and then deployed by an older Composer has its resources deleted and recreated under the old IDs, losing their data. Nothing protects against this.
- Each platform name is checked against that kind's limit: a Connection name at most 52 characters (the platform allows 65, and upstream's suffix takes 13, so the address is never cut), a Bucket name 100, an App name 256; an access key name has none. A long app name counts against every one of them. A name over its limit fails the deploy with a message naming the node's address; Composer never shortens a name. Fixing it means changing the address, which makes the node a different entity.
- Anything outside Composer that used the old Connection string or access key of a Composer resource stops working after the upgrade, because those credentials are deleted.
- An app whose move gives one row's new `COMPOSER_` key to another row's old key stops at deploy preflight, before any change, until that one old variable is deleted. Renaming a node instead would give it a new identity and delete its rows.
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
- **Keep the address without the app name as the platform name of Apps, Connections, Buckets and access keys**, to avoid recreating Connections and access keys on the upgrade. That is a second form of a node's name.
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

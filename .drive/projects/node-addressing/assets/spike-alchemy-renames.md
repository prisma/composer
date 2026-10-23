# Spike: Alchemy renames for dotted resource IDs

Run 2026-10-23 against the real platform with `alchemy@2.0.0-beta.83`, `Prisma.providers()`, and Composer's hosted state layer (`prismaStateLayer` from `@internal/lowering/state`). Throwaway Project `spike-renames-891e50` (`proj_q02oduck65rs8yeu5n3s0iq0`), now deleted. Scripts and logs: `wip/spike-alchemy-renames/`.

## The API to use

```ts
import { renamedFrom } from 'alchemy/Rename';

const db = yield* Prisma.Database('shop.catalog', { ...props, logicalId: 'shop.catalog' })
  .pipe(asOwnRow, renamedFrom('catalog-db'));
const conn = yield* Prisma.Connection('shop.catalog.conn', { database: db, name: 'catalog' })
  .pipe(renamedFrom('catalog-conn'));
```

`renamedFrom(...formerIds)` takes one or more former IDs, most recent first. A bare string resolves against the current namespace; `{ fqn }` is an absolute state key. Composer uses no namespaces, so bare strings are right. Swapping two IDs in one deploy fails the plan. A filtered (selected-resource) deploy refuses to migrate a rename.

## 1. A rename keeps the resource: yes

Deployed `catalog-db`, `catalog-conn`, `api-svc`, wrote a row, then redeployed as `shop.catalog`, `shop.catalog.conn`, `shop.api` with renames. Plan output: `[shop.catalog] update (renamed from catalog-db)`, and the same for the other two. Nothing was created or deleted.

- Database `db_cexzg9ehp6t6n473g7e3j4kd` and Connection `con_zvnfetb9svadtlskzhdt1on4` kept their ids before and after. App `cps_k3dz06azn3ik2sg0asgzxf6i` kept its id too.
- `select * from spike` still returned `1 | written before rename`.
- The hosted state rows moved to the new keys and kept the same `instanceId`.

Caveat: Composer passes no `name` on platform deploys, so the database display name comes from the resource ID. It changed from `spike-catalog-db-q1-oawhghear3vmnftc` to `spike-shop-catalog-q1-oawhghear3vmnftc`. This is an in-place update. A Connection is **replaced** if its `name` prop changes, so keep passing the same `name` (`catalog`, not `shop.catalog`).

## 2. Rename declarations on a fresh Branch: yes, it deploys cleanly

Empty state, new IDs, renames declared: `Plan: 3 to create`, `Done: 3 succeeded`. A rename that matches no state row is ignored. Leftover declarations are also harmless on later deploys: an unchanged redeploy planned `no changes`.

## 3. Partial failure, then rerun: clean

- **Failing resource:** I ran five renames plus a new Database with an invalid region. The broken create failed. The other five updates still finished, and the run reported `Failed: 5 succeeded, 1 failed`. After I removed the bad resource, the rerun planned five `noop`s and one `delete` (the failed row). All ids stayed the same.
- **Hard kill:** I sent `kill -9` to the process at its first `updating` line. By then all five rows had already moved to the new keys, and the old rows were gone. Three were left with status `updating`. The rerun did five in-place updates, and all ids stayed the same (`db_bqaaomu7…`, `db_l9exb214…`, `con_wmv1szgv…`, `con_kisu3u33…`, `cps_lb0bg1uz…`).
- **Not hit live:** the moment when both the old and new rows exist. Upstream writes the new row before it deletes the old one, and treats two rows with the same `instanceId` as an unfinished migration.
- **Surprise:** after the kill, the dead process's deploy lease blocked every state call for about 60 seconds, until its time limit ran out. A user who retries at once will get the lease-held error.

## 4. Dotted IDs in hosted state: yes

`shop.catalog.conn` was created (by migration and by fresh create), read back on the next deploy as a no-op, and fetched directly over HTTP. A `destroy` on the fresh Branch deleted all three rows (state list `[]`) and their platform resources. The HTTP store runs keys through `encodeURIComponent`, which leaves dots as they are, and the API handled them fine.

## 5. Changing only `logicalId` updates in place: yes

Changing `logicalId` from `catalog` to `shop.catalog` (and from `api` to `shop.api`) planned `update`. Database `db_cexzg9ehp6t6n473g7e3j4kd` and App `cps_k3dz06azn3ik2sg0asgzxf6i` kept their ids. The platform showed the new `logicalId`, and the row was still there. The Connection also showed `update` because its database's output changed, but it kept its id.

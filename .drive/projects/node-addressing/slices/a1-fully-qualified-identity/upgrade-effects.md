# Upgrade effects: every resource Composer declares

What the first deploy from this branch does to a stage the last release deployed. Example app `shop`, database `shop.catalog`, service `shop.api`, bucket `shop.files`.

Every resource declares `renamedFrom(<old ID>)` (`legacy-resource-ids.ts`), so Alchemy moves its state entry to the new ID before diffing. Then the upstream diff decides between update in place and replace. A replace is create-first by default (`node_modules/alchemy/src/Apply.ts`, "By default a replacement is create-first"; no Composer resource sets `deleteFirst`). The old generation is deleted after the new one exists.

Upstream sources below are under `node_modules/alchemy/src/Prisma/`. Composer's own resources are under `packages/1-prisma-cloud/1-extensions/target/src/` and `packages/1-prisma-cloud/0-lowering/lowering/src/`.

## Platform deploy

| Resource | What the upgrade changes | Update or replace | What a replace deletes |
|---|---|---|---|
| App (`shop.api`, was `api-svc`) | ID; `logicalId` `api` → `shop.api`; `displayName` `api` → `shop.api` | Update. `App.ts` diff replaces only when the project changes; a `logicalId` or `displayName` change is `update`. | Nothing. The App keeps its id, so its custom domains (`CustomDomain.ts` binds to `appId`) and endpoint stay. |
| Deployment (`shop.api.deployment`, was `api-deploy`) | ID; its env rows' keys change, so its triggers change | Replace (`Deployment.ts` diff: `triggersChanged` → `replace`), as on any config change today | The old Deployment of that App only (`delete` checks it belongs to `output.appId`). Not the App or its domains. |
| EnvironmentVariable, `COMPOSER_` config, input and generated-value rows | ID; key `COMPOSER_API_…` → `COMPOSER_SHOP_API_…` | Replace (`EnvironmentVariable.ts` diff: key change → `replace`) | The old row only. `delete` fetches the row by the stored `environmentVariableId`, checks project, branch, class and key equal the stored ones (`ensureVariableIdentity`), and skips system-managed rows. A hand-set variable is never in Composer's state, so it cannot be deleted. Values: config is recomputed; generated values come from the `GeneratedParam` state, which is renamed and not regenerated. |
| Database (`shop.catalog`, was `catalog-db`) | ID; `logicalId` `catalog` → `shop.catalog`. A Branch-attached database is given no `name` (`stageDatabase`), so its physical name is generated from the ID and changes | Update. `Database.ts` diff replaces only on project, region, default flag or source change; `logicalId` and name changes are `update`. Spike confirmed data kept. | Nothing is deleted. The default connection is rotated only under one condition, below. |
| Connection (`shop.catalog.connection`, was `catalog-conn`) | ID; `name` `catalog` → `shop.catalog` | **Replace** (`Connection.ts` diff: `nameChanged` → `replace`) | The old Connection only. `delete` loads it by the stored `connectionId`, refuses if its database or name differ from the stored ones, then deletes that one id. The database and any hand-made Connection on it are untouched. The new Connection's credentials reach every consuming service in the same deploy through its env rows. |
| PgWarm (`shop.catalog.warmup`, was `catalog-warm`) | ID; its `url` input is the new Connection's | Update (Composer's `pg-warm-resource.ts`: no diff; `delete` is a no-op) | Nothing. |
| OrmMigration (`shop.catalog.migration`, was `catalog-migrate`) | ID | Update (`orm-migration-resource.ts`: `delete` is a no-op). Migrations already applied are recorded in the database, not the state. | Nothing. |
| Bucket (`shop.files`, was `files-bucket`) | ID; `logicalId` and `name` → `shop.files` | Update (`Bucket.ts` diff: name and `logicalId` changes are `update`). The display name is a label; the provider-side S3 bucket name and objects stay (`Bucket.ts` doc, lines 93–95). | Nothing. |
| BucketAccessKey (`shop.files.accesskey`, was `files-key`) | ID; `name` → `shop.files` | **Replace** (`BucketAccessKey.ts` diff: name change → `replace`) | The old key only: `deleteBucketKey({ bucketId, keyId })` with the stored ids. The bucket, its objects and any hand-made key stay. Consumers get the new key in the same deploy. |
| S3Credentials (`<address>`, was `<below>-creds`) | ID | Update (`s3-credentials-resource.ts`: returns the stored pair; `delete` is a no-op) | Nothing. |
| GeneratedParam (`shop.api.generated.<path>`) | ID | Update (`generated-param-resource.ts`: returns the stored value; `delete` is a no-op) | Nothing. The value is kept. |
| ServiceKey, RPC (`<consumer>.servicekey.<input>`) and streams (`<provider>.streamkey`) | ID | Update (`lowering/src/compute/ServiceKey.ts`: value kept in state) | Nothing. Keys are kept. |
| Project, Branch | Nothing new from this slice | Not changed | Nothing. |

## Local dev

The local-target providers (`packages/1-prisma-cloud/0-lowering/local-target/src/`) key each instance by resource ID through the per-directory record, which is rewritten on the first `prisma dev` (`legacy-address-keys.ts`). Their Database, Connection, Bucket and BucketAccessKey providers have no diff that replaces, and their `delete` is a no-op, so a changed `name` deletes nothing. The bucket data folder keeps its old name.


## When a Database update rotates its default connection

Every upgrade updates every Database, because its `logicalId` and derived name change. At the end of an update, upstream calls `recoverDatabaseConnectionSecrets` (`Database.ts` lines 916–933; it runs whenever `olds` is set, which it is on every update). That function rotates the database's default connection (`createConnectionRotate`, `Internal/DatabaseSecrets.ts` lines 105–165) only when it has no connection string: neither the deploy state's stored attributes (`directConnectionString`, `pooledConnectionString`, `accelerateConnectionString`, used when the stored `databaseId` matches) nor the database read from the API, which never returns them. The default connection is not in the Composer graph.

A stage last deployed by v0.34.0 cannot hit this. v0.34.0 pins the same upstream version (`alchemy@2.0.0-beta.83`), whose Database stores the connection strings in its attributes on create, and again on every update. The only Database state without them is a row rewritten from a pre-upstream release (`lowering/src/state/legacy-resources.ts` leaves them out). Such a row has no `logicalId` either, so the first deploy with any release that writes `logicalId` (the first was v0.29.1-dev.5) updated it, rotated the default connection then, and stored the strings. That one-time rotation is documented in the "Upgrading to the upstream Prisma resources" section of `docs/guides/deploying.md`. So this upgrade rotates a default connection only for a stage last deployed by a release older than that, which is not an upgrade from the last release.

## Verdict

No step deletes application data, and no Connection outside the graph is rotated for a stage last deployed by v0.34.0. No database is dropped. No bucket or object is deleted. No App is replaced, so no custom domain is removed. Only Composer's own Connections, access keys, Deployments and `COMPOSER_` rows are replaced. Each replace deletes one platform object, by the id Composer stored, after checking that its identity still matches.

## Findings outside the data question

1. **The move can give one row's new env key to another row's old key.** It happens with a module or a service directly below the root named like the app in any letter case (`shop.x` and `shop.shop.x`), or modules that spell an app name with `-` or `_` (`my-shop.x` and `my-shop.my.shop.x`). Without a check, the replacement create hits `Conflict` in `EnvironmentVariable.ts` partway through the deploy and deletes nothing. Deploy preflight (`target/src/env-key-clash.ts`, called from `runPreflight`) now finds every such key from the graph and, while the old owner's row still holds it on the stage and has not moved to its new key, fails before any change. The fix it gives loses nothing: delete that one variable with `prisma project env delete`, then deploy again.
2. **Upstream shortens Connection names.** The platform name of a Connection is `physicalInstanceName(name, instanceId)` (`Internal/EnvName.ts`): the name cut to 52 characters, then `-` and a 12-character token. So the Connection's platform name is `shop.catalog-<token>`, not exactly the address, and upstream never sends more than 65 characters. Composer therefore limits a Connection's address to 52 characters, so the address is never cut.
3. **A Branch-attached database has no Composer name.** Upstream refuses an explicit name together with branch attachment at create, so its platform name is generated from the resource ID. Only the local dev Database takes the address as `name`.

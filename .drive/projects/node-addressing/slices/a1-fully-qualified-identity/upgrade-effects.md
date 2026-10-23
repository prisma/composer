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
| Database (`shop.catalog`, was `catalog-db`) | ID; `logicalId` `catalog` → `shop.catalog`. A Branch-attached database is given no `name` (`stageDatabase`), so its physical name is generated from the ID and changes | Update. `Database.ts` diff replaces only on project, region, default flag or source change; `logicalId` and name changes are `update`. Spike confirmed data kept. | Nothing. |
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

## Verdict

No step deletes application data. No database is dropped. No bucket or object is deleted. No App is replaced, so no custom domain is removed. Only Composer's own Connections, access keys, Deployments and `COMPOSER_` rows are replaced. Each replace deletes one platform object, by the id Composer stored, after checking that its identity still matches.

## Findings outside the data question

1. **A child module named like the app collides on env keys during the upgrade.** In the app `shop`, node `shop.x` gets the new key `COMPOSER_SHOP_X_P`. That is the old key of node `shop.shop.x`, whose row still exists while the deploy runs. The replacement create is not an adoption (`Apply.ts` passes `olds: undefined` and no `output`), so `EnvironmentVariable.ts` reconcile hits `Conflict` and fails: "appeared after the adoption check. Refusing to overwrite its secret". The failure is loud and deletes nothing. A rerun might not clear it. It affects only apps with a module whose id equals the app name.
2. **Upstream shortens Connection names.** The platform name of a Connection is `physicalInstanceName(name, instanceId)` (`Internal/EnvName.ts`): the name cut to 52 characters, then `-` and a 12-character token. So the Connection's platform name is `shop.catalog-<token>`, not exactly the address, and upstream never sends more than 65 characters. Composer's 65-character Connection check can only fail if upstream stops shortening.
3. **A Branch-attached database has no Composer name.** Upstream refuses an explicit name together with branch attachment at create, so its platform name is generated from the resource ID. Only the local dev Database takes the address as `name`.

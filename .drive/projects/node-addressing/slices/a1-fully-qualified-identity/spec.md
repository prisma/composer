# A1 — Fully qualified node identity, with automatic migration

## At a glance

```ts
export default module('shop', ({ provision }) => {
  const catalog = provision(postgres({ name: 'catalog', ... }));
  provision(api, { id: 'api', deps: { db: catalog }, params: { origin: serviceOrigin('shop.api') } });
});
```

| | Today | After |
| --- | --- | --- |
| addresses | `shop`, `catalog`, `api` | `shop`, `shop.catalog`, `shop.api` |
| row `logicalId` | `catalog` | `shop.catalog` |
| Alchemy resource IDs | `catalog-db`, `catalog-conn`, `api-svc`, `api-deploy` | `shop.catalog`, `shop.catalog.connection`, `shop.api`, `shop.api.deployment` |
| env keys | `COMPOSER_API_...` | `COMPOSER_SHOP_API_...` (`-` in the app name becomes `_`) |

The first deploy of an existing app with this change renames every resource in place. No database, bucket, generated secret or RPC key is recreated.

## Chosen design

From [design-notes.md](../../design-notes.md), decisions 1 to 5. Grounded in the code at `origin/main` 70fcd82c:

- **Addresses.** Load (`packages/0-framework/1-core/core/src/load-module.ts`, around lines 528, 774, 813) prefixes every child address with the root's ID. The root's ID is the deployed app name everywhere. Today the CLI pipeline graph uses the authored name while the deploy lowering uses `--name` (`core/src/control/deploy.ts:578`); both must use the deployed name, so the topology's root `logicalId` matches the Project's.
- **Resource IDs.** Every descriptor builds its main resource's ID from the address and each other piece's ID as `<address>.<role>` (compute: `descriptors/compute.ts`; postgres: `descriptors/shared.ts`, `orm-postgres.ts`, `raw-postgres.ts`; bucket: `descriptors/bucket.ts`, `s3-credentials.ts`; environment variable rows; generated values; service keys and stream keys in `control/extension.ts`). Every resource is piped through `renamedFrom(<today's ID>)` from `alchemy/Rename`. Today's ID is computed from the address with the first segment removed, exactly as today's code builds it.
- **Values that must survive.** Generated values (`GeneratedParam`), RPC service keys and stream keys must be renamed, not recreated, so their values do not change.
- **Every platform name is the full address.** The App display name, the local Database name, and the Connection, Bucket and access key names are the full address, on new stages and on the upgrade. The upgrade recreates each Connection and access key with new credentials; this is accepted (design note 5).
- **`logicalId`.** `logicalIdProp` writes the full address; the topology builder (`lowering/src/builds/application-topology.ts`) writes full addresses for every node and parent.
- **Env keys.** `configKey` and its local copies (`target/src/serializer.ts`, `local-target/src/compute.ts`) build keys from the full address with `-` replaced by `_`.
- **User-facing addresses.** `serviceOrigin`, `dev url`, deploy reports, log labels and error messages use the full address.
- **Local dev.** On the first `prisma dev` after upgrading, the per-directory record (`emulator-instances.json`) is rewritten to full-address keys, and anything else keyed by address (bucket data directories, local database lookup names) is moved or mapped, so local data and ports survive.
- **Design records and docs, in this PR.** A new decision record replaces the node-identity decision (the index marks it replaced). Update the principle "A node's address is its identity, everywhere", the glossary entry "Address and logical ID", and the address and resource-ID descriptions in `10-domains/core-model.md`, `10-domains/deploy-cli.md`, `05-prisma-cloud/alchemy-lowering.md` and `05-prisma-cloud/pdp-data-model.md`. Update guides, the agent skill, examples and READMEs that write addresses (for example `serviceOrigin('api')` in `examples/auth/module.ts` and the auth module README).

## Coherence rationale

One concept, the form of a node's identity, applied to every place it is written. Splitting it would ship a release where some strings are in the new form and some in the old, and existing apps would migrate twice. The diff is wide but uniform; a reviewer checks one rule against each call site, plus the migration.

## Scope

**In:** everything above.

**Out:** platform commands that accept addresses (B1), `deploy list` (A2), the entry in the config (A3), any protection against an older Composer deploying after migration.

## Pre-investigated edge cases

- The Alchemy rename spike ([assets/spike-alchemy-renames.md](../../assets/spike-alchemy-renames.md)) verified Database, Connection and App renames, renames on a new stage, partial-failure reruns and dotted IDs in hosted state. It did **not** cover buckets, bucket keys, environment variable rows, generated values or service keys. QA must.
- After a killed deploy, the dead process holds the deploy lease for about 60 seconds.
- `validateName` caps every name at 65 characters, but the platform's limits differ by kind: Connection 65, Bucket 100, App and Project 256, access key none. Validation uses the real limit per kind and fails with a clear message naming the address; it never shortens.
- Root names may contain `-` and `_`; child provision IDs are letters and digits only.

## Slice-specific done conditions

- **Critical (Will, 2026-10-23): upgrading from the last Composer release to this one loses no application data.** No database is dropped, no bucket or object deleted, no custom domain removed, and no platform state that the Composer graph does not represent is touched. QA plants such state before the upgrade (a custom domain on a service, an environment variable set by hand, an extra Connection made by hand on the database) and shows it is unchanged after. Only Composer's own Connections and access keys are recreated, with new credentials (design note 5).

- A fabricated app with a database holding rows, a bucket holding objects, a generated secret, an RPC edge and a `serviceOrigin`, deployed with the current release, then redeployed from this branch: rows, objects, the secret's value and the RPC key are unchanged; rows carry full-address `logicalId`s; the deploy state has the new resource IDs and none of the old.
- The same app deploys from scratch to a new stage from this branch.
- `prisma dev` on a directory last run with the current release keeps its local database's data.

## Open questions

None.

## References

- [Project spec](../../spec.md), [design notes](../../design-notes.md), [spike findings](../../assets/spike-alchemy-renames.md)

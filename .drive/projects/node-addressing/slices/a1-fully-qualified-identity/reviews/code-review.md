# Code review — A1, fully qualified node identity

Branch `drive/fully-qualified-node-addresses`, range `origin/main...HEAD` (16 commits, 102 files). Reviewed against the slice [spec](../spec.md) and [plan](../plan.md), the project [spec](../../../spec.md), [design notes](../../../design-notes.md), the [spike findings](../../../assets/spike-alchemy-renames.md) and ADR-0057.

## Summary

The migration is built correctly for every app whose name is made of letters, digits, `-` and `_`. I checked every Alchemy resource Composer declares against the code at `origin/main`. For each one, the declared former ID is exactly the ID `origin/main` builds, and every prop that would make upstream Alchemy replace the resource keeps its old value. The one exception is environment variable rows. Their key changes, so upstream replaces them, but their values are rebuilt from sources that are themselves renamed, so no value changes. The unit tests assert each new ID and each former ID as literal strings, so they would catch a drift.

The main risk is in what the code assumes about the app name. Nothing checks the root module's name or `--name`. ADR-0057 and the glossary say the app name may contain `-` and `_`, but no code enforces that. If an existing app's name contains a `.`, the first deploy computes the wrong former IDs. It then creates new, empty databases and buckets and deletes the old ones with their data (F01). If the name contains a space or another character that is not allowed in an environment variable name, every `COMPOSER_` key becomes invalid (F02). Both need a name check that runs before anything is deployed.

The other findings are smaller. Local dev guesses which record keys are old, and that guess can be wrong (F03). A service's full address now counts toward the 65-character name limit, which can block an app from upgrading at all (F04). Two documents say a failing `serviceOrigin` changes nothing, but the topology has already been replaced by then (F05). The real-platform done conditions are still NOT VERIFIED until QA runs.

## What looks solid

- **Every former ID matches `origin/main`.** At `origin/main`, Load gave the root's direct children bare addresses, so `id === address` in every lowering context and the old address is the new address minus its first segment. `legacyAddress` computes exactly that. I compared each declaration with the code at `origin/main`:
  - App `${id}-svc`, Deployment `${id}-deploy`, Database `${id}-db`, Connection `${id}-conn`, PgWarm `${id}-warm`, OrmMigration `${id}-migrate`, Bucket `${id}-bucket`, BucketAccessKey `${id}-key`, S3Credentials `${id}-creds` all go through `legacyNodeResourceId`, which builds the same strings.
  - Environment rows: `${configKey(address, d)}-var`, `${inputRow.key}-var`, `${leaf.varName}-var`, and the provider-param `${configKey(address, {owner:'service', name})}-var` are rebuilt through the same serializer functions, applied to the old address. The `-` to `_` change cannot alter an old key, because old addresses never contained the app name.
  - GeneratedParam `${inputKey(address)}:${path}-generated`, ServiceKey `servicekey-${edgeId}` with `edgeId = ${edge.to}.${edge.input}`, and streams key `streamskey-${providerAddress}` all match.
- **Props that would force a replacement keep their old values.** I checked each resource's `diff` in `node_modules/alchemy/src/Prisma` (beta.83).
  - The Connection `name` and the BucketAccessKey `name` force a replacement. Both stay the old label (`resourceLabel` equals the old `id`), and so does the Bucket `name`.
  - The hosted Database passes no `name`, because it is attached to a branch. Its physical name is derived from the resource ID, so it changes, but that is an update in place, as the spike saw.
  - The App's `displayName` and every resource's `logicalId` are updated in place.
  - Project, region, branch, role and bucket IDs are unchanged.
- **Generated values and keys survive a rename.** `ServiceKey`, `GeneratedParam` and `S3Credentials` all return their stored output from `reconcile` (`output ?? mint…`). Moving the state row therefore keeps the value.
- **Environment rows are replaced, and that is harmless.** Upstream replaces a row whose `key` changes. Each row's value comes from a renamed source (a generated value, a service key, an endpoint) or from config. ADR-0057 states this outright, and the upgrade guide tells users about it.
- **The `--name` mismatch is fixed.** `runPipeline` now resolves the name before Load and passes it as the root ID (`packages/0-framework/3-tooling/cli/src/pipeline.ts` lines 128–137). The child lowering already did the same (`core/src/control/deploy.ts` line 578). The topology the reporter submits and the lowering therefore share one root `logicalId`, the same name the Project uses.
- **What deploy writes and what boot reads stay in step.** The boot address comes from `compute.bootstrap.json`, which is written from the same graph address. Deploy and boot both build keys with `configKey`/`addressKeySegments`, and the local `servicePortEnvKey`/`ownEnvKeyPrefix` copies apply the same `-` to `_` rule.
- **Local dev record and bucket folders.** The local record keeps its old instances: `normalized()` rewrites the keys on read. The bucket folder stays `buckets/<app>/<address without app>`, the same path as before. The local providers now look instances up by resource ID, which equals the address. A test with real emulators starts from a record in the old format and asserts that the ids, ports and bucket objects are kept, and that a second run changes nothing.
- **Tests are literal and complete.** `control-lowering.test.ts` (lines 2897–3205) asserts both the new ID and the former ID as literal strings for every node kind. An `afterAll` check fails if any declared resource lacks exactly one former ID. I ran `resource-ids`, `control-lowering` and `serializer`: 103 pass.
- **The deploy report** strips the app segment once, using `opts.name`, which is the same name used for the root.

## Findings

### F01 — An app name containing `.` makes the first deploy delete every database and bucket

- **Location:** `packages/1-prisma-cloud/1-extensions/target/src/legacy-resource-ids.ts` lines 11–14; `packages/1-prisma-cloud/1-extensions/target/src/service-app.ts` lines 12–14; `packages/0-framework/1-core/core/src/load-module.ts` lines 770–771; `packages/0-framework/3-tooling/cli/src/pipeline.ts` lines 128–137; `packages/0-framework/1-core/core/src/node.ts` lines 474–478 (`requireName` checks only that the name is not empty).
- **Issue:** `legacyAddress` and `resourceLabel` drop everything up to the first `.`, which assumes the app name contains no dot. Nothing enforces that. The root module's name and `--name` only have to be non-empty, while ADR-0057 and the glossary say the app name "may contain `-` and `_`". Take an existing app `acme.shop` with a database `db`:
  - `origin/main` stored the database as `db-db`.
  - This branch declares `acme.shop.db` with former ID `shop.db-db`, which matches no state row, so Alchemy ignores the rename.
  - Adopting by `logicalId` (`acme.shop.db`) finds nothing either, because the row still holds `db`.
  - Alchemy creates an empty database and deletes `db-db` with its data. The same happens to buckets, generated secrets and service keys. The Connection `name` also changes.

  The address itself is ambiguous too: `buildTree` in the deploy report and the local `bucketDataDir` both split on `.`.
- **Suggestion:** Check the root name in one place, before Load returns, in both the CLI pipeline and `lowering()`. Enforce the grammar the ADR states (`[A-Za-z0-9_-]+`) and fail with a message that names the name and the rule. Then also compute the former address by removing the known `${appName}.` prefix, not by cutting at the first dot. That way the migration does not depend on an assumption made elsewhere. Add a test with an app name containing `.` that expects the clear error.

### F02 — App names with characters not allowed in environment variable names now produce invalid `COMPOSER_` keys

- **Location:** `packages/1-prisma-cloud/1-extensions/target/src/serializer.ts` lines 76–80; `packages/1-prisma-cloud/0-lowering/local-target/src/compute.ts` lines 79–94.
- **Issue:** Before this branch, the app name never appeared in an environment variable key. Now every key starts with it, and only `-` is mapped to `_`. An existing app named `My Shop`, `acme/shop` or `@acme/shop` would write keys such as `COMPOSER_MY SHOP_API_PORT`. The platform will probably reject these while applying, after the database and app renames have already happened. The stage is then stuck until the user renames the app, which gives it a new identity and a new Project. Local dev would set keys a shell cannot even name.
- **Suggestion:** The same check as F01, run before anything is deployed, fixes this. The grammar must make every key valid. If names with other characters already exist in the wild, decide explicitly whether to map them or refuse them. Do not let them fail halfway through a deploy.

### F03 — Local dev guesses which record keys are old, and the guess can drop a node's instance

- **Location:** `packages/1-prisma-cloud/0-lowering/local-target/src/legacy-address-keys.ts` lines 10–28.
- **Issue:** A key is treated as already full if it equals the app name or starts with `<app>.`. Old keys can look like that:
  - An app `shop` that provisions a module with id `shop` had the old key `shop.db`. That key is kept as is, so the real address `shop.shop.db` matches nothing.
  - An app `auth` that provisions a node with id `auth` had the old key `auth`. That key is kept as the app's own key.

  In both cases `prisma dev` creates a fresh, empty local database or bucket. It also leaves the old instance, and its port, unreachable until `--fresh` is run. The rewrite also runs on every read for as long as the code exists, so the guess never stops being made.
- **Suggestion:** Write a format marker into the record, for example `"addresses": "full"`, the first time it is rewritten. Only rewrite records that lack the marker, and in those records add the app name to every key, without guessing. Add a test for an app that provisions a child whose id equals the app name.

### F04 — The full address now counts toward a service's 65-character name limit, which can stop an existing app from upgrading

- **Location:** `packages/1-prisma-cloud/1-extensions/target/src/descriptors/compute.ts` line 165; `packages/1-prisma-cloud/1-extensions/target/src/descriptors/shared.ts` lines 103–115.
- **Issue:** `validateName` used to check the short address. It now checks `<app>.<path>`. An app whose service addresses were close to the limit fails on its first deploy with this version. The error message suggests shortening provision IDs or the app name, but both change the service's identity: a new App, a new URL and a new Project for the root. The name being checked is only used as the App's `displayName`, which ADR-0057 calls a label. The check runs while the plan is built, so no data is lost, but the user cannot upgrade without re-identifying the service.
- **Suggestion:** Decide this on purpose and record the decision. Either keep validating, and therefore keep the display name, on the old label (the address without the app name), which upstream accepts, or keep the current rule and say in the upgrade guide that long names block the upgrade. Also make the error name the full address and the length, as the spec's edge case requires. For databases and buckets the message shows the label, not the address.

### F05 — The documents say a bad `serviceOrigin` fails "before anything changes", but the topology has already been replaced

- **Location:** `docs/guides/deploying.md` lines 467–470; `docs/design/90-decisions/ADR-0057-a-nodes-address-is-its-full-path-from-the-app-name.md` line 92; `packages/1-prisma-cloud/0-lowering/lowering/src/builds/reporter.ts` lines 227–260.
- **Issue:** The reporter's `attach` step replaces the Branch's application topology before Alchemy runs. When an existing app still has `serviceOrigin('api')`, the deploy fails during planning, but the topology on the Branch already lists full addresses while the rows still hold the short `logicalId`s. Console's join between topology nodes and rows then finds nothing until the next successful deploy. No data is at risk.
- **Suggestion:** Make the two documents accurate ("before any resource is created"). Better, make `serviceOrigin` targets fail at Load or preflight, before `attach`. The graph already holds every address, so the check needs nothing from the platform.

### F06 — Two helpers with the same meaning behave differently

- **Location:** `packages/1-prisma-cloud/1-extensions/target/src/legacy-resource-ids.ts` lines 11–14; `packages/1-prisma-cloud/1-extensions/target/src/service-app.ts` lines 12–14.
- **Issue:** `legacyAddress` and `resourceLabel` both mean "the address without the app name". For an input with no dot they disagree: one returns `''`, the other returns the input unchanged. Both feed values the migration depends on (the former IDs and the Connection and access-key names), so if one is changed later the two can drift apart.
- **Suggestion:** Keep one function and build the other from it. With F01's fix, both should take the app name as a parameter and remove `${app}.`.

### F07 — The local providers and the emulators hook now agree on a key only because the main resource ID equals the address

- **Location:** `packages/1-prisma-cloud/0-lowering/local-target/src/postgres.ts` line 48; `packages/1-prisma-cloud/0-lowering/local-target/src/bucket.ts` line 65; `packages/1-prisma-cloud/1-extensions/target/src/local-target/emulators.ts` lines 52–60.
- **Issue:** Before, both sides took the key from one helper (`resourceName`). Now the hook keys a node by `n.id` and the provider by Alchemy's `id`. They match only while `resourceId(address)` returns the address unchanged. If that rule changes, local dev would quietly create new, empty instances.
- **Suggestion:** Have the hook call `resourceId(n.id)`, so both sides go through the same function. Alternatively, add a test that runs a database through both the emulators hook and the local provider.

### F08 — Old local instances keep their short address label

- **Location:** `packages/1-prisma-cloud/0-lowering/local-target/src/emulator-instances.ts` around line 210; `packages/9-public/composer-cli/src/family/emulator-list.ts` lines 29 and 101.
- **Issue:** Instances created before the upgrade carry the label `composer.address: 'api'`, while new instances carry full addresses. `prisma emulator list` shows a mix of both forms. Only the display is affected.
- **Suggestion:** Show the record's key instead of the label, or say in the upgrade note that old instances show short addresses until `--fresh`.

### F09 — The upgrade guide's teardown rewrite is outside this slice and makes an unchecked claim

- **Location:** `docs/guides/deploying.md` lines 1–18 and 262–275.
- **Issue:** The guide now tells users to remove an app with `prisma project delete`, and says that this "removes every stage, its resources and its deploy state". Teardown is design decision 9, not part of A1. Nothing in this branch or in QA checks that deleting a Project deletes the hosted deploy state.
- **Suggestion:** Move this change to the teardown slice, or check the claim during QA and keep it.

## Deferred

- **`serviceOrigin` with `--name`.** One source file cannot write a `serviceOrigin` that works under both the authored name and a `--name` override. This was decided in design note 4 and in ADR-0057, so it is not reopened here.
- **An older Composer deploying a migrated stage** deletes and recreates its resources. Will accepted this in the design notes, and the slice spec puts it out of scope.
- **Rename declarations under a filtered deploy.** The spike found that a deploy limited to selected resources refuses to migrate a rename. I found no filtered deploy path in Composer today. Revisit this if one is added.
- **A state row that is in the oldest format and also needs a rename.** `lowering/src/state/legacy-resources.ts` rewrites row shapes when it reads them, and the rename then moves the row. The two should compose, but no test covers a row that needs both. This is low priority because rows that old should no longer exist.
- **Temporary duplicate environment rows.** During the upgrade deploy, each `COMPOSER_` variable exists twice, once under the old key and once under the new key, until the old rows are deleted. This only matters if a project is close to a limit on its number of variables.

## Acceptance criteria

The three slice-specific done conditions can only be shown on the real platform or on a real local directory. They are NOT VERIFIED until D6 runs. Below each one I list what QA must check.

| Criterion | Verdict | Evidence or what QA must check |
| --- | --- | --- |
| **Done:** an app deployed with the current release (a database with rows, a bucket with objects, a generated secret, an RPC edge, a `serviceOrigin`), then redeployed from this branch: rows, objects, the secret and the RPC key are unchanged; rows carry full `logicalId`s; the state holds only the new IDs | NOT VERIFIED | QA must check that the database, connection, bucket, access key and App platform IDs are unchanged. The connection string and the S3 access key must be the same strings before and after. The `COMPOSER_<APP>_<SVC>_<PATH>_GENERATED` value must equal the old `COMPOSER_<SVC>_<PATH>_GENERATED` value. The consumer's service key must equal the old one, and the provider's accepted-keys row must still contain it. The deploy state must list only dotted IDs, with no `-db`, `-var`, `servicekey-` or `-generated` left. No old `COMPOSER_<SVC>_…` variables may remain on the Branch. QA must also deliberately cover what the spike did not: buckets, access keys, environment rows (which are replaced), generated values and service keys. Use an app name containing `-`. |
| **Done:** the same app deploys from scratch to a new stage from this branch | NOT VERIFIED | QA must check that a deploy to a new `--stage` succeeds, that the rename declarations are ignored, and that a second deploy plans no changes. |
| **Done:** `prisma dev` on a directory last run with the current release keeps its local database's data | WEAK | `legacy-address-keys.test.ts` uses real emulators and an old-format record, and asserts that ids, ports and bucket objects are kept. It does not run the full `prisma dev` path with Alchemy's local state renames, and it does not check database rows. QA must run the current release's `prisma dev`, write rows and objects, upgrade, and run `prisma dev` again. |
| Addresses: Load prefixes every child with the root's ID, and the root's ID is the deployed name on both the CLI graph and the lowering | PASS | See `load-module.ts` line 526 and `pipeline.ts` line 137. `lowering()` passes `{ id: opts.name }`. F01 still applies to the name's grammar. |
| Resource IDs: `<address>` or `<address>.<role>`, each piped through `renamedFrom(<today's ID>)` | PASS (with F01) | Every declaration in `descriptors/*.ts` and `control/extension.ts` does this. The literal-string tests are in `control-lowering.test.ts` lines 2897–3205, and the `afterAll` check requires exactly one former ID per resource. |
| Generated values, RPC service keys and stream keys are renamed, not recreated | PASS (unit) / NOT VERIFIED (live) | The former IDs match `origin/main`, and the providers return their stored output. QA must confirm on the platform. |
| Connections keep their current `name` | PASS | `resourceLabel(address)` equals the old `id`, and tests assert `name: 'catalog'`. The BucketAccessKey and Bucket names are also kept. |
| `logicalId`: `logicalIdProp` and the topology builder write full addresses | PASS | Both use graph IDs, which are now full, and `application-topology.test.ts` asserts it. See F05 for when the topology is submitted. |
| Env keys: full address, with `-` replaced by `_`, in the serializer and its local copies | PASS (with F02) | `addressKeySegments` in both places, and the test with an app name containing `-` (`control-lowering.test.ts` line 2976). Characters other than `-` are not handled (F02). |
| User-facing addresses (`serviceOrigin`, `dev url`, reports, labels, errors) use the full address | PASS | The `serviceOrigin` error, the report tree and the docs all use it. F08 is a small gap in the emulator list. |
| Local dev: the record is rewritten, and bucket folders and database lookups follow | PASS (with F03) | `normalized()` calls `withFullAddressKeys`, `bucketDataDir` keeps the old path, and the providers key by ID. |
| Design records and docs updated in this PR (the new ADR, the index, the principle, the glossary, four domain docs, guides, skill, examples, READMEs) | PASS | All files are present. F05 is an accuracy problem in two of them, and F09 is a change outside this slice. |
| Edge case: `validateName` still applies, and fails with a clear message naming the address | WEAK | It still applies. For databases and buckets the message names the label, not the address, and F04 means the advice it gives would re-identify the service. |

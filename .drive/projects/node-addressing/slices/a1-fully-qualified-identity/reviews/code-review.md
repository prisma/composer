# Code review — A1, fully qualified node identity (round 2)

Branch `a1-full-platform-names` (pushed as `drive/fully-qualified-node-addresses`), range `origin/main...HEAD`, 33 commits, 109 files. Reviewed against the slice [spec](../spec.md), [plan](../plan.md) and [upgrade-effects.md](../upgrade-effects.md), the project [spec](../../../spec.md) and [design notes](../../../design-notes.md), the [spike findings](../../../assets/spike-alchemy-renames.md) and ADR-0057. Upstream source read in `node_modules/alchemy/src` (`alchemy@2.0.0-beta.83`, the same version v0.34.0 pins). Platform limits read in `wip/pdp-control-plane` (management-api routes and models).

Settled and not reopened: one form of identity, the full address, used for every platform name; the upgrade recreates Composer's own Connections and access keys; an older Composer deploying after the upgrade; `serviceOrigin` with the full address breaking `--name`; `--stage` keeps its name.

## Summary

I rebuilt every old resource ID from `git show v0.34.0:<path>`, not from the branch's helpers. Every declared former ID matches what v0.34.0 built, and the list of resources is complete. By reading the upstream code, no step of the upgrade deletes a database, a bucket, an object or a custom domain, and every replace deletes only the one object Composer stored, after checking its identity. So the critical condition holds by code reading. It is not yet shown on the platform, because QA has not run.

Two things need fixing before QA. First, the documented way out of the environment-variable key clash tells the user to rename a node, which deletes that node's rows, and for a module holding a database or bucket, its data (F01). Second, the QA plan does not plant the out-of-graph state the critical condition requires, and does not check the behaviours the spike never covered (F02). The rest are small accuracy fixes.

## What looks solid

- **Every former ID matches v0.34.0.** At v0.34.0 a node's lowering `id` equalled its address, which left out the app name (`core/src/control/deploy.ts` lines 673–675, 731; `load-module.ts` line 528). `addressBelowApp` removes the known `${app}.` prefix, so each former ID is v0.34.0's string:
  - App `${id}-svc`, Deployment `${id}-deploy`, Database `${id}-db`, Connection `${id}-conn`, PgWarm `${id}-warm`, OrmMigration `${id}-migrate`, Bucket `${id}-bucket`, BucketAccessKey `${id}-key`, S3Credentials `${id}-creds`.
  - Environment rows `${configKey(address, d)}-var`, `${inputRow.key}-var`, `${leaf.varName}-var` and the provider row `${configKey(address, {owner:'service', name})}-var`, rebuilt through the same serializer functions on the old address. The `-` to `_` change cannot alter an old key: old addresses never contained the app name, and child provision IDs were already letters and digits at v0.34.0.
  - GeneratedParam `${inputKey}:${path}-generated`, ServiceKey `servicekey-${edge.to}.${edge.input}`, streams key `streamskey-${edge.from}`.
- **The resource list is complete.** A grep of v0.34.0 for every resource constructor finds exactly the 17 call sites above. Project and Branch are resolved outside Alchemy and are unchanged. No Alchemy namespaces are used, so bare former IDs resolve correctly.
- **No old ID can equal a new ID.** Every new ID starts with `<app>.` and ends in a segment without `-`; every old ID ends in `-<suffix>` or starts with `servicekey-`/`streamskey-`/`COMPOSER_`. So the rename shift and cycle rules in `Rename.ts` never apply.
- **Upstream replace and delete paths are as `upgrade-effects.md` says.** I read each `diff` and `delete`:
  - App, Database and Bucket replace only on project (Database also on region, default flag or source). `logicalId`, `displayName` and `name` changes are updates. The Bucket update API documents its display name as a label that does not change the S3 bucket name (`pdp-control-plane` `routes/v1/buckets.ts` around line 640).
  - Connection replaces on `name`; its `delete` loads the stored `connectionId` and refuses if its database or physical name differ from the stored ones.
  - BucketAccessKey replaces on `name`; its `delete` removes `{bucketId, keyId}` from state only. Upstream keeps no list for it, so a hand-made key is never in state.
  - EnvironmentVariable `delete` checks project, branch, class and key (`ensureVariableIdentity`) and skips system-managed rows.
  - Deployment `delete` checks the deployment belongs to the stored `appId`.
  - Replacement is create-first, and old generations are deleted only in the garbage-collection phase after every resource has converged (`Apply.ts` line 247, lines 1102–1110). A run that fails partway deletes nothing.
- **The 52-character Connection limit is right.** `physicalInstanceName` (`Prisma/Internal/EnvName.ts`) cuts the name to 52 and appends `-` and 12 characters; the API caps Connection names at 65 (`routes/v1/connections.ts` line 223). Bucket 100 (`routes/v1/buckets.ts` line 307) and App 256 (`models/v1/compute.ts` line 55) match; the access key name has no maximum. No name kind restricts characters, so dots are accepted by the API schema.
- **`validatePlatformName` runs while the stack is declared**, before Alchemy applies anything, and the tests assert the exact message and that no Database or Bucket was recorded (`control-lowering.test.ts` lines 2718–2800).
- **App name check.** `assertAppName` runs in Load for every module root and in `resolveAppIdentity`, so a name with `.` can no longer produce wrong former IDs.
- **Local dev.** The record carries `formatVersion`; a record without it gets the app name in front of every key, without guessing. The emulators hook and the local providers both key by `resourceId(address)`. The bucket folder keeps its old path.
- **Tests pin literal former IDs** for every node kind (`control-lowering.test.ts` lines 3025–3330), including an app name with `-`.

## Findings

### F01 — The documented way out of the env key clash deletes data, and the clash is wider than described

- **Location:** `docs/design/90-decisions/ADR-0057-a-nodes-address-is-its-full-path-from-the-app-name.md` line 136; `.drive/projects/node-addressing/slices/a1-fully-qualified-identity/upgrade-effects.md` line 37; `docs/guides/deploying.md` lines 458–495 (says nothing).
- **Issue:** The ADR says to "rename one of the two nodes before upgrading". Renaming a node makes it a new entity, and the same ADR (line 127) says the deploy then deletes the old entity's rows. If the user renames the module named like the app, every database and bucket inside it is deleted with its data. If they rename the service, its App is deleted with its custom domains, and its generated secrets are minted again. Either breaks the critical done condition.

  The condition is also wider than "a module named like the app". Keys are upper-cased and `-` becomes `_`, so a new key of node N equals an old key of node M whenever M's old key starts with the app name in key form. That happens with:
  - a module or a service directly below the root whose ID is the app name in any letter case (`Shop` in the app `shop`). A service `shop.shop` with a dependency input `x` had the old key `COMPOSER_SHOP_X_P`, which is the new key of service `shop.x`'s own param `p`;
  - an app name with `-` or `_` and modules that spell it (`my-shop` with `my.shop.x`).

  The user sees upstream's message "appeared after the adoption check... rerun with adoption enabled", which names neither node and suggests the wrong fix. Every rerun fails the same way.
- **Suggestion:** Detect it before Alchemy applies anything. From the graph, compute every new key that equals another node's old key; preflight already queries variables by key (`target/src/preflight.ts` `listEnvVars`), so check whether a row with that key exists on the stage. If one does, fail naming both addresses and the key. Give a remedy that loses nothing: delete that old `COMPOSER_` variable on the Branch (it is Composer's own superseded row, and the old Deployment already holds a copy), then deploy again; garbage collection then finds it gone and continues. Write the precise condition and this remedy in the ADR, `upgrade-effects.md` and the upgrade guide, and add a unit test for the detection.

### F02 — The QA plan does not cover the critical done condition

- **Location:** `.drive/projects/node-addressing/slices/a1-fully-qualified-identity/plan.md` D6 (lines 55–59); `.drive/projects/node-addressing/handover.md` lines 62–69.
- **Issue:** The slice spec requires QA to plant state the graph does not represent before the upgrade (a custom domain on a service, a hand-set environment variable, a hand-made Connection) and show it is unchanged after. D6 and the handover's steps do not mention it, and step 1 on `qa-a1-qsgn6n` already ran without it. The spike also never changed an App `displayName`, a Bucket `name` or an access key `name`; it kept the short Connection name.
- **Suggestion:** Add to D6 and the handover, before step 2: plant a custom domain on a service, a hand-set environment variable, a hand-made Connection on the database and a hand-made access key on the bucket, and record their ids. After the redeploy, check that each is unchanged, that the App id, endpoint domain and custom domain binding are unchanged, that the Bucket id and S3 bucket name are unchanged, that the database's default connection was not rotated (F03), and that the platform accepted the dotted names. Plant these on the existing QA Project before step 2, or start over.

### F03 — `upgrade-effects.md` says a Database update changes nothing, but upstream can rotate its default connection

- **Location:** `.drive/projects/node-addressing/slices/a1-fully-qualified-identity/upgrade-effects.md` line 16 (Database row); upstream `node_modules/alchemy/src/Prisma/Database.ts` lines 916–933 and `Prisma/Internal/DatabaseSecrets.ts` lines 105–165.
- **Issue:** Every upgrade updates every Database, because its `logicalId` and derived name change. On update, upstream calls `recoverDatabaseConnectionSecrets`, which rotates the database's default connection when the deploy state holds no connection secrets for it. The default connection is not in the Composer graph, and anything that copied its URL from Console would stop working. State that upstream created holds the secrets, so this should not happen for most v0.34.0 stages, but the document should not say "Nothing" without the condition.
- **Suggestion:** State the condition in the Database row and the verdict. Add the check to QA (F02).

### F04 — The core-model sketch still says the Connection keeps an unchanged label

- **Location:** `docs/design/10-domains/core-model.md`, the descriptor sketch (`Prisma.Connection(`${address}.connection`, { database: db, name: /* unchanged label */ })`).
- **Issue:** The Connection `name` is now the address.
- **Suggestion:** Write `name: address`.

### F05 — `Load`'s doc comment now documents the `APP_NAME` regex

- **Location:** `packages/0-framework/1-core/core/src/graph.ts` lines 19–28.
- **Issue:** `const APP_NAME` was inserted between `Load`'s doc comment and `Load`, so the comment attaches to the constant and `Load` has none.
- **Suggestion:** Move `APP_NAME` and `assertAppName` above the comment.

### F06 — Two code comments cite the superseded ADR-0051 for the adoption rule

- **Location:** `packages/1-prisma-cloud/1-extensions/target/src/descriptors/shared.ts` line 175; `packages/1-prisma-cloud/0-lowering/lowering/src/state/empty-scope.ts` line 81.
- **Issue:** The rule now lives in ADR-0057, which supersedes ADR-0051.
- **Suggestion:** Cite ADR-0057.

### F07 — `prisma emulator list` shows short addresses for instances made before the upgrade

- **Location:** `packages/1-prisma-cloud/0-lowering/local-target/src/emulator-instances.ts` line 224; `packages/9-public/composer-cli/src/family/emulator-list.ts` lines 29 and 101; `docs/guides/running-locally.md` line 173.
- **Issue:** Carried over from round 1 (F08), not addressed. Old instances keep the label `composer.address: 'api'`, while the guide says the list shows the node's address. One form of identity means the listing should not show two.
- **Suggestion:** Rewrite the label when an existing instance is reused, or say in the upgrade note that old instances show the short address until `--fresh`.

## Deferred (out of scope)

- **`LowerContext.id` and `address` are always equal** (round 1, S06). A cleanup across core; not this slice.
- **Rename declarations under a filtered deploy.** Upstream refuses them; Composer has no filtered deploy path.
- **A state row in the oldest format that also needs a rename.** Should compose; low priority.
- **Temporary duplicate `COMPOSER_` rows and Connections during the upgrade deploy.** Only matters near a platform count limit; a failure there is loud and deletes nothing.

## Already addressed (round 1)

| Round-1 finding | Fixed by |
| --- | --- |
| F01 app name with `.` gives wrong former IDs | `058dd4dd` (`assertAppName`); `addressBelowApp` removes the known prefix |
| F02 app name characters invalid in env keys | `058dd4dd` |
| F03 local record guessed old keys | `a3c3e9a3` (`formatVersion`) |
| F04 length limit on the full address | `25d9b0d7`, `f8f46c16` (per-kind limits, decided by Will) |
| F05 "before anything changes" | `4b480705` (ADR and guide now say the topology is replaced) |
| F06 two helpers for "address without the app name" | `c4b46087` (`addressBelowApp` only) |
| F07 hook and providers keyed by different helpers | `c4b46087` (both use `resourceId`) |
| S02/S04 short labels on some platform names | `25d9b0d7` (every name is the address) |
| S07 `serviceOrigin` with `--name` | `4b480705` |
| S08 role names | `c4b46087` (nouns) |
| S09 "streams module" comment | `c4b46087` |

## Acceptance-criteria verification

| AC | Verdict | Detail |
| --- | --- | --- |
| **Critical:** upgrading from v0.34.0 loses no application data and touches no out-of-graph state; only Composer's Connections and access keys are recreated | **NOT VERIFIED** | By code reading it holds: former IDs match v0.34.0, no App/Database/Bucket is replaced, every replace deletes one stored object after an identity check, and deletes happen only after a fully converged run. Open: F01 (the documented remedy deletes data), F03 (default connection rotation when state lacks secrets). QA has not run and its plan omits the planted state (F02). |
| A fabricated app deployed with v0.34.0 then redeployed keeps rows, objects, the secret and the RPC key; rows carry full `logicalId`s; the state has only new IDs | **NOT VERIFIED** | QA step 2 not run. Unit tests prove the declarations; the providers of GeneratedParam, ServiceKey and S3Credentials return their stored output, so a moved row keeps its value. |
| The same app deploys from scratch to a new stage | **NOT VERIFIED** | The spike showed unmatched renames are ignored; QA step 3 not run. |
| `prisma dev` on a directory last run with v0.34.0 keeps its local database's data | **WEAK** | `legacy-address-keys.test.ts` lines 261–300 runs real emulators from an old-format record and asserts instances, ports and the bucket folder are reused. It does not write and read database rows, and does not start from a directory v0.34.0 itself wrote. QA step 4 covers it. |
| Addresses start with the deployed app name on the CLI graph and the lowering | **PASS** | `load-module.ts` line 526; `pipeline.ts` lines 129–138 pass the name to Load; `lowering()` passes `opts.name`. Tests in `load.test.ts` and `lowering.test.ts`. |
| Resource IDs are `<address>` or `<address>.<role>`, each with `renamedFrom(<v0.34.0 ID>)` | **PASS** | Every constructor checked; literal former IDs asserted in `control-lowering.test.ts` lines 3025–3330. |
| Generated values, RPC keys and stream keys are renamed, not recreated | **PASS** (unit) | Former IDs match v0.34.0; reconcile returns stored output. Live check in QA. |
| Every platform name is the full address; validation per kind, never shortened | **PASS** | `descriptors/shared.ts` lines 96–118; test "every platform name Composer writes is the address" and the limit tests at lines 2718–2800. |
| `logicalId` and the topology use full addresses | **PASS** | `logicalIdProp` and the unchanged topology builder take graph IDs; `application-topology.test.ts`. |
| Env keys from the full address, `-` to `_`, in the serializer and local copies | **PASS** | `serializer.ts` `addressKeySegments`; `local-target/src/compute.ts` lines 79–94; test with `my-shop`. F01 concerns the transition only. |
| User-facing addresses are full | **PASS** | `serviceOrigin` error, report tree (`render-deployment.ts` line 82), `dev url`, docs. F07 is a display gap. |
| Local dev rewrites the record; bucket folders and lookups follow | **PASS** | `normalized()` with `formatVersion`; `bucketDataDir`; tests listed above. |
| Design records and docs updated in this PR | **PASS** | ADR-0057, index, principle, glossary, domain docs, guides, skill, examples. F01, F03, F04 are accuracy fixes. |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 9 | addresses, resource IDs, renamed values (unit), platform names, `logicalId`, env keys, user-facing addresses, local record, docs |
| NOT VERIFIED | 3 | critical condition, round trip, new stage |
| WEAK | 1 | `prisma dev` data |
| FAIL | 0 | |

---

# Round 3 — fixes for the round-2 findings

Commits `b6a2b273`, `82afb495`, `0c8e807e` on top of `49ce6e91`. Two deviations from the round-2 suggestions were accepted by the coordinator and are not reopened: the clash check consults the platform rather than failing on the graph alone, and F07 is a note in the upgrade guide rather than a code change.

## Verdict on the round-2 findings

| Round-2 finding | Status | Evidence |
| --- | --- | --- |
| F01 env key clash | **Fixed, with two small gaps (R3-F01, R3-F02)** | `target/src/env-key-clash.ts` enumerates every row a service writes, under both keys: each `paramEntries` entry (service-own and dependency-input), the input document, every reserved provider param (accepted RPC keys, streams key, origin), and every generated or origin leaf. That is the same set `descriptors/compute.ts` writes (lines 197, 236, 278, 329–362). Tests cover the module case, another letter case, `-` and `_` in the app name, and a service named like the app with a dependency input (`env-key-clash.test.ts`). `runPreflight` checks the clash before its own fill step, and the alchemy process (where the first resource and the `DATABASE_URL` claim are written) starts after preflight. The scope check matches Composer's writes: production class with no branch, or preview class on the stage's Branch. |
| F02 QA plan | **Fixed** in `49ce6e91` | Plan D6 plants a custom domain, a hand-set variable, a hand-made Connection, a hand-made access key and checks the default connection; QA restarts on a new Project. |
| F03 default connection rotation | **Fixed** | `upgrade-effects.md` now states the condition. I checked the argument: upstream rotates only when neither the stored attributes nor the API read hold a connection string; v0.34.0's upstream Database stores them on create and on every update; only a row rewritten by `lowering/src/state/legacy-resources.ts` lacks them (lines 223–235), and such a row has no `logicalId`, so the first deploy with `logicalIdProp` (first tagged in `v0.29.1-dev.5`) updated it and stored them. A stage last deployed by v0.34.0 cannot hit it. |
| F04 core-model sketch | Fixed | `name: address`. |
| F05 `Load` doc comment | Fixed | `graph.ts`. |
| F06 ADR-0051 citations | Fixed | `shared.ts`, `empty-scope.ts`. |
| F07 emulator labels | Resolved by a guide note | `docs/guides/deploying.md`; the note says `--fresh` deletes local data. |

**The fix loses nothing.** Deleting the old owner's row with that key removes a `COMPOSER_` row Composer wrote. Its value comes from Composer's own sources (config, the renamed `GeneratedParam` state, service-key state), so the rerun writes it under the old owner's new key. The running Deployment keeps its environment snapshot. The garbage-collection delete of the old generation then gets `NotFound` and continues. I checked `prisma project env delete` in `wip/prisma-cli` (`packages/cli/src/commands/project/env-delete.ts`). `--role production` and `--branch <name>` delete exactly one row in that scope, and a Composer stage's Branch `gitName` is the stage name, so the printed commands target the right row. A new stage, or a stage that has moved, passes: the old key is absent, or the old owner's new key exists.

## Round-3 findings

### R3-F01 — "Deploy failed before changing anything" is not true: the Branch's topology and the Build record are already written

- **Location:** `packages/1-prisma-cloud/1-extensions/target/src/preflight.ts` line 308 (the error); ADR-0057 lines 123 and 138; `docs/guides/deploying.md` line 497; `upgrade-effects.md` line 44.
- **Issue:** `executeDeploy` attaches the reporters, which replace the Branch's application topology and record the Build, at `cli/src/operations/execute-deploy-destroy.ts` line 465. Preflight starts at line 497. So when the clash check fails, the topology already names the full addresses, while the rows still hold the short `logicalId`s, until a deploy succeeds. No data is at risk. But the message and three documents say nothing changed. The ADR's `serviceOrigin` paragraph already describes this same situation accurately.
- **Suggestion:** Use the `serviceOrigin` wording: "before any resource is created, changed or deleted; the Branch's topology has already been replaced". Alternatively, move the check ahead of `attachReporters`.

### R3-F02 — A chain of clashes takes one failed deploy per link

- **Location:** `packages/1-prisma-cloud/1-extensions/target/src/preflight.ts`, `pendingEnvKeyClashes`.
- **Issue:** A clash on key K is skipped when the old owner's new key K' exists. If K' is itself the old key of a third node, it exists before any move, for example `shop.x`, `shop.shop.x` and `shop.shop.shop.x` in the app `shop`. In that case only the K' clash is reported. After the user deletes K', the next deploy reports K. Every run still stops before any resource is written, so this is safe, but the user needs three deploys and two error messages.
- **Suggestion:** Count K' as "already moved" only when K' is not the key of another clash in the list. Then every pending variable is reported at once. Add a test with the three-node chain.

## Acceptance criteria (round 3)

Unchanged from round 2, except that the critical condition's open code issues (F01, F03) are closed. It stays **NOT VERIFIED** only because QA (D6) has not run.

---

# Round 4 — R3-F01 and R3-F02

Commits `b34ac515`, `648a4872`. **Verdict: SATISFIED.**

- **R3-F01 fixed.** The error (`preflight.ts`), ADR-0057's clash paragraph and consequence, the upgrade guide and `upgrade-effects.md` now say that no resource has been created, changed or deleted, and that the Branch's topology has been replaced and the build recorded. That matches the order in `execute-deploy-destroy.ts`: reporters attach at line 465, preflight starts at line 497. No other copy of "before changing anything" remains. One leftover detail: the ADR consequence still says "until that one old variable is deleted", but with a chain there can be several. The guide correctly says "delete each". Not blocking.
- **R3-F02 fixed.** `pendingEnvKeyClashes` now counts a row under the old owner's new key as moved only if no pending clash has that key. The walk always ends: each step moves from a clash's key to the old owner's new key, and the new key is the old key plus the app-name segment, so it is strictly longer. No cycle is possible. Row lookups are memoized. I traced the three-node chain by hand. With the old rows K and K' present and K'' absent, both K and K' are reported. Once K'' exists, neither is.
- **The tests assert what they claim.** "reports every link in one run" expects both `COMPOSER_SHOP_X_ORIGIN belongs to "shop.shop.x"` and `COMPOSER_SHOP_SHOP_X_ORIGIN belongs to "shop.shop.shop.x"`. A successful preflight would turn into `[object Map]` and fail both checks. Before this fix, the first check would have failed, so the test tells the two behaviours apart. "passes once every node has moved" fails if preflight throws.

The critical condition has no open code issues. It is still NOT VERIFIED until QA (D6) runs.

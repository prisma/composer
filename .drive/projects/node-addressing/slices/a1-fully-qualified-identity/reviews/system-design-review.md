# System design review — A1, fully qualified node identity

Range: `origin/main...HEAD` on `drive/fully-qualified-node-addresses` (16 commits, 102 files).

Read for this review: `CLAUDE.md`; `docs/design/01-principles/`; the ADR index; ADR-0056 in full; ADR-0051 and the amendment notes on ADR-0006, ADR-0019, ADR-0048, ADR-0052 and ADR-0053; the glossary entry "Address and logical ID"; the changed parts of `core-model.md`, `deploy-cli.md`, `local-dev.md`, `alchemy-lowering.md` and `pdp-data-model.md`; the project `spec.md`, `design-notes.md`, the spike findings, and the slice `spec.md` and `plan.md`.

## Verdict

The concept change is coherent and well placed. Core changed only in how Load builds an address, and stays target-agnostic. All target-specific naming lives in the Prisma Cloud target. The migration is a fixed rule, not a guess, on the hosted side. The weak spots are around the address without the app name ("short form"). It is computed by two functions under two names, and two of the four platform labels that keep it are not justified by the reason the ADR gives. The local record rewrite also decides old versus new keys from the shape of the string, which can misread one case. Finally, `serviceOrigin()` with a full address cannot be used together with `--name`, and the docs understate that.

## What changes, and the invariants it introduces

One concept changes: the form of a node's address. Load now prefixes every child with the root's address, and the root's address is the deployed app name (`packages/0-framework/1-core/core/src/load-module.ts:523`). The CLI resolves the name before Load, so the CLI's graph and the lowering's graph agree (`packages/0-framework/3-tooling/cli/src/pipeline.ts:128-137`; `core/src/control/deploy.ts:578`).

Invariants the branch now relies on:

1. Every address starts with the deployed app name. Below the root, segments are letters and digits.
2. A node's main Alchemy resource ID equals its address. Other pieces are `<address>.<role>[.<which one>]` (`target/src/resource-ids.ts:7-9`).
3. No resource ID equals a node address, because modules have no resources and services and resources have no children.
4. Every resource declares its pre-ADR-0056 ID through `renamedFrom` (`target/src/legacy-resource-ids.ts`).
5. Props that force upstream to replace a resource keep today's value. Connection and BucketAccessKey `name` are the cases that matter.
6. Local dev: the record key for a database or bucket equals its main resource ID, which equals its address (`local-target/src/postgres.ts:48`, `local-target/src/bucket.ts:65`). This is new. Before, both sides used the shared `resourceName` helper.

Invariant 6 is a contract across packages. `local-target` sits in the lowering layer and cannot import from the target extension, so nothing in code ties the two sides together. `local-dev.md` states it, and the emulator-instance tests cover it end to end. That is acceptable, but it is now the second place that depends on invariant 2 (see S05).

## Subsystem fit and layer boundaries

- **Core stays target-agnostic.** The core diff is the address rule and a doc comment on `LowerContext`. Resource IDs, labels, env keys and migration all live in `@internal/prisma-cloud-target` and `local-target`. Good.
- **Old-ID computation is in the right package.** Only the Prisma Cloud target built the old IDs, so only it should know them. Isolating them in `legacy-resource-ids.ts`, with a "delete when no such stage remains" note, makes them removable. Good.
- **`resourceLabel` is in the wrong file.** It lives in `target/src/service-app.ts:6-15`, a file about a service's App name. It names databases, connections, buckets and access keys, never services. It also computes exactly what `legacyAddress` computes (`legacy-resource-ids.ts:11-14`), with a different result for a bare root (`resourceLabel('shop')` is `shop`; `legacyAddress('shop')` is `''`). One concept, two names, two files, two edge behaviours. See S01.
- **`LowerContext` carries `id` and `address`, now always equal.** `deploy.ts:675` and `:731` set `address: id`. With every address now built from `selfId`, there is no case left where they differ. `stageDatabase` still takes both (`descriptors/shared.ts:199-212`) and uses `id` only in one error message. This predates the branch, but the branch removes the last reason for two fields. See S06.
- **Env key segments are duplicated** in `local-target/src/compute.ts:88-93` and `target/src/serializer.ts:72-80`. The comment says this follows an existing pattern for the same layering reason. Acceptable, but the two copies are now an invariant the env-key rule depends on, and only tests keep them equal.

## Naming and typology

| Name | Assessment |
| --- | --- |
| `resourceId(address, ...role)` | Good. Says what it builds. Variadic role reads well at call sites. |
| `resourceLabel(address)` | Vague. "Label" of which resource, for what? It is specifically the `name` prop of Database, Connection, Bucket and BucketAccessKey, and its value is the address without the app name. A name like `platformNameLabel` is not much better; the real fix is S01: one function for "address without the app name", used by both the label and the legacy IDs. Also inconsistent with its neighbour `serviceAppName`, which uses "Name" for the same kind of thing. |
| `legacy-resource-ids.ts` | Accurate. It also builds old env keys, but only to compute env-variable resource IDs, so the name holds. |
| `legacyAddress` | Accurate as a compatibility value. Duplicates `resourceLabel` (S01). |
| `fromLegacyId` | A one-line alias for `renamedFrom`. It adds a name, but gives one search target for removal. Keep it. |
| `legacy-address-keys.ts`, `withFullAddressKeys` | Accurate and removable. |
| `bucketDataDir(scope, address)` | Good. It takes the full address and throws if the address is outside the app, so the short folder name is derived, not passed in. |
| `addressKeySegments` | Accurate. |
| roles `deploy`, `warm`, `migrate`, `env`, `generated` | Clear. Verbs and nouns are mixed, but each reads as "the X of this node". |
| role `conn` | The only abbreviation. `connection` would match the rest. Low priority; changing it later needs another rename declaration, so decide before merge. |
| roles `servicekey`, `streamskey` | Compound words with no separator. They also break the pattern that a role names a piece, then a further segment says which one: `servicekey.<input>` is fine, but `streamskey` mixes the purpose (streams) into the role. `<provider>.streamskey` sits next to `<consumer>.servicekey.<input>` and both are `Prisma.ServiceKey`. Acceptable as is; note it because renaming later costs a rename declaration. |
| role `key` (bucket access key) | Ambiguous next to `servicekey`. `accesskey` would say which kind of key. Same cost note. |

## "One form of identity": every place the short form still appears

Will rejected a second form of identity. The test for each short-form use is: is it a label or a compatibility value that nothing joins on, or does something use it to find the node?

| Where | Used to find the node? | Justified? |
| --- | --- | --- |
| Old-ID computation (`legacy-resource-ids.ts`) | Only to find the old state entry, once. | Yes. Compatibility only, removable, documented as such. |
| Connection `name` (`descriptors/shared.ts:213-225`) | No. Upstream replaces the Connection when it changes, which rotates credentials. | Yes, by the ADR's stated reason. |
| BucketAccessKey `name` (`descriptors/bucket.ts:42-46`) | Locally, yes: the local provider uses it as the S3 access key ID (`local-target/src/bucket.ts:123`). Hosted, upstream replaces the key when it changes. | Yes. The ADR does not mention the local use; worth one line. |
| Bucket `name` (`descriptors/bucket.ts:31-41`) | No. | **Not by the stated reason.** `alchemy-lowering.md:166-175` says upstream replaces a Bucket only when its project changes, so its `name` updates in place. The ADR groups it with Connection anyway (ADR-0056 line 115). Either the Bucket name follows the full address, like an App's display name, or the ADR needs a different reason. See S02. |
| Branchless (local dev) Database `name` (`descriptors/shared.ts:214`) | No. The local Database provider now finds its instance by resource ID, not by `name` (`local-target/src/postgres.ts:48`). | **Not by the stated reason.** Database is replaced only on project, region, source or default changes. A hosted Database's display name already follows the full address, so local and hosted now differ for no recorded reason. See S02. |
| Local bucket data folder `buckets/<app>/<rest>` (`local-target/src/bucket.ts:32-43`) | It is the full address written as a path, split at the first dot. | Yes. Not a second form; just a path encoding. |
| Local record keys (`legacy-address-keys.ts`) | Old keys are rewritten on read. | Yes as compatibility, but see S03 on how it decides what is old. |

So the code holds to one identity: nothing joins on the short form. But "label" is carrying more than it should. Two of four labels are short because the helper is shared, not because the platform forces it. And the principle now says the address is "the only form in which any surface names the node" (`architectural-principles.md:76`). Console shows the Bucket as `uploads` and the Connection as `catalog`, so that sentence overclaims. See S04.

## ADR-0056: reasoning and accuracy against the code

Accurate:

- The roles table, the rename table in `alchemy-lowering.md`, and the tests agree. `control-lowering.test.ts:2892-3203` pins literal old IDs (`catalog-db`, `servicekey-web.auth`, `COMPOSER_AUTH_API_INPUT:secret-generated`, `creds-creds`) rather than recomputing them, which is the right way to test a compatibility rule.
- The collision argument holds for the IDs built. `streamskey` hangs off `edge.from` (`deploy.ts:665`), a service, not a module. The comment at `control/extension.ts:99-101` says "streams module"; it should say service.
- The env-key collision argument holds: one app has one root name.
- Local dev: the bucket folder and record rewrite match `local-dev.md` and the code.

Inaccurate or incomplete:

- Line 115 gives one reason (replacement) for four short labels; it applies to two (S02).
- Line 92 says a `--name` mismatch with `serviceOrigin()` "is fixed in one line". The fix is to put the `--name` value in the code, which then breaks the deploy without `--name`. An app that uses `serviceOrigin()` cannot be deployed under both its own name and a per-run name. `deploy-cli.md:100-104` describes exactly that per-run pattern for CI, and `.github/actions/deploy-verify-destroy/action.yml:51` uses it. No CI example uses `serviceOrigin()` today, so nothing breaks now. But the ADR should say plainly that `--name` and `serviceOrigin()` do not combine, rather than calling it a one-line fix. The design notes rejected relative resolution as a second way to write an address; that remains a valid reason, but the cost should be recorded (S07).
- The ADR does not say that env-variable renames are effectively replacements: the key changes, so upstream replaces after the rename. It says the replacement is harmless, which is right, but a reader may wonder why env rows declare `renamedFrom` at all. One sentence ("declared for uniformity; the key change replaces them anyway") would help.

Doc consistency: the principle, glossary, `core-model.md`, `deploy-cli.md`, `pdp-data-model.md`, `local-dev.md`, `alchemy-lowering.md` and the ADR index agree on the address form, resource IDs and env keys. The amendment notes on ADR-0006, -0019, -0048, -0052 and -0053 are short and correct. ADR-0051 is marked superseded in both its header and the index.

## Test strategy, at the architectural level

- Unit tests pin new and old IDs per node kind with literal strings. Good.
- `resource-ids.test.ts:40-98` tests each legacy builder against a hand-written expectation. These partly restate the formula; the `control-lowering` tests are the real evidence. Fine.
- `legacy-address-keys.test.ts:207-240` runs local dev from a record in the old format and checks reuse of instances, ports and the bucket folder. Good. It has no case where a child's provision ID equals the app name (S03).
- No automated test proves the legacy IDs equal what the published release actually wrote. That can only be checked against real state, which is what plan step D6 does. The spike did not cover buckets, access keys, env rows, generated values or service keys. D6 must include each, and must check that the Bucket and access key are not replaced. This is the slice's largest remaining risk.
- Nothing tests invariant 6 (local record key equals main resource ID) at the unit level in the target package. A small test that lowers a database and a bucket in branchless mode and checks the resource ID against the key `emulators.ts` records would catch a future drift (S05).

## Findings

**S01**
- Location: `packages/1-prisma-cloud/1-extensions/target/src/service-app.ts:6-15`; `packages/1-prisma-cloud/1-extensions/target/src/legacy-resource-ids.ts:10-14`
- Issue: "The address without the app name" is computed twice, under two names, in two files, with different results for a bare root. `resourceLabel` also sits in a file about service App names.
- Suggestion: Keep one function. Define it once (for example in `legacy-resource-ids.ts`, since every use is for compatibility with what earlier releases wrote), and have the label use it. Make the root case explicit or throw. Rename so the name says what the value is.

**S02**
- Location: `descriptors/bucket.ts:31-41`; `descriptors/shared.ts:213-214`; ADR-0056 line 115; `alchemy-lowering.md:175`
- Issue: The Bucket `name` and the branchless Database `name` keep the short form, but the reason given (a changed name replaces the resource) does not apply to them by the docs' own list. Hosted Database display names already follow the full address, so local and hosted differ.
- Suggestion: Either pass the full address for these two names, as the App display name does, or record the actual reason in the ADR (for example, if the Bucket `name` is a physical name that the platform cannot change in place, say so and correct the replacement list). QA must confirm whichever is chosen does not replace the Bucket.

**S03**
- Location: `packages/1-prisma-cloud/0-lowering/local-target/src/legacy-address-keys.ts:10-27`
- Issue: Old versus new keys are decided by string shape. A child whose provision ID equals the app name is misread. App `shop` with a child database `shop` had old key `shop`; it is taken as the root's key and not rewritten, so the database gets a new empty instance. A module `shop` with child `db` had old key `shop.db`; it is taken as already full and points at the wrong node. This is a guess, which the project's principles rule out.
- Suggestion: Record a format version in `emulator-instances.json` and rewrite only records without it. Add a test with a child named like the app.

**S04**
- Location: `docs/design/01-principles/architectural-principles.md:76`
- Issue: "The only form in which any surface names the node" is not true: Console shows the short labels on Buckets, Connections and access keys.
- Suggestion: Say the address is the only form used as identity or accepted as a reference, and that some platform labels keep the shorter form for compatibility.

**S05**
- Location: `local-target/src/postgres.ts:48`; `local-target/src/bucket.ts:65`; `target/src/local-target/emulators.ts:55-61`
- Issue: Local providers now find their instance by the Alchemy resource ID, relying on "main resource ID equals address" from another package. The shared helper that used to tie the two sides together is gone.
- Suggestion: Add a target-package test that lowers a branchless database and bucket and asserts their resource IDs equal the keys the emulators hook records. Keep the sentence in `local-dev.md`.

**S06**
- Location: `packages/0-framework/1-core/core/src/control/deploy.ts:110-116`, `:675`, `:731`; `descriptors/shared.ts:199-212`
- Issue: `LowerContext.id` and `LowerContext.address` are now always the same string. Two fields for one identity invite a future reader to think they differ.
- Suggestion: Follow-up, not this slice: drop one, or document that they are equal. Remove `id` from `stageDatabase`.

**S07**
- Location: ADR-0056 line 92; `docs/design/10-domains/deploy-cli.md:100-104`
- Issue: A full address in `serviceOrigin()` cannot work both with and without `--name`. The ADR calls the failure "fixed in one line", which hides that the fix breaks the other deploy.
- Suggestion: State in the ADR and in `deploy-cli.md` that an app using `serviceOrigin()` cannot be deployed under `--name`, and that this is the accepted cost of rejecting relative addresses.

**S08**
- Location: role segments in `descriptors/*.ts` and `control/extension.ts`
- Issue: `conn` is the only abbreviation; `key` for a bucket access key is ambiguous next to `servicekey`. Changing a role later needs another rename declaration.
- Suggestion: Decide before merge. If changing, use `connection` and `accesskey`; otherwise keep and move on.

**S09**
- Location: `packages/1-prisma-cloud/1-extensions/target/src/control/extension.ts:99-101`
- Issue: The comment says "streams module"; the provider address is the streams service (`edge.from`). The collision argument depends on it being a service.
- Suggestion: Say "streams service".

**S10**
- Location: plan step D6; `assets/spike-alchemy-renames.md`
- Issue: The spike did not cover buckets, access keys, env rows, generated values or service keys, and no automated test can check old IDs against real state.
- Suggestion: D6 must show, for each of those, that the platform ID or value is unchanged after the migrating deploy, and that the Bucket and access key were updated, not replaced.

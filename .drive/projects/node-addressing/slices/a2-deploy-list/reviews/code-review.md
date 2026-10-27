# Code review — A2 `prisma deploy list`

Range: `origin/main...drive/deploy-list` (merge base `87d001de`, head `2e16ca74`). Spec: [../spec.md](../spec.md).

## Summary

The command does what the spec says, the join is correct, and the tests are well aimed. The gaps are in the end-to-end check (it does not check `kind`, and it only runs on production), one unhelpful error, and the resource-type table being copied a third time.

Checked locally: `bun test` for `test/deploy-list.test.ts` and `test/deployed-nodes.test.ts` (21 pass), `scripts/deploy-list-check.test.ts` (8 pass), `pnpm lint:deps` (clean). The Management API SDK's `getV1Services`, `getV1Databases` and `getV1Buckets` all accept `projectId` and `branchId` filters, so the Branch filter is real and rows from another stage with the same `logicalId` cannot leak in.

## What looks solid

- The join is a pure function with one test per kind, plus missing-row, empty and order cases.
- The command test asserts the actual request parameters (`branchId` on `/v1/services`, `gitName` on the Branch lookup), not just the output.
- An invalid `--stage` is rejected before any network call, and the test asserts that no request was made.
- The Management API code is lazily imported, so loading the family stays cheap.
- The e2e check reads the platform independently of the command, through `/v1/apps` and its own Branch filter.

## Findings

### F01 — The e2e check never compares `kind` (should-fix)

- **Location:** `scripts/deploy-list-check.ts` lines 63–86.
- **Issue:** `deployListMismatches` checks address order, platform ID and URL, but not `kind`. A regression that printed `module` for every node, or `raw-postgres` instead of `postgres`, would pass the real-platform check.
- **Suggestion:** Compute the expected kind from the topology node (`project` for the root, `service`, `postgres` for both Postgres types, `bucket` for `s3`, `module`, otherwise the raw `type`) and report a mismatch. Add a case to `scripts/deploy-list-check.test.ts`.

### F02 — A credential with no workspace gives an unhelpful error (should-fix)

- **Location:** `packages/9-public/composer-cli/src/family/list-deployed.ts` lines 47–49.
- **Issue:** It fails with `DEPLOY.CONTAINER_FAILED` and the message "The active credential names no workspace.", with no `fix`. `prisma deploy` in the same situation says `PRISMA_WORKSPACE_ID` is required (`packages/1-prisma-cloud/1-extensions/target/src/container.ts` line 163). The user learns what is wrong but not what to do, and the two commands disagree.
- **Suggestion:** Use the same message deploy uses, or add a `fix` naming `PRISMA_WORKSPACE_ID`. Add a command test for it.

### F03 — The target's resource types are restated a third time (should-fix)

- **Location:** `packages/9-public/composer-cli/src/family/deployed-nodes.ts` lines 11–15.
- **Issue:** `RESOURCE_KINDS` repeats which target types (`postgres`, `raw-postgres`, `s3`) have a database or bucket row. The same table is in `scripts/platform-identity.ts` (lines 23–27) and `packages/1-prisma-cloud/1-extensions/target/src/local-target/emulators.ts` (line 43). If the target adds a database type, `deploy list` shows its raw type with no platform ID, and nothing fails: the e2e check reads its own copy.
- **Suggestion:** Export one map from resource type to row list from the Prisma Cloud domain (for example next to `readDeployedStage`) and use it in `deployed-nodes.ts` and `scripts/platform-identity.ts`.

### F04 — The e2e check only covers production (should-fix)

- **Location:** `.github/actions/deploy-verify-destroy/action.yml` lines 68–74.
- **Issue:** The step sets no `STAGE`, and the action only deploys production. The named-stage path (Branch by `gitName`, rows filtered by that Branch) is proven only against the fake client. The spec's done condition asks for "a real deployed stage".
- **Suggestion:** Make D4 QA explicitly run `deploy list --stage <name>` against a real named-stage deploy and record the output in the slice, since the e2e workflow has no stage deploy to reuse.

### F05 — Dead branch in `readDeployedStage` (nit)

- **Location:** `packages/1-prisma-cloud/0-lowering/lowering/src/deployed.ts` lines 46–47.
- **Issue:** `resolveContainer` always returns `branchId` for a named stage and `defaultBranchId` for production, so `branchId === undefined` cannot happen. Returning `undefined` there would read as "nothing deployed", which hides a real bug if it ever did happen.
- **Suggestion:** Fail with an error ("resolved no Branch") as `scripts/platform-state.ts` does, instead of returning `undefined`.

### F06 — The human-table test checks only two substrings (nit)

- **Location:** `packages/9-public/composer-cli/test/deploy-list.test.ts` lines 240–248.
- **Issue:** It asserts that stderr contains `shop.catalog.db` and the URL. It would pass if the columns were missing or misordered.
- **Suggestion:** Also assert the header row (`Address`, `Kind`, `Platform ID`, `URL`) and that one row shows `shop.catalog.db`, `postgres` and `db_1` on the same line.

### F07 — The release claim depends on work not yet done (nit)

- **Location:** `docs/guides/deploying.md` lines 321–322, `skills/prisma-composer-core-concepts/SKILL.md` line 408.
- **Issue:** Both say `prisma deploy list` "first ships in the `prisma` release after 8.0.0-rc.26". That depends on the D3 prisma-cli pull request, which has not been opened.
- **Suggestion:** Recheck the version when D3 merges and correct both lines if it ships later.

## Deferred (out of scope)

- **Read failures use `DEPLOY.CONTAINER_FAILED`.** A topology or row read that fails with a 500 surfaces as a container failure (`list-deployed.ts` lines 27–33). It is the nearest existing ADR-0044 code; a read-specific code would mean amending ADR-0044, which is beyond this slice.
- **Two rows with one `logicalId` on a Branch.** The join takes the first match (`deployed-nodes.ts` lines 29–31 and 40). `e2e-verify-identity.ts` already fails a deploy that leaves duplicates, so this is guarded elsewhere.

## Already addressed

After this review, fixed on the branch:

- F01: `aa414ec7`. The check compares `kind`.
- F02: `90cf60cf`. The error says `PRISMA_WORKSPACE_ID` is required, as deploy does.
- F03: `3ee8e3b9`. One map, `RESOURCE_ROW_KINDS`, in `lowering/src/resource-rows.ts`, used by the command, the scripts and the emulators.
- F04: real named-stage QA in [qa.md](../qa.md).
- F05: `5464a84d`. A missing Branch fails with an error.
- F06: `90cf60cf`. The test checks the header and two full rows.
- F07: the docs no longer name a release version.

## Acceptance-criteria verification

The spec has no numbered acceptance criteria. These are its "Chosen design" bullets and done conditions, read as criteria.

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: Lives in composer-cli next to `emulator list` | **PASS** | `src/exports/family.ts` adds `'deploy list'`; test "the published family ships it". |
| AC2: Reads the application topology, not Alchemy state | **PASS** | `deployed.ts` lines 50–54 read only the topology endpoint; the fake client throws on any other route, and the command tests pass. |
| AC3: Join by `logicalId` in the Branch's lists, filtered by project and Branch; root is the Project | **PASS** | `deployed.ts` lines 67–77 send `projectId` and `branchId`; `deploy-list.test.ts` lines 160–162 assert the query; `deployed-nodes.test.ts` covers root and the `logicalId` match among decoys. |
| AC4: Kind mapping (`project`, `service`, `postgres` for both, `bucket`, `module`, else raw type; empty ID with no row) | **PASS** | `deployed-nodes.test.ts` has one test per case, including `s3-credentials` and a missing row. The e2e check does not verify kind (F01). |
| AC5: URL is the service's `appEndpointDomain` | **PASS** | Unit test and command test assert `url: 'https://api.prisma.app'` from the row; e2e compares it against `/v1/apps`. |
| AC6: Stage lookup is find-only by `logicalId` and `gitName`, production by default; `--name` and `--entry` work | **PASS** | Command tests assert the `gitName` query and the Branch used for the topology, and the Project chosen under `--name` and `--entry`. |
| AC7: Nothing deployed fails with `DEPLOY.TARGET_NOT_FOUND`, naming app and stage | **PASS** | Table test covers no Project, no Branch (message names `shop/pr-42`), 404 topology and empty topology. |
| AC8: Human table, tab-separated stdout, `--json` array with `null` | **PASS** | stdout test asserts the exact text; JSON test asserts the exact array with `null`s. The human-table test is loose (F06). |
| AC9: prisma-cli mounts `deploy list` | **NOT VERIFIED** | D3, not in this branch. |
| AC10: Design records and guides updated | **PASS** | ADR-0050 and ADR-0053 amendments, the ADR index, `deploy-cli.md`, `deploying.md`, `running-locally.md` and the skill all describe the command consistently with the code. |
| Done 1: Against a real deployed stage, every node has the right IDs and URLs | **NOT VERIFIED** | Production is covered by the e2e step once it runs in CI; a named stage is not covered anywhere yet (F04). D4 QA pending. |
| Done 2: The e2e workflow runs it after deploy and checks `--json` against the platform | **WEAK** | The step exists and checks order, IDs and URLs, but not kind (F01). It has not been seen running on a pull request yet. |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 9 | AC1–AC8, AC10 |
| FAIL | 0 | |
| NOT VERIFIED | 2 | AC9, Done 1 |
| WEAK | 1 | Done 2 |

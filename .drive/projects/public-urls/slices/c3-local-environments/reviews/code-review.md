# Code review — C3, each environment runs its own local copy

- **Branch:** `claude/local-environments`, range `origin/main...HEAD` (8 commits)
- **Spec:** [../spec.md](../spec.md)
- **Companion:** [system-design-review.md](system-design-review.md) (naming finding A01)

## Summary

The branch delivers what the spec asks: one folder per environment, a record with no `current` app, commands that act on the app and environment they are given, the environment label, the migration and the version check on `prisma dev`. Several edge cases break the claim that `--fresh` and the environment name isolate one copy from another. So does the version check against the dev prereleases that already shipped C2.

## What looks solid

- The record change is small and backward-tolerant. Format 2 reads as format 3 by dropping `current`, and the older formats still go through the full-address rewrite.
- `ensureBucketInstance` replaces a bucket instance whose directory moved, so migrated objects are served from the new folder. A test against the real bucket emulator reads an object back after the move.
- The `diff` change in `LocalDeploymentProvider` redeploys a service whose artifact is no longer unpacked. That makes deleting `artifacts/` during the migration safe for any app that runs `prisma dev` again (see edge 3 below).
- `requireContainerForEnvironment` moved to `shared.ts` and is reused unchanged, so deploy, destroy and dev refuse a mismatched extension the same way.
- `dev url` is proven not to import the entry: the test points `entry` at a file that does not exist, and the call still succeeds.
- The migration test runs against real emulators. It keeps a database row, the database's port and a bucket object across the move.

## Findings

### F01 — `--fresh` on an environment deletes the Alchemy state of every environment nested under its name

- **Location:** `packages/1-prisma-cloud/1-extensions/target/src/local-target/teardown.ts` — line 56
- **Issue:** Teardown runs `rm -rf .alchemy/state/<app>/<environment>`. Alchemy's local store (`alchemy/src/State/LocalState.ts`, `stageDir = path.join(stateDir, stack, stage)`) puts a stage named `feature/x` at `.alchemy/state/<app>/feature/x`, inside the folder of the stage `feature`. Alchemy itself is not confused by the nesting, because `list` reads only `*.json` files. But `prisma dev --environment feature --fresh` removes `feature/x`'s state too, while `feature/x`'s instances and record stay. The next `prisma dev --environment feature/x` sees every resource as new. Its generated values and service keys are minted again, and each provider runs a create against instances the record still holds. This breaks acceptance criterion 2's guarantee for any pair of names where one is a path prefix of the other. A git repository cannot hold both `feature` and `feature/x` as branches, but Composer checks each environment name on its own with `git check-ref-format`, so it accepts both. The current test asserts the removed path as a string, which is why this went unnoticed.
- **Suggestion:** Remove only the stage's own files: the `*.json` files directly in `.alchemy/state/<app>/<environment>/` (which include `__stack_output__.json`), then the folder if it is empty. Leave subfolders alone. Add a test that creates state for `feature` and `feature/x`, runs teardown for `feature`, and asserts that `feature/x`'s files remain. Alchemy's own `deleteStack` has the same nesting behaviour. That is upstream's concern, not this branch's.

### F02 — On a case-insensitive filesystem, `Dev` and `dev` are one copy

- **Location:** `packages/0-framework/1-core/core/src/control/app-config.ts` — line 376 (`devEnvironmentDir`); `packages/1-prisma-cloud/1-extensions/target/src/local-target/teardown.ts` — line 56
- **Issue:** `validateEnvironmentName` accepts `Dev`, and `encodeURIComponent` keeps its case. On macOS's default filesystem, `.prisma-composer/dev/Dev` is the same folder as `.prisma-composer/dev/dev`, and `.alchemy/state/<app>/Dev` is the same folder as `.alchemy/state/<app>/dev`. The record inside is keyed by app only, so `prisma dev --environment Dev` silently reuses `dev`'s instances and data. `prisma dev --environment Dev --fresh` deletes `dev`'s databases and objects. macOS is the main development platform, so this is a realistic typo. On Prisma Cloud, `Dev` and `dev` are distinct Branches, so the user has every reason to expect two copies.
- **Suggestion:** Write the environment's name into its folder: a field in the format-3 record, or a small marker file written on first use. Before teardown, preflight or emulators touch anything, refuse a run whose name differs from the recorded one, with a structured error that names both. This also covers the Alchemy folder, because the refusal comes first. Add a test that records `dev` and runs teardown and preflight with `Dev`. A cheaper alternative is to refuse locally any environment name that is not all lower case. That narrows names for one platform's sake, so the marker is better.

### F03 — After the upgrade, `dev url` and `dev stop` see nothing until `prisma dev` runs once

- **Location:** `packages/1-prisma-cloud/0-lowering/local-target/src/current-app.ts` — lines 81–98; the migration is called only from `local-target/preflight.ts` line 38 and `local-target/teardown.ts`
- **Issue:** The migration runs inside `prisma dev`, from preflight and teardown. `dev url` and `dev stop` go through the target's `current`, which reads `.prisma-composer/dev/dev/emulator-instances.json` and never migrates. Consider a developer whose app was started with `prisma dev --detach` under the previous version. They upgrade and run `prisma dev stop`. It fails with `DEV.NOT_STARTED_HERE` ("`prisma dev` has not run shop in the environment dev"), while the app's services and database servers keep running. The guide says `prisma dev stop` is the only thing that stops a detached app. `dev url` fails the same way for an app that is in fact running.
- **Suggestion:** Call `movePreEnvironmentDevState(directoryOf(devDir))` at the start of `currentApp`. It is idempotent, cheap, and already safe to run from any command. Add a test that copies the pre-environment fixture into a directory and asserts that `currentApp({ devDir: <dev folder>, app: 'shop', environment: 'dev' })` returns the fixture's addresses.

### F04 — The version check passes the 0.35.0 dev prereleases, whose local target ignores the environment

- **Location:** `packages/0-framework/3-tooling/cli/src/operations/shared.ts` — lines 152–182; called from `execute-dev.ts` line 195
- **Issue:** The check proves that an extension's container round-trips `environment`. C2 (#390) added that round-trip, and C2 shipped in `v0.35.0-dev.2` and `v0.35.0-dev.3` (`git tag --contains 3708c638`). Those extensions pass the check, but their local target predates C3:
  - its preflight writes secrets to the root folder `.prisma-composer/dev/`;
  - its teardown removes `.alchemy/state/<app>/dev` whatever the environment;
  - its `current({ devDir })` ignores the app it is asked for and returns the record's `current` app;
  - its emulators hook writes the record into the folder core passes it, which is now the environment folder.

  With this core and a dev.3 extension, `prisma dev --environment test --fresh` deletes `dev`'s Alchemy state, and the copies' files end up split between two folders. The spec added the check precisely so that "an older local target that ignores the name" is refused. The released 0.35.0 extension is refused correctly, because its container has no environment.
- **Suggestion:** Make the check prove the capability itself, not a proxy for it. For example, have the local-target descriptor declare that it keeps one copy per environment, through a field the C3 target sets, and have core refuse a local target without it, with `DEPS.EXTENSION_INCOMPATIBLE`. If the team decides the dev prereleases are not worth protecting, say so in the guide's upgrade note and in the spec, so it is a recorded choice. Either way, add a test with a descriptor whose container round-trips the environment but that lacks the new capability.

### F05 — No test runs two environments through `prisma dev` together

- **Location:** `test/integration/test/local-dev-detach.integration.ts`, `test/integration/test/local-dev.integration.ts` (only paths changed)
- **Issue:** Acceptance criteria 1–3 describe whole-stack behaviour: two `prisma dev` runs side by side, `--fresh` on one leaving the other's data, and neither stopping the other. Each layer is tested on its own: the record and providers against real emulators, the routing with fakes, and the hooks with mocks. But nothing runs the real pipeline twice in one directory. That is where the Alchemy state path, the stack file location and the environment variables of the two copies interact, and F01 lives in that seam. The plan leaves this to manual QA, which leaves nothing behind to catch a regression.
- **Suggestion:** Extend the detach integration test. Run `prisma dev --detach`, then `prisma dev --environment test --detach` in the same directory. Assert that `dev url <app>.<service>` and `dev url <app>.<service> --environment test` return different ports and that both answer. Write a row through `dev`. Run `prisma dev --environment test --fresh --detach` and assert that `dev`'s row survives. Then `dev stop --environment test` and assert that `dev` still answers.

## Implementer's flagged edges: verdicts

1. **`--fresh` on `feature` deletes `feature/x`'s Alchemy state.** Confirmed by reading Alchemy's `LocalState`. A real defect: F01.
2. **`Dev` and `dev` share a folder on a case-insensitive filesystem.** Confirmed, and the Alchemy state folder is shared too. A real defect: F02.
3. **The migration deletes `artifacts/` instead of moving them.** Not a defect. The compute emulator's deployment holds the absolute path of the old unpacked artifact, so moving the folder would break a restart just as deleting it does. Moving would also make it worse: the new `diff` would find the artifact unpacked and skip the redeploy, leaving the deployment pointed at a path that no longer exists. Deleting forces the redeploy on the next `prisma dev` of each app (tested in `emulator-instances.test.ts`, "a deployment whose artifact is no longer unpacked…"). What remains is a short window: a detached process the emulator restarts after a crash, before that app's next `prisma dev`. The part of this edge that does matter to users is that `dev stop` cannot see the detached app at all after the upgrade: F03.
4. **The migration always moves into `dev`, and skips when `dev/` already has a record.** Not a defect. Moving into `dev` is what the spec decides, and it matches Alchemy: earlier releases ran local dev as the stage `dev`, so `.alchemy/state/<app>/dev` already belongs to that copy. The move also happens on a first run of another environment, before that environment's own teardown, so `prisma dev --environment test --fresh` as the first run keeps `dev`'s data. The skip only happens after a downgrade-and-upgrade. In that case the root record is left in place and is checked again, cheaply, on every run. A one-line warning naming the leftover folder would help someone debugging, but it is not required.

## Deferred (out of scope)

- **`--fresh` removes the environment's shared `env.json` and `secrets.json`.** `removeAppDevState` keeps only the record and `buckets/`. So `--fresh` of one app removes the placeholder secrets and environment values of every other app in the same environment, and they are minted again on that app's next run. This existed before (per directory) and the branch narrows it to one environment. Fixing it means keying those files by app, which changes the target's store layout beyond this slice.
- **Preflight and teardown compute `devDir` themselves** instead of receiving it from core. See [system-design-review.md](system-design-review.md). Changing `PreflightInput` and `TeardownInput` is seam work beyond this slice.

## Already addressed

None. This is the first review round.

## Acceptance-criteria verification

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: `--environment test` runs beside `dev` of the same app in one folder, with its own ports, databases and bucket objects | **WEAK** | `emulator-instances.test.ts` "the same app in another environment gets its own instances and ports, and both run at once" asserts four distinct ids and ports across both environments, and that each answers with its own deploy, against the real compute emulator. `app-data-instances.test.ts` "the same app in two environments…" asserts distinct database ids and ports, an empty table set and an empty bucket in `test`, and the object only in `dev`'s folder. `local-target-preflight.test.ts` asserts that each environment keeps its own placeholders. `operations.test.ts` asserts that `--environment feature/x` routes the folder, stack file and Alchemy stage. No test runs two `prisma dev` pipelines together (F05). |
| AC2: `--environment test --fresh` deletes only `test`'s copy | **PASS** (for `test` and `dev`) | `app-data-instances.test.ts` "--fresh in one environment deletes only that environment's copy" asserts `test`'s database is gone and `dev`'s row survives. `emulator-instances.test.ts` asserts that another environment's services stay live. `local-target-teardown.test.ts` asserts the two removed paths. The guarantee fails for nested names (F01) and for names that differ only in case (F02). |
| AC3: a second app or environment stops nothing | **PASS** | `selectApp` is removed, and the emulators hook no longer stops anything. `emulator-instances.test.ts` "running another app in the same environment stops nothing already running" asserts the first app is still `running` and answering. `app-data-instances.test.ts` asserts both apps' databases are `running`. The environment case is covered under AC1. |
| AC4: `dev url shop.api` prints `dev`'s URL, `--environment test` gives `test`'s, and the entry is not imported | **PASS** | `dev-current.test.ts` "reads the app from the address and the environment's folder…" asserts the target is asked for `app: 'shop'` with `dev`'s folder, then `feature%2Fx`'s, while `entry` names a file that does not exist. `local-target-current.test.ts` asserts that the real target reads only the named app from that folder. `dev-current-commands.test.ts` asserts the command passes `--environment`. |
| AC5: `dev stop` stops the config's app in `dev`; `--environment` and `--name` select another; clear failure when nothing ran | **PASS** | `dev-current.test.ts` asserts the inputs `{ app: 'fixture-module', environment: 'dev' }` from the config's entry, and `{ app: 'other', environment: 'test' }` with `name` and `environment`. It also asserts `DEV.NOT_STARTED_HERE` with `meta: { app, environment }` and a fix that names `--environment test`. Right after an upgrade this failure is wrong (F03). |
| AC6: a folder from the previous version keeps its data as `dev` after one `prisma dev` | **PASS** (with F03) | `pre-environment-dev-state.test.ts` asserts the moved file list and the parsed record, env and secrets from a fixture. Against real emulators, it asserts that the database keeps its id, port and row, and that the bucket object is served from `dev`'s folder. `local-target-preflight.test.ts` asserts that secrets move and are reused. The test calls `movePreEnvironmentDevState` and `ensureAppInstances`, not the full `prisma dev`. The plan leaves an upgrade from the released CLI to manual QA. |
| AC7: `prisma dev` refuses an incompatible local target with `DEPS.EXTENSION_INCOMPATIBLE` | **PASS** (for 0.35.0) | `operations.test.ts` "refuses a local target extension that resolves another environment / cannot read its own container" asserts the code, the message and the fix, and that nothing ran after `ensure` (no teardown, preflight, emulators or Alchemy). The dev prereleases containing C2 pass the check but ignore the environment (F04). |
| AC8: `emulator list` shows each instance's environment | **PASS** | `emulator-list.test.ts` asserts the stderr view `gateway in /work/shop (dev)` and the piped line ending with the environment field (`feature/x`). `emulator-instances.test.ts` asserts the `composer.environment` label on created instances. |
| AC9: both decision records carry amendment notes; the local-dev doc describes the new behaviour | **PASS** | The amendments are dated 2026-10-28 on the per-folder record decision, the `dev url` / `dev stop` decision and the control subpath decision, and in the decision index. `local-dev.md` and `running-locally.md` describe the folders, `--environment`, the migration and the version check. A grep for "last ran", "current app" and "stops the previous" over `docs/`, `skills/` and `website/` finds only the decision records' historical text. Two claims in the amendments become true only once F01 and F02 are fixed. |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 8 | AC2, AC3, AC4, AC5, AC6, AC7, AC8, AC9 |
| FAIL | 0 | |
| NOT VERIFIED | 0 | |
| WEAK | 1 | AC1 |

Tests run during review: `pre-environment-dev-state.test.ts`, `teardown.test.ts`, `local-target-teardown.test.ts` and `local-target-current.test.ts`. All 23 pass.

# System design review — C3, each environment runs its own local copy

- **Branch:** `claude/local-environments`
- **Range:** `origin/main...HEAD` (8 commits, `26dbd403`..`fc6d28d5`; merge base is main at `05f42346`)
- **Spec:** [../spec.md](../spec.md), with [../plan.md](../plan.md)
- **Read before reviewing:** `CLAUDE.md`; `docs/design/01-principles/` (guiding and architectural principles); in full, the decision records the diff amends: the per-folder record decision (ADR-0052), the `dev url` / `dev stop` decision (ADR-0053), the control subpath decision (ADR-0043), the environment-naming decision (ADR-0059) and the full-address decision (ADR-0057). Also the C2 slice spec, because this slice reuses its extension version check.

## What changes in the system

Before this branch a directory had one local copy of each app. `.prisma-composer/dev/` held one record for the directory, and the record named a `current` app. Running a second app stopped the first. `dev url` and `dev stop` acted on whatever ran last.

After it, an environment name selects a complete local copy:

- Core owns the folder layout. `devEnvironmentDir(environment)` in core gives `.prisma-composer/dev/<encodeURIComponent(environment)>`. Core passes that folder as `devDir` to the target's `emulators`, `attach` and `providers` hooks, writes the generated stack file there, and passes the environment to Alchemy as its stage.
- The Prisma Cloud local target keeps one record per environment folder, keyed by app and node. The record has no `current` app. `selectApp`, which stopped the previous app, is gone.
- The seam's `current` hook now takes `{ devDir, app, environment }` and answers for that app only.
- `dev url` reads the app from the first segment of the address and imports no module. `dev stop` resolves the app the way `prisma dev` does.
- Instances get a `composer.environment` label, for display only. `emulator list` prints it as the last field.
- A one-time migration in the target moves a pre-environment folder into `dev/`.
- `prisma dev` now runs C2's extension version check.

The new guarantee: a command's target depends only on its arguments and the config, never on history. This matches the spec and the amendment notes.

## Subsystem fit and boundaries

- **Core stays target-agnostic.** Core knows an environment name and a folder. It never reads the record. The record format, labels, migration and bucket layout stay in `@internal/local-target` and the Prisma Cloud extension. That fits the principle that targets own their specifics.
- **Dependency direction is unchanged.** `@internal/local-target` imports `devEnvironmentDir` from `@internal/core/config`, which is downward. The extension imports from both. Nothing new crosses a layer upward.
- **Asymmetry in who computes `devDir`.** Core passes `devDir` to `emulators`, `attach` and `providers`. The target's `preflight` and `teardown` compute it themselves, as `process.cwd()` plus `devEnvironmentDir(environment)`. This existed before (they used `DEV_DIR`), but now two places derive the same path from the same rule. It is consistent today. If core ever changes the layout, the two will drift. Not filed as a finding: changing `PreflightInput` and `TeardownInput` is seam work beyond this slice. Recorded here so a later seam change can pick it up.
- **The migration lives in the target, but it also removes a core-owned file.** `movePreEnvironmentDevState` deletes `alchemy.run.ts`, which core's `generate-dev-stack.ts` writes. Core writes that file again into the environment folder on every run, so deleting the stale root copy is harmless. But the target is cleaning up after core. That is acceptable for a one-time migration that is marked for deletion.
- **The migration runs from `preflight` and `teardown`, not from `current`.** So `dev url` and `dev stop` see an unmigrated folder as empty. This is a correctness defect with an operability cost, filed as F03 in [code-review.md](code-review.md).

## Naming and vocabulary

- **"Environment"** is used everywhere the spec and the environment-naming decision require: the flag, the inputs, the label, the folder and the messages. Alchemy's word, "stage", appears only where Composer hands the name to Alchemy (`stage: environment` in `alchemyInvocation`). That matches the decision's rule that engine vocabulary stays in engine-facing code.
- **"Local copy"** is the spec's term for one app in one environment. The docs, the doc comments and the messages use it consistently.
- **The `current` name no longer means anything (finding A01).** The seam member `LocalTargetDescriptor.current`, its types `LocalTargetCurrentInput` and `LocalTargetCurrentApp`, the target's `currentApp()` and `current-app.ts`, and the CLI's `execute-dev-current.ts` and `dev-current.ts` all keep the word "current". The concept behind it, the app that ran last, is exactly what this slice removes. A reader who opens the seam now sees `current({ devDir, app, environment })` and has to read the doc comment to learn that it does not return "the current app". The amendment to the `dev url` / `dev stop` decision keeps the name on purpose: it says `current({ devDir })` "becomes a lookup that takes the app and the environment". A rename would amend that note.
  - *Suggestion:* rename the member to `localCopy` and the types to `LocalTargetCopyInput` and `LocalTargetCopy`, using the spec's own term, and update that amendment note to say so. The member is optional and internal to the seam between core and target packages released together, so no public surface breaks. If the team prefers to keep the name, the amendment note should say so explicitly, so the next reader knows it was a choice and not an oversight.
- **`appScopeOf` lives in `app-name.ts`.** The file now holds the function that builds the app-and-environment scope. A small mismatch between file name and content. Not filed separately; it can travel with A01.
- **Label `composer.environment`.** It is display-only, like the other labels, and nothing reads it back. That keeps the per-folder record decision's rule that the record, not the labels, is the only mapping. Correct.

## Decision records

- **The per-folder record decision's amendment** accurately describes the new layout, the format change and the migration. It also states plainly that it reverses the rule that local state is never migrated, citing the full-address decision as precedent. Good.
- **Two claims in the amendment are not true in every case.** "`--fresh` deletes only the copy of the app in the environment it runs" fails for an environment whose name is a path prefix of another (`feature` and `feature/x`, see F01). It also fails for names that differ only in letter case on a case-insensitive filesystem (`Dev` and `dev`, see F02). The fixes belong in code. The amendment should then state the rule that makes the claim true, for example that names differing only in case are refused locally.
- **The `dev url` / `dev stop` decision's amendment** and **the control subpath decision's amendment** match the code: `environment` defaults to `dev`, `dev url` takes the app from the address, and `dev stop` uses the entry or `--name`.
- **The decision index** entries were updated with the same content.

## Test strategy at the architectural level

The property that matters is isolation: two copies (same app, different environment) never share an instance, a port, a file or Alchemy state, and a command aimed at one never touches the other. The branch proves isolation at three layers:

- record and providers, against real emulators (`emulator-instances.test.ts`, `app-data-instances.test.ts`);
- routing, in core's operation tests (`operations.test.ts`, `dev-current.test.ts`);
- target hooks (`local-target-preflight.test.ts`, `local-target-teardown.test.ts`).

What is missing is the property across the whole stack. No automated test runs two `prisma dev` processes at once, and the Alchemy state path is only asserted as a string. A string assertion is exactly where F01 hides. See F05 in the code review.

## Out of scope for this pass

Failure modes, migration edge cases and acceptance-criteria verification are in [code-review.md](code-review.md). Whether the guide teaches the feature well to a new reader is a developer-relations question and was not reviewed here.

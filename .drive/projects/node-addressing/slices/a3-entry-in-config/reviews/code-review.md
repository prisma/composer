# Code review — A3, deploy's entry file lives in the config

Branch `drive/deploy-entry-in-config`, range `origin/main...HEAD`, 4 commits, 68 files. Reviewed against the slice [spec](../spec.md) and [plan](../plan.md), design note 6, and ADR-0003, ADR-0044, ADR-0049 and ADR-0050 as amended on the branch. Prisma CLI source read in `wip/prisma-cli` where needed.

Settled and not reopened: the entry is an input to the tool, not an application fact; the config's `entry` resolves against the config file's directory and `--entry` against the cwd; the positional is removed and the engine's own "Too many arguments" error is kept.

## Summary

The code is correct. One function, `resolveEntryPath` (`cli/src/pipeline.ts` lines 85–99), decides the entry for every command and operation:
- an override resolves against `cwd`;
- the section's `entry` resolves against the directory of the config file, which `checkConfigSource` has already made absolute;
- with neither, it raises `CONFIG.ENTRY_MISSING`.

The Alchemy child gets the absolute path from `loadEntry`, so it does not depend on the child's working directory. CI, the scripts and the package scripts all moved.

What remains is in the docs:
- two copy-paste commands still pass `module.ts` and now fail (F01);
- four decision records still state `prisma deploy <entry>` or show `prisma dev module.ts` as the current form (F02);
- there is no upgrade note for users whose config has no `entry` (F03).

## What looks solid

- **One resolution rule, used everywhere.** `runPipeline` (deploy, destroy and dev, including dev's rebuild on change, `execute-dev.ts` lines 82 and 320) and `resolveAppIdentity` (log) both call `resolveEntryPath`. The section's `entry` resolves against `path.dirname` of the file `checkConfigSource` resolved against `cwd`, so a relative `config.file` from a script also works.
- **The Alchemy child.** `generate-stack.ts` and `dev/generate-dev-stack.ts` take `entryPath` from `LoadedEntry.path`, which is absolute.
- **The section check.** `entry` is in the allowed keys. A non-string or empty value gives `CONFIG.FIELD_INVALID` with `field: 'entry'`, and the unknown-field messages list `entry`. Tests: `entry-path.test.ts`.
- **The commands.** `deploy` and `dev` take `--entry` and no positional. The family test runs `deploy module.ts` and `dev module.ts` and asserts exit 2, the engine's "Too many arguments" message, and that no operation was called.
- **The operations.** `entry` is optional on deploy, destroy, dev and log. Two tests cover the new behaviour: an operation test runs `deployWithDeps` from another cwd with a config `entry` and reaches Alchemy, and a missing-entry test asserts `CONFIG.ENTRY_MISSING` and that Alchemy never ran.
- **Callers moved.**
  - Every example's `prisma.config.ts`, the website and the local-dev fixture have `entry`.
  - The package scripts, the `deploy-verify-destroy` action, `deploy-docs.yml` and `destroy-guard.sh` (now two arguments) no longer pass a positional, and nothing calls `destroy-guard.sh` with three.
  - `composer-destroy.ts` takes `--entry` and refuses positionals.
  - The integration tests pass `--entry` or rely on the fixture's config.
- **ADR-0044** registers `CONFIG.ENTRY_MISSING`. ADR-0049 and ADR-0050 match the code.

## Findings

### F01 — Two documented commands still pass `module.ts`, which now fails

- **Location:** `docs/guides/deploying.md` line 67; `skills/prisma-composer-core-concepts/SKILL.md` line 362.
- **Issue:** Both show `bun node_modules/prisma/dist/prisma.js deploy module.ts`. That now exits 2 with "Too many arguments". The skill is what agents copy from.
- **Suggestion:** Drop `module.ts` from both. Re-run the plan's `git grep` with a pattern that matches this form, for example `deploy module.ts`, not only `prisma deploy <file>`.

### F02 — Four decision records still give the positional as the current command

- **Location:**
  - ADR-0024 line 3 and ADR-0041 line 3, the ADR-0050 amendment notes: "deploys run as `prisma deploy <entry> …`" and "the command is `prisma dev <entry>`";
  - ADR-0053 lines 12 and 18 (`prisma dev module.ts`, `prisma dev module.ts --detach`);
  - ADR-0056 line 52 (`prisma dev module.ts`);
  - the index entries for ADR-0041 (`docs/design/90-decisions/README.md` line 65) and ADR-0024.
- **Issue:** Agents treat these records as binding. ADR-0053 and ADR-0056 are recent and show the command as it is used now. ADR-0024 and ADR-0041 state the command shape in their own amendment notes. Only ADR-0003, ADR-0049 and ADR-0050 were amended.
- **Suggestion:** Add a one-line amendment note to each of the four, as the branch does for ADR-0003: "Amended 2026-10-23: `prisma dev`/`prisma deploy` take no positional entry; the entry is `entry` in the `composer` section, or `--entry` (ADR-0050)." Leave the bodies unchanged, and update the two index entries. This keeps each record's history and stops it reading as current.

### F03 — No upgrade note for an existing project

- **Location:** `docs/guides/deploying.md` and `docs/guides/getting-started.md` (no upgrade section).
- **Issue:** A user who upgrades and runs `prisma deploy module.ts` gets the engine's "Too many arguments, expected 0", which does not say where the entry went. Running `prisma deploy` without adding `entry` gives `CONFIG.ENTRY_MISSING`, which does. Keeping the engine's error is settled, so the guide is the only place that can connect the two.
- **Suggestion:** Add a short "Upgrading" paragraph: the positional entry is gone; add `entry: './module.ts'` to the `composer` section, or pass `--entry`.

### F04 — The guide says the commands "find it from any directory", but `prisma dev` keeps its record in the directory it runs in

- **Location:** `docs/guides/deploying.md` line 104.
- **Issue:** The entry is now found from a subdirectory too, because the engine uses the nearest `prisma.config.ts`. But `prisma dev` keeps its record of emulator instances, its bucket data and the state `prisma dev url` reads under `<cwd>/.prisma-composer/dev` (`execute-dev.ts` line 75; ADR-0052). Running it from a subdirectory starts a second, empty local copy of the app.
- **Suggestion:** Say that `prisma deploy` works from any directory, and that `prisma dev`, `dev url` and `dev stop` should be run from the same directory each time, normally the one holding `prisma.config.ts`.

### F05 — `CONFIG.ENTRY_MISSING` tells an API caller to pass `--entry`

- **Location:** `packages/0-framework/3-tooling/cli/src/composer-config.ts` lines 127–134.
- **Issue:** The same finding is raised for the operations, where the override is the `entry` input. The test asserts the CLI wording for `deployWithDeps`.
- **Suggestion:** Say "or pass `--entry <path>` (the `entry` input when calling `@prisma/composer/control`)".

### F06 — A wrong `entry` path fails without saying where the path came from

- **Location:** `packages/0-framework/3-tooling/cli/src/load-entry.ts` lines 38–42.
- **Issue:** `COMPOSE.ENTRY_UNLOADABLE` gives "Failed to import entry module "/abs/…": Cannot find module…" with no fix. Before this slice the user had just typed the path. Now it usually comes from a file they may not be looking at.
- **Suggestion:** Have `resolveEntryPath` return where the path came from, and add a fix naming it. For example: "Check `entry` in /path/prisma.config.ts (relative to that file)", or "Check the `--entry` path (relative to the current directory)".

### F07 — `composer-destroy.ts` says both entries resolve against the current directory

- **Location:** `scripts/composer-destroy.ts` lines 8–9.
- **Issue:** The section's `entry` resolves against the config file's directory. That matters when `--config` names a file somewhere else.
- **Suggestion:** "The entry is the section's `entry`, relative to the config file, or `--entry`, relative to the current directory."

### F08 — ADR-0050's amendment names only `destroy` and `log` as having an optional `entry`

- **Location:** ADR-0050 line 3.
- **Issue:** All four operations have it, as ADR-0049's amendment says.
- **Suggestion:** "The operations' `entry` input is optional and overrides the config's."

## Deferred (out of scope)

- `prisma dev` watching the entry file, and re-reading `entry` when the config changes during a session. The spec excludes both.

## Acceptance-criteria verification

| AC | Verdict | Detail |
| --- | --- | --- |
| The section takes an optional non-empty `entry`; `CONFIG.FIELD_INVALID` otherwise | **PASS** | `composer-config.ts` `checkFields`; `entry-path.test.ts` checks `''`, `42` and an array. |
| The config's `entry` resolves against the config file's directory; `--entry` against cwd | **PASS** | `resolveEntryPath`; unit tests, plus `operations.test.ts` running from another cwd and reaching Alchemy. |
| `deploy`/`dev` lose the positional and gain `--entry`, which wins | **PASS** | `commands/deploy.ts`, `dev.ts`; the family tests pass `--entry` through and leave it undefined without the flag. The precedence itself is tested in `resolveEntryPath`. |
| The operations' `entry` is optional and overrides the config | **PASS** | Types and `resolveEntryPath`; operation test for the config path. |
| No entry fails before any work with `CONFIG.ENTRY_MISSING`, naming both sources | **PASS** (F05) | Operation test asserts the code and fix text and that Alchemy did not run. |
| A leftover positional is not silently ignored | **PASS** | Family test asserts exit 2 and "Too many arguments" for `deploy` and `dev`. The engine's error is the accepted outcome; say so in the PR. |
| Every repo caller moved | **WEAK** | Code, CI, scripts and package scripts moved. Two documented commands did not (F01). |
| The Alchemy child gets an absolute entry path | **PASS** | `LoadedEntry.path`; `generate-stack.test.ts`, `stack-file-import.test.ts`. |
| ADR-0003, ADR-0049, ADR-0050 amended; ADR-0044 lists the code; domain docs, guides, skill, gotchas | **WEAK** | Done as listed, but ADR-0024, ADR-0041, ADR-0053 and ADR-0056 still state the positional (F02). |
| A real deploy of one example from its config's entry | **NOT VERIFIED** | QA (D4) not run. |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 7 | field check, resolution, commands, operations, missing entry, leftover positional, absolute path |
| WEAK | 2 | repo callers, design records |
| NOT VERIFIED | 1 | real deploy |
| FAIL | 0 | |

---

# Round 2

Commits `a7184afe`, `1bdd405f` on top of `45236626`. **Verdict: SATISFIED.**

| Finding | Status | Evidence |
| --- | --- | --- |
| F01 positional in two commands | Fixed | `deploying.md` and `SKILL.md` show `… prisma.js deploy`. A repo-wide `git grep` for `deploy module.ts`, `dev module.ts`, `deploy <entry>` and `dev <entry>` now finds four kinds of hit: ADR bodies kept as history under their new amendment notes, the upgrade note (deliberate), and the retired-binary lint test's fixtures. |
| F02 records not amended | Fixed | ADR-0024, ADR-0041, ADR-0053 and ADR-0056 carry an amendment note that cites ADR-0050. The ADR-0024 and ADR-0041 index entries mention it. |
| F03 no upgrade note | Fixed | `deploying.md` quotes the engine's error for `prisma deploy module.ts` / `prisma dev module.ts` and gives both fixes. |
| F04 "from any directory" | Fixed | The guide now limits the claim to `prisma deploy` below the config, and says to run `prisma dev`, `dev url` and `dev stop` from one directory. |
| F05 missing-entry fix text | Fixed | The fix names the `entry` input for `@prisma/composer/control`; the test asserts the new text. |
| F06 unloadable entry | Fixed | `resolveEntryPath` returns the path and a fix that names its source: the config file and its `entry` value, or the `--entry` value and the cwd. `loadEntry` adds it to `COMPOSE.ENTRY_UNLOADABLE`. A new operation test asserts both texts. The JSX and default-export errors keep their own fixes, which is right. |
| F07 `composer-destroy.ts` header | Fixed | |
| F08 ADR-0050 operations list | Fixed | It names all four operations. |

QA (D4) is still outstanding for the real-deploy criterion.

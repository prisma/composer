# Module input — handover, 2026-10-30

You are taking over the `module-input` project in the Prisma Composer repo (`prisma/composer`), driven with the Drive process (`/drive-process`). The previous agent was `achilles-41`. Will Madden owns the design decisions; you execute.

**Full context:** the previous session's transcript is at
`/Users/will/.claude/projects/-Users-will-Projects-prisma-composer--claude-worktrees-composer-destroy-discussion-56c939/317df755-698a-4d7b-9496-960bf26f0356.jsonl`. It is long; search it for a topic rather than reading it end to end. Earlier in the same session the agent also delivered the public-URLs project's local-environments slice (prisma/composer#392).

## Read first

1. `CLAUDE.md` in the repo and Will's global instructions. They are binding: read the design docs before any design discussion, plain English, no coined terms, never call a constraint a "rule" unless Will does, commit as the `wmadden-electric` bot with two sign-offs and **no Co-Authored-By line**, push through the `bot` remote, open PRs without asking, turn on Auto-fix, merge only after Will approves.
2. `.drive/projects/module-input/design.md`: the authoritative design, settled with Will. Its section 2 lists the four requirements.
3. `.drive/projects/module-input/plan.md`: every slice and where it stands. `spec.md` is the project definition of done. `design-notes.md` only points to `design.md`.
4. The rewritten decision record `docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md`: one current record, no amendment notes. Will wants decision records written holistically like that, never as stacked amendment notes.
5. The slice specs under `.drive/projects/module-input/slices/`, for how detailed a spec must be. Will's requirement: a spec leaves the implementer no creative freedom.

## What the project is

A module declares its configuration as one Standard Schema, `input`, exactly as a `compute()` service does. Its body gets one value per field, which it can pass on or list in `resolve()`, never read. The root module's input is filled by **config adapters** named in `prisma.config.ts` (`config: [dotenv(), environmentVariables()]`); **secrets adapters** (`secrets: [...]`) fill missing `envSecret()` platform variables. Both lists default to `[environmentVariables()]`. Sources (`envParam()`, `envSecret()`, `generatedParam()`, `serviceOrigin()`) are values. A field that may receive a value known only at boot is wrapped in `field()` (`@prisma/composer/arktype` or `@prisma/composer/zod`); a plain field accepts deploy-time data only and is the only kind `resolve()` can compute with. Schemas are checked at deploy with real pointers in place of runtime values.

## Where it stands

| Slice | What | State |
| --- | --- | --- |
| S1 | Spike on typed input values | Done (report in `slices/s1-spike/`) |
| S2 | `module()` takes `input` | **Merged**: prisma/composer#401 (0b4297a6) |
| S3–S8 | Sources are values; config/secrets adapters and root input; old slots removed; `field()` and pointer kinds; schemas see pointers at deploy; `resolve()` deploy-time only | **One PR, prisma/composer#403**, branch `claude/module-input-s8`. Will **approved** it and said to merge it once CI passes. When this was written, 14 checks passed and 5 were still running (the Test jobs and the deploy check). |
| S9 | `input` is a dictionary: no module may pass its whole `input` on | Not specified. Branch `claude/module-input-s9`, stacked on #403's branch, holds one commit: the design and plan rename to "app configuration". |
| S10 | A service's `input` binding typed from its schema | Not started |
| S11 | `dotenv()` delegates to `dotenv-flow` | Not started |
| S12 | The second process reads a configuration file; rename "pool" to "app configuration" / "app secrets" everywhere | Not started |
| S13 | Redact every known secret value, at any length | Not started |
| S14–S17 | `prisma dev` watches inputs; local secrets never reach another environment; secrets get their own home; `secretString()` becomes `secret(schema)` | Each is designed **with Will** before it is specified |

**Your first job:** check #403. If every check passes, squash-merge it with `gh pr merge 403 --repo prisma/composer --squash` and a hand-written subject and body that contain **no Co-Authored-By lines** (many commits on the branch carry them; the squash message must not). If a check fails, fix it on `claude/module-input-s8` and push. Will said to stop after that merge; continue with S9 only when he tells you to.

**After that,** each slice follows the same loop:
1. Write its spec with an Opus agent, verified by probes on a scratch copy.
2. Build it with an Opus agent.
3. Review it with `/drive-code-review`, without the walkthrough.
4. Fix the findings.
5. Do manual QA, against Prisma Cloud where the slice touches deploys.
6. Open a PR.

Rebase S9's branch onto main after #403 merges. Pass `model: opus` explicitly on every agent.

## Decisions Will made that are easy to get wrong

- **"App configuration" and "app secrets"** name the merged values of the config adapters and the secrets adapters. "App" is Composer's word for the application, the outermost module. Prisma Cloud's "App" label never constrains Composer's terms. The code still says "config pool" until S12 renames it.
- **`envParam()` stays deploy-time.** In a service's input it is read at deploy and written into the input document. Making it a runtime pointer would break every existing app. It gets deprecated later.
- **`environmentVariables()` returns the whole process environment.** No special cases, no filtering of credentials.
- **Redaction covers every secret value Composer knows, at any length.** Under the default lists that is the values under names an `envSecret()` names. With a project's own secrets list, it is everything that list returns.
- **Inputs are always truthy `Value` objects.** Will does not want to hear about branching on them.
- **Out of scope by Will's ruling:**
  - `dotenv-flow` skipping `.env.local` for `test`;
  - `destroy` needing a valid configuration;
  - `KEY=` giving `''`;
  - a developer's `.env.local` secret reaching production (that is S15).
- **Never commit code-review artifacts.** `.gitignore` ignores `.drive/**/reviews/`. Write reviews outside git or let the ignore cover them.

## Branches and worktrees

All worktrees live under `/Users/will/Projects/prisma/composer/.claude/worktrees/composer-destroy-discussion-56c939/`. `wip/s3`–`wip/s9` hold the slice branches. `claude/module-input-s3` to `-s7` are superseded by `claude/module-input-s8` (#403); delete them after #403 merges. `claude/module-input` is merged.

Credentials for deploy QA are in `~/.config/prisma-compose/deploy.env`. Print only variable names, never values; use `PRISMA_REGION=us-east-1`. Machine-wide emulators live in `~/.prisma-composer/emulators/`. Never start one from a scratch folder that gets deleted.

## Open items for Will at close-out

- Fold the amendment notes on the other decision records this project touched (module input, module boundary, secrets, params, service input, config section, dev secrets) into holistic rewrites, as was done for the `resolve()` and config adapters record.

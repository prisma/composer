# Handover: Compute composition (keep the previous version of a Compute service)

Written 2026-11-20 by the session named hodgkin-12, which was about to be rate limited. You are taking over the whole project, not one task.

## Read these first

1. This file.
2. [design.md](design.md): the settled design. It is the specification.
3. [plan.md](plan.md): the four pieces of work and the standing decisions.
4. The previous session's full transcript, for anything this file does not explain: `/Users/will/.claude/projects/-Users-will-Projects-prisma-composer--claude-worktrees-s3-closeout-handover-2ba967/047a0842-4c8c-4e4e-89e7-ef143e0a33c7.jsonl`. It is large. Search it; do not read it whole.
5. Will's global instructions in `/Users/Shared/claude-shared/CLAUDE.md` and the memory index at `/Users/will/.claude/projects/-Users-will-Projects-prisma-composer/memory/MEMORY.md`. Several memories were written during this project and they are binding.

## The problem

Composer's `prisma deploy` deletes the previous version of a Compute service on every deploy. Prisma Cloud's rollback then has nothing to return to. Will considers it a bug.

The cause is upstream. Alchemy's `Prisma.Compute` (repository `alchemy-run/alchemy`, package `packages/prisma`, published as `@alchemy.run/prisma`) was one resource with its own Management API code, and its replacement deleted the old version. Composer could not use `Prisma.Compute` and used the low-level `Prisma.App` and `Prisma.Deployment`, which had the same behaviour.

## What Will decided

- Fix it upstream, the way the Alchemy team wants, following their conventions. Composer and other Alchemy users must run the same code.
- Three platform resources: `Prisma.ComputeService` (holds a pointer to its active version; promoting means changing that pointer), `Prisma.ComputeVersion` (exactly one immutable version) and `Prisma.EnvironmentVariable` (one per key). `Prisma.Compute` composes them, plus `Prisma.ComputeArtifact` for the build.
- No promotion resource. No `active` flag on the version. Will rejected both; do not propose them again.
- Names use the platform's words, Service and Version, with the `Compute` prefix. The platform team is separately renaming its API to match, and that API stays backwards compatible, so this work does not wait for it.
- Replaced versions are kept through Alchemy's default removal policy `retain` on `Prisma.ComputeVersion`.
- What the platform does with the previous version after a promotion is the platform's concern.
- A platform object is found by its `logicalId` or a stored ID, never by its name.
- One pull request to Alchemy for the whole change. None to Distilled.
- Other Alchemy users' code need not stay compatible. Their deployed services must not be damaged. The Alchemy pull request must say every breaking change plainly.
- Stacks deployed with the old monolithic `Prisma.Compute` are refused with the error `ComputeCannotUpgradeInPlace` and nothing is changed, until the Alchemy maintainers say how many people use the Prisma provider.

## Where everything is

| Thing | Location | State |
| --- | --- | --- |
| The Alchemy pull request | https://github.com/alchemy-run/alchemy/pull/3522, opened by Will, a draft | Waiting for the maintainers' review. No review or comment yet on 2026-11-20. |
| The Alchemy branch | `feat/prisma-compute-composition` on the fork `wmadden-electric/alchemy`, head `7dad777c3` | Pushed. |
| The Alchemy checkout | `/Users/will/Projects/prisma/composer/.claude/worktrees/s3-closeout-handover-2ba967/wip/alchemy-compute`, remote `bot` | Clean. In a fresh worktree, clone the fork again into `wip/`. |
| The Composer change that keeps previous versions | Branch `feat/compute-keeps-previous-versions` on `prisma/composer` (pushed through the `bot` remote), head `3116de5c`, 8 commits, based on an old main (`62a32612`) | Pushed. No pull request. Must not be opened yet. |
| This Drive project | Branch `claude/composer-compute-versions-deletion-f8d240` on `prisma/composer`, folder `.drive/projects/compute-composition/` | Pushed. No pull request; it rides along with the Composer change. |
| Review artifacts | `.drive/projects/compute-composition/reviews/` in the old worktree only | Local and ignored by git. Never commit them. |
| Read-only QA scripts and reference clones | `wip/qa/`, `wip/pdp-control-plane`, `wip/pdp-metal`, `wip/ignite`, `wip/prisma-cli` in the old worktree | Not checked in. Clone again if needed. |

Files in this folder: `alchemy-pr-title.txt` and `alchemy-pr-description.md` (the text of the pull request), `alchemy-questions-for-maintainers.md`, `alchemy-compliance-audit.md` (the branch checked against 79 of Alchemy's written rules), `qa-report.md` (twelve manual scenarios), `composer-proof.md` (Composer on the new resources, on the real platform), `platform-stuck-stopping-report.md` (a platform outage from 2026-11-16 to 11-18), `research/`, and `slices/alchemy/plan.md`.

## The four pieces of work

A. **The Alchemy change.** Built, reviewed step by step, manually tested, and open as the draft pull request above.

B. **Composer keeps previous versions.** Built on the branch above and proven on the real platform: deploy, change, deploy, roll back in the Console; and an upgrade from today's Composer in one deploy with the same service IDs, URLs, database and environment variables, with every request returning 200. It waits for piece A to be merged and released.

C. **Composer declares `Prisma.Compute`** in place of the low-level resources. Not started. After B.

D. **An unchanged deploy creates no new version.** Today, on Composer's main, a service that reads another service's URL gets a new version on every deploy. A fix exists as commit `dde80b76` on the piece B branch. It needs its own pull request with a test. Nobody has checked whether it works on Composer's main before the Alchemy release. Will has not yet said to start it; the last message recommended it and he did not answer.

## What is open right now

1. **The checks on the pull request's latest commit have not run.** GitHub holds them as "action required" because the bot pushed the commit and the bot is a first-time contributor there. Will can close and reopen the pull request, or a maintainer can approve the run. This repeats on every push by the bot. On the commit before the merge, "Check" passed, and "Publish preview packages" failed only because the branch was behind main; the merge of main fixes that. Locally, on the merged commit, the type check, format check, export check and all 386 Prisma unit tests pass.
2. **About 55 test cases run against a fake Management API with no good reason.** Alchemy's `AGENTS.md` forbids fakes, and the maintainer Sam Goodwin asked Will directly, on pull request 2696 (custom domains on any Branch), to stop sending them. About 20 more fake-based cases test platform failures that cannot be caused on the real platform, and that reason holds. Converting the 55 is estimated at three to five days. Will has **not** approved that work. Do not promise it for him, in a description, a comment or a draft message. Expect the maintainers to raise it.
3. **Eight live tests were never run**: five need a Neon key, three need Cloudflare credentials. Will has neither.
4. **The live pull request description differs slightly from the file.** Will edited it by hand. At the top of "Breaking changes" his two bullets lost their code formatting and one sentence is repeated. The file has the corrected text.
5. **Will sent the maintainers a Slack message** introducing the pull request. It names the breaking changes and the fake-based tests. Answers may arrive in Slack, where you cannot see them.
6. **A background check** in the old session watched for a review. It ends with that session. Start your own: a background command that waits until a maintainer reviews or comments, or the pull request merges or closes. The app refused to bind its Auto-fix watcher to this pull request.

## What to do next

1. Start the background wait on the pull request.
2. When the maintainers review, fix what they ask on the Alchemy branch. Bring Will only questions about the design. Merge main in; never rebase or force-push.
3. When piece A is merged and released: bring the piece B branch up to date with Composer's main, remove the three `pnpm.overrides` that point at local tarballs (they are in `wip/alchemy-tarballs/` of the worktree `compute-keep-versions` and are not checked in), set the catalog in `pnpm-workspace.yaml` to the released Alchemy version, and open the Composer pull request. The version bump and the Composer change must land in one pull request, because Composer names `Prisma.App` and `Prisma.Deployment`, which the new Alchemy version removes.
4. Piece D, if Will says to start it.

## Rules that caused trouble in this project

- **Pushing and identity.** Act as the bot `wmadden-electric`. Push only through the remote named `bot`. Commit with `git commit -s --trailer "Signed-off-by: Will Madden <madden@prisma.io>"`. Never add a co-author line. The bot cannot open or edit pull requests on `alchemy-run`; Will does that from his own terminal, and the app's Run button uses the bot's shell, so a `gh pr edit` there fails.
- **Alchemy's own rules.** Before any change in the Alchemy checkout, read its `AGENTS.md` and `.agents/skills/alchemy-provider/SKILL.md` with `review.md` and `docs.md`. Its rules for pull request descriptions: conventional-commit title, plain summary first, no heading above `###`, code before prose, no test plan, no list of outstanding work.
- **Real-platform credentials** are in `~/.config/prisma-compose/deploy.env`. Load them with `set -a; . ~/.config/prisma-compose/deploy.env; set +a`, set `CI=true`, use region us-east-1, and never print the values.
- **The QA account.** Delete only what a run created, by the ID it created. Never delete by name or from a listing, and never run an account-wide cleanup. Nine projects left over from the outage are stuck; use fresh stage names and leave them alone.
- **Tests.** Never run the full integration suites locally. Run only the files for the change.
- **This machine.** Since a crash on 2026-11-19, `pnpm` 12.15.0 fails to start with `ENOEXEC`. A working launcher is `node /Users/will/Library/pnpm/.tools/pnpm/12.15.0/node_modules/pnpm/bin/pnpm.mjs`; put a small wrapper script named `pnpm` first on `PATH` so the repository's commit hook can run. Do not skip the hook.
- **Talking to Will.** Plain English, short, full sentences. One question per message. Never name a thing by a label you coined or by a number alone. Never state a decision as Will's unless he made it. Asked what a problem is, describe it and stop. No question boxes and no buttons for design decisions.

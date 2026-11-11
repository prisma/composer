# Handover: Alchemy in process (`alchemy-programmatic-api`)

Written 2026-11-11 by maat-73, at a rate-limit break. Previous session's full transcript (read it for any detail this brief lacks): `/Users/wmadden/.claude/projects/-Users-wmadden-Projects-prisma-composer--claude-worktrees-composer-issue-191-033e6e/f959da3b-bf5f-4f06-9416-edab3001f618.jsonl`. It is long; search it rather than reading it end to end.

## What the project is

Composer used to deploy and run dev by generating `.prisma-composer/alchemy.run.ts` and spawning the `alchemy` CLI as a child process. This project replaces that with Alchemy's in-process programmatic API, `alchemy/Alchemist` (`plan` / `apply`), called from the `prisma` process. Deploy first, then dev. Destroy is out of scope and still uses the child process.

Read first, in this folder: `spec.md`, `plan.md`, `design-notes.md`, `slice-1-spec.md` to `slice-4-spec.md`, `deferred.md`, `upstream-asks.md`, and `reviews/`. In the repo: `docs/design/01-principles/`, ADR-0064 (deploy runs Alchemy in process, amended for dev), ADR-0056 (dev rebuild behaviour), ADR-0005 / ADR-0047, `docs/design/10-domains/deploy-cli.md` and `local-dev.md`. The repo's `CLAUDE.md` requires reading the design docs before any design discussion.

## The PRs

| PR | Branch | What it does | State on 2026-11-11 |
|---|---|---|---|
| prisma/composer#404 | `claude/alchemy-api-evaluation-5f1d17` | Alchemy `2.0.0-beta.85`, effect 4.1, all pins in the pnpm catalog, `check:publish-deps` | **Merged** (squash `3a8006d0`). |
| prisma/composer#405 | `claude/alchemy-deploy-in-process` | `prisma deploy` runs Alchemy in process. Slice 4: deploy works after `prisma login` with no `PRISMA_SERVICE_TOKEN` | Draft, base `main`. **Conflicts with `main` again** (new main commits #424 and #426, see below). |
| prisma/composer#411 | `claude/alchemy-dev-in-process` | `prisma dev` runs Alchemy in process | Draft, base #405's branch. One `Test` failure on the last run, not investigated. This branch also carries this Drive folder. |

Both branches are pushed to the `bot` remote (`git@github-wmadden-electric:prisma/composer.git`). Push only through `bot`. Never force-push. Never rebase.

## The blocker: an Alchemy release

Slice 4 needed two upstream changes, both **merged** on 2026-11-07:

- alchemy-run/distilled#1076: `@distilled.cloud/prisma` `Credentials.apiToken` optional; header sent only when set.
- alchemy-run/alchemy#3101: `PrismaEnvironment.serviceToken` optional; a caller-built environment may omit it and authenticate through the `HttpClient` it supplies. Env and profile resolution still require a token.

**No Alchemy release contains them yet.** npm `latest` is still `alchemy` `2.0.0-beta.85`, `@alchemy.run/prisma` `2.0.0-beta.85`, `@distilled.cloud/prisma` `1.0.0-rc.18`. Until then #405 and #411 pin preview builds in `pnpm-workspace.yaml` (`pkg.alchemy.run` URLs; `alchemy` pinned to the exact tarball URL because `check:npm-effect-resolution` needs it). `check:publish-deps` refuses URL pins, so these PRs cannot merge until the release. When it ships: swap the three catalog entries to the released versions (follow `skills-contrib/upgrade-alchemy-effect/SKILL.md`), `pnpm install`, rerun checks, then mark #405 ready.

## How slice 4 authenticates (decided with Will; do not reopen)

`ctx.api`, the CLI engine's Management API client, is passed to Composer and becomes the `HttpClient` the Alchemy Prisma provider and Composer's state store use. Reason, in Will's words: the CLI manages authentication centrally; Composer does not manage its own token; when authentication fails, the CLI refreshes and retries (later perhaps re-login or switching credentials) inside the pending request, so Alchemy and Composer never see it. A token getter, even one called per request, cannot do that. Sam Goodwin (Alchemy) asked about this on #3101; Will answered and Sam merged.

- Adapter: `packages/1-prisma-cloud/0-lowering/lowering/src/deploy-http-client.ts`. Management API requests go through the client's per-method calls; other hosts (presigned uploads) go to the node transport unauthenticated. `FetchHttpClient.Fetch` is provided per request (the live 401 bug, fixed in `d7125d31`, regression test in `state/__tests__/state-api.test.ts`).
- `credentials.ts`: origin from `PRISMA_MANAGEMENT_API_URL` (default `https://api.prisma.io`); conflicts with `PRISMA_API_URL` refuse with `DEPLOY.MANAGEMENT_API_URL_CONFLICT`.
- Core type `CallerCredentials` (renamed from `ContainerCredentials`, no alias) on `LowerOptions.credentials`. CLI `family/commands/deploy.ts` passes `{ client: ctx.api, workspaceId }`.
- `CONVERGE_CONTRACT` is 2 (no released app speaks an earlier contract; keep it 2).
- Known gap, not blocking: log tailing (`tailDeploymentLogs`) opens a WebSocket outside `HttpClient`, so a caller with no token cannot tail. Composer never calls `tail`. Closing it needs a CLI mechanism for WebSockets equivalent to the HTTP one. Record it in `deferred.md` if not there.

Live QA of slice 4 passed (`reviews/slice-4/manual-qa.md`). The QA environment's bucket and service were deleted by Will. The empty Branch `maat73-login-qa` in project `bucket-example` (`proj_cfkzdu54l1qzgmjgrsfq9jkp`) still exists with old Alchemy state rows; deleting it is Will's call.

## Slice 3 (dev in process): the open design decision, now settled

In process, Node and Bun cache the app's definition modules, so a rebuild would re-apply the graph loaded at start. #411 currently detects edits to any app file the entry loaded (`recordAppFiles` in `entry-resolution.ts`, `files` on `LoadedEntry`) and emits `definition-changed`, which pauses rebuilds and tells the user to restart dev.

**Will agreed on 2026-11-11 to option C:** on a definition change, load the app definition in a short-lived child process or worker that hands the graph back; the converge itself stays in process. Same behaviour on Node and Bun, and wiring edits keep applying live as ADR-0056 promised. Do not do "restart required" (Will rejected it: the CLI keeps emulators running, possibly detached) and not Node-only live reload.

To do for slice 3:

1. Design the loader (child vs worker; how the graph crosses the boundary; what happens to `files` tracking; error reporting for a broken edit). Check the graph is serialisable or what has to be reconstructed; if it is not, bring the finding to Will before building.
2. Implement on `claude/alchemy-dev-in-process`, replacing the `definition-changed` pause.
3. Record the decision in a new ADR that amends ADR-0056; point to it from ADR-0064's dev amendment (review S08).
4. Address the rest of `reviews/slice-3/`: F02 (Ctrl-C during a rebuild waits for the pipeline), F03 (resource steps left open after a failed converge), S03 (docs over-claim detection; four names for one concept), S05–S07, S09 (an integration test that edits a definition file while dev runs, under Node and Bun if CI runs Bun). F01/S01 are mostly superseded by option C. S04 is done (contract stays 2).
5. `/drive-code-review` round 2, fix, then manual QA of `prisma dev` (foreground and `--detach`).

## Other remaining work

- **Merge `main` into #405, then #405 into #411.** New on main since `3a8006d0`: #424 "stop the app's services before exiting, so Ctrl-C under npm frees their ports" (dev) and #426 "prisma deploy stops copying secrets from your local environment to Prisma Cloud" (deploy). #426 touches deploy, so port it into the in-process path deliberately, as the previous merges did for main's app configuration file and secret redaction (see merge commit `1602a7f6` on #405 and `19a1aeb1` on #411). Last time this took an Opus implementer agent per PR with a precise brief.
- **Check #411's failing `Test` job** (run 42763154117). Several local-dev tests are flaky in CI on main too (timeouts in `local-target-current.test.ts`, dev-emulators); confirm whether this is one before re-running.
- **Update the #405 and #411 PR descriptions** for slice 4 and the merges: deploy needs no service token after `prisma login`; preview pins until the Alchemy release; the in-process path writes no app configuration file; the secret-in-plain-value refusal now applies only to destroy.
- **Run `/drive-code-review` on #405** again: the state-store fix and three merges of `main` happened after its last review.
- **Note for the PR description / release notes:** removing `ContainerCredentials` without an alias breaks extensions importing it from `@prisma/composer/config`.
- **Close-out** (`plan.md`): verify the spec's done-when; move `deferred.md` items to `.drive/deferred.md` or Linear; record destroy's migration; delete this folder.

## Rules that bit this project

- Will's global `CLAUDE.md`: design with Will, then execute without asking; `/drive-code-review` every slice; Opus (`model: "opus"`) for every subagent; never run `pnpm test:integration`, `test:e2e` or `test:all` in full (run single files with `bun run test/<file>` from `test/integration`); no `/tmp`, use `wip/`; plain English, short; no question UI; no floating task cards.
- Commits: `git commit -s --trailer "Signed-off-by: Will Madden <madden@prisma.io>"` plus `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR bodies end with `Agent: <name>` above the Claude Code line.
- Stage explicit paths. A `git add -A --` with an empty path list once staged this whole untracked folder into a merge commit.
- When upstream (Alchemy, Distilled) is involved, read the provider source first, and follow each repo's written contributor rules exactly. Prisma owns every `@prisma/*` package, including the CLI engine in prisma-cli; Alchemy, Distilled and Effect are upstream.
- Do not accept an external maintainer's design advice without checking it against the CLI's design (`prisma-cli` `packages/cli-engine/src/execution/api-client.ts` and `.drive/projects/prisma-cli-v8/specs/s3-composer.md`). Discuss with Will before proposing.
- Deploy credentials for live QA: `set -a; . ~/.config/prisma-compose/deploy.env; set +a`, `PRISMA_REGION=us-east-1`. Never print them. Slice 4 QA instead used only a `prisma login` session.

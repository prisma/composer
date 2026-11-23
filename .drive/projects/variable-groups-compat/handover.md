# Handover: making Composer work with the platform's variable groups

Written 2026-11-24 by the session named democritus-22. You are taking over the whole project, not one task.

## What this project is

Ty Hogarth is changing how the Prisma platform stores variables. Composer has to keep working with the new model. Will Madden (the operator) decided how:

- Fixes ship only in a new Composer release. No patch releases on older lines, and no special treatment of old Composer by the platform.
- Console and the docs name a minimum Composer version, and Console warns users of older versions.

### Ty's model, in short

- A project has variable groups: `production`, `preview`, and up to 10 custom groups. A custom group has a rule on the branch's git name (`equals` or `startsWith`). A branch receives exactly one group. There is no inheritance.
- Service variables are stored per service. The only way to set them is a `variables` field on `POST /v1/services/{id}/deployments`: a string sets a key, `null` deletes it, a key not sent keeps its value. Limits: 50 per service, 8,192 characters per value.
- A deployment receives the group's variables, then branch overrides, then service variables.
- Writes of branch overrides will be rejected three months after a date still to be agreed.
- A new read, `GET /v1/projects/{projectId}/resolved-variables?branchId=…`, returns the group and the variables the branch receives.

### How older Composer breaks

- Its deploy check reads variables one key at a time with no branch. On a branch that receives a custom group it reports set variables as missing, missing ones as set, and misses changed values.
- Every released version writes its own `COMPOSER_<ADDRESS>_…` keys as branch overrides on preview. Those writes fail once branch override writes are rejected.

## State of the work

Three pull requests on `prisma/composer`. All code is committed and pushed; every worktree is clean.

| Pull request | Branch | State |
| --- | --- | --- |
| [Client headers on every Management API call; no `DATABASE_URL` placeholder](https://github.com/prisma/composer/pull/449) | merged | Released in 0.40.0 on 2026-11-23. |
| [The deploy check reads the variable group the branch receives](https://github.com/prisma/composer/pull/450) | `feat/preflight-reads-resolved-variables` | Draft. Finished. Waits on Ty. |
| [A service's `COMPOSER_` keys are sent with its deployment](https://github.com/prisma/composer/pull/451) | `feat/composer-keys-travel-with-the-deployment` | Draft. Finished. Waits on Ty, Distilled and Alchemy. |

Each pull request had a design review, two rounds of drive code review, and manual QA with real deploys. The two drafts were tested through a local proxy that imitates Ty's planned API, because the real one does not exist yet.

### What the first draft waits on

1. The resolved-variables read live in production.
2. A fix on Ty's side: a variable written without a `groupId` (what `prisma project env add --role preview` does) is stored with no group. A deployment receives it, but the read does not list it, so our check would report it missing.
3. Two answers from Ty: is the read paged (today we fail the deploy if the answer says there is more to fetch), and will `prisma variable add … --group` ship (until then the hint for a custom group says to set it in the Console).

Its "Deploy, verify, destroy" check is red until the read exists in production. That is expected.

### What the second draft waits on

1. Ty's final shape for the `variables` field. We built against an assumption; he said he would adjust our pull request to match.
2. The field in the published production API specification. `@distilled.cloud/prisma` is generated from it, and `@alchemy.run/prisma` builds on Distilled.
3. One pull request on Distilled and one on Alchemy, then releases of both. The proposed diffs are in `slices/upstream/` on the second draft's branch. Not opened yet: I recommended waiting until Ty's field is final so each team reviews once. Will has not answered.

Until then the branch runs on `pnpm` patches of both packages. A CI check added by this pull request (`pnpm check:patched-dependencies`) fails while a published package depends on a patched package. So Lint, Publish preview and "Deploy, verify, destroy" are red on purpose.

## What you must do next, in order

1. **Fix the version number everywhere.** The plan said the minimum version would be 0.40.0. Composer 0.40.0 was released on 2026-11-23 without the deploy-check fix, because Ty's read is not in production. The minimum version is now whichever release first contains that fix. Update the plan, the description of the second draft (it names 0.40.0), and anything else that names it. Tell Will plainly that Ty was told 0.40.0, so Ty needs the correction. Will had a drafted update for Ty that says "0.40.0 will ship with the first change"; I do not know whether he sent it.
2. **Wait for Ty.** Nothing else in Composer can move. Check his work by reading the platform repository at `/Users/wmadden/Projects/prisma/pdp-control-plane` with `git fetch` and `git show <ref>:<path>` only. Do not change that clone.
3. **When the read is live and the defect is fixed (first draft):** merge `main` into the branch, re-check the hint text against the CLI that shipped, run manual QA against the real read, run a drive code review of the final commit, mark it ready, and follow it to merge.
4. **When the field is final (second draft):** align the code with Ty's shape, open the Distilled and Alchemy pull requests, wait for both releases, raise the pins, delete the patches and the paragraphs about them in the service-variables decision record and `alchemy-lowering.md`. Then run manual QA against the real platform: a fresh deploy, and an upgrade from 0.39.0 watched for 10 minutes. Run a drive code review of the final commit, mark it ready, and merge it after the first draft.
5. **Release** with the `publish-npm-version` skill once the first draft has merged.
6. **Close out** as `plan.md` describes.

## Decisions I made that Will has not confirmed

- The deploy-check fix ships without waiting for the service-variables change. That gives two minimum versions: one for custom groups, and a later one before branch override writes stop.
- The Distilled and Alchemy pull requests wait until Ty's field is final.

## Things that are easy to get wrong

- **Ty's own pull request on Composer** ("Composer identifies itself on Management API calls through the CLI's client, and older lines can get patch releases") is still open. Its headers half is already merged through our first pull request, with credit to him. Its patch-release half is not wanted. It is his pull request; do not push to it or close it without Will.
- **The response to Ty is sent.** Do not edit `wip/response-to-ty.md`. Anything new for Ty goes in pull request descriptions.
- **Core must not change.** The work lives in `packages/1-prisma-cloud`. The framework in `packages/0-framework` must not learn about variable groups or service variables.
- **Once the second change has deployed an environment, older Composer cannot plan against it**, because the deploy state then holds a resource older versions do not know (`PrismaCloud.SentVariableNames`). The guide and the pull request description say so.
- **A deferred defect:** exceeding 50 service variables fails with the generic engine error code instead of its own code. The fix needs a framework change. See `deferred.md`.
- **An unexplained 504 in QA** turned out to be a slow first request after idle (about 45 seconds), not our change.
- **Auto-fix cannot be turned on** for these pull requests, because the bot account opened them. Use a background `gh pr checks <n> --watch` instead.
- **Six database-backed test files could not run on this machine** after a crash (Postgres could not create shared memory). They pass in CI. Check whether that still holds before relying on local runs.
- **Will's guidance changed on 2026-11-23:** every pull request needs a drive code review of the commit that will merge. The reviews already done do not cover commits you add.

## Where things are

Tracked, in `.drive/projects/variable-groups-compat/`:

- `design.md`: the full design. Section 4.1 is the deploy check, 4.2 service variables, 4.3 the placeholder, 4.4 the headers.
- `spec.md`, `plan.md`, `deferred.md`.
- On the second draft's branch only: `slices/slice-3-plan.md` and `slices/upstream/` (the proposed Distilled and Alchemy changes).

Not tracked, on this machine only. The repository is public, so Ty's message, the reply and the QA records were deliberately not committed:

- `/Users/wmadden/Projects/prisma/composer/.claude/worktrees/composer-platform-vars-compat-c21ec1/wip/`: `ty-proposal.md` (Ty's original message and specification), `response-to-ty.md` (the reply that was sent), `qa-slice-1/qa-record.md`. Design reviews are in the same worktree under `.drive/projects/variable-groups-compat/reviews/`.
- `/Users/wmadden/Projects/prisma/composer/.claude/worktrees/variable-groups-compat-slice-2/`: `wip/pr-2-body.md`, `wip/qa-slice-2/qa-record.md` (including the proxy used to imitate the read), code reviews under `.drive/projects/variable-groups-compat/reviews/slice-2/`.
- `/Users/wmadden/Projects/prisma/composer/.claude/worktrees/variable-groups-compat-slice-3/`: `wip/pr-3-body.md`, `wip/qa-slice-3/qa-record.md`, `wip/qa-slice-3-dev.md`, code reviews under `.drive/projects/variable-groups-compat/reviews/slice-3/`.

If those worktrees are gone, the pull request descriptions on GitHub still hold the QA results and what Ty needs.

Upstream clones, older than the pinned versions, read only: `/Users/wmadden/Projects/prisma/alchemy` and `/Users/wmadden/Projects/prisma/distilled`.

## How manual QA was done

Real deploys to real Prisma Cloud, with `PRISMA_REGION=us-east-1`, sent through a local proxy by setting `PRISMA_MANAGEMENT_API_URL`. The proxy answers the calls the platform does not have yet and passes the rest through. Each run used a throwaway project with a unique name and destroyed it afterwards. The credentials are in `~/.config/prisma-compose/deploy.env`; source them, never print them.

## Full transcript of the previous session

`/Users/wmadden/.claude/projects/-Users-wmadden-Projects-prisma-composer--claude-worktrees-composer-platform-vars-compat-c21ec1/aadb6979-1abc-4539-969a-26fa7fdfdb17.jsonl`

It is about 7 MB of JSON lines. Search it instead of reading it whole.

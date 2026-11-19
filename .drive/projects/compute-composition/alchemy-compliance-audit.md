# Compliance audit: Alchemy branch feat/prisma-compute-composition at deed5bb43

Audited 2026-11-19 against the rules the alchemy-run/alchemy repository gives contributors and coding agents. Read-only: nothing in the checkout was changed.

## 1. Verdict

No, the pull request should not be opened as it is. The code itself passes every check I could run (formatting, export map, JSDoc layout, test tags), but the tests contradict the repository's most explicit testing rule and an open maintainer pull request (#2018) that deletes the very fake this branch builds on, the description is longer than any pull request merged recently and carries test status the rules say belongs in a draft, and four small code and docs defects break written rules. Before opening: decide how to handle the fake-based tests and #2018 (at minimum say so and open as a draft), gate the live tests that are known to fail at destroy, cut the description and title down, and fix the typed-error predicate, the two docs snippets, the `process.env` examples, the "below" sentences and the two redirects.

## 2. Files read

Instructions, in full:

- `AGENTS.md` (1,453 lines), `CLAUDE.md` (only `@AGENTS.md`).
- Nested: `examples/prisma-website-nextjs/AGENTS.md`, `packages/aws/src/AGENTS.md` (first 60 lines; it is the AWS bring-up process and does not apply), `submodules/distilled/AGENTS.md` (its root `CLAUDE.md` is a symlink target of the same content; read in full).
- Skills (`.claude/skills/*` and `.grok/skills/*` are symlinks to `.agents/skills/*`; confirmed with `ls -la` and `diff -rq`): `alchemy-provider/SKILL.md`, `alchemy-provider/review.md`, `alchemy-provider/docs.md`; `write-docs/SKILL.md`, `write-docs/references/voice.md`, `page-shapes.md`, `structure.md`, `verification.md`; `audit/SKILL.md`, `audit/procedure.md`; `pr-queue/SKILL.md`; `harden/SKILL.md`; `prepare-release/SKILL.md`; `release-blog/SKILL.md` and `release-blog/scripts/collect-prs.sh`; `release-overnight/SKILL.md`; `packages/domain/skills/alchemy-domain/SKILL.md` (same as `.agents/skills/alchemy-domain`).
- `packages/domain/skills/alchemy-domain/references/*.md`: scanned headings and searched for contributor rules (pull request, commit, changelog, test, mock, fake). They describe how to build with `@alchemy.run/domain` and contain no rule that applies to this branch. Not read line by line.
- `write-docs/scripts/*` and `release-blog/scripts/check-post.py`, `screenshot-sections.mjs`: not read; they are tools for docs authors and blog posts.
- `README.md` names no contribution process; there is no `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`, pull request template, issue template, `CODEOWNERS` or labeler config. `.github/` holds only `FUNDING.yml` and workflows.
- `.github/workflows/check.yml` (the only workflow with blocking checks on `pull_request`), `website.yml` (pull request trigger for docs previews, first 40 lines), and the `on:` blocks of `cloudflare-tools.yml`, `pkg.yml`, `publish-blogpost.yml`, `release.yml`, `sync-cloudflare-permission-groups.yml` (none runs on pull requests).
- `.husky/pre-commit` (`pnpm run format`, then `git update-index --again`), `.husky/post-checkout`; `oxfmt.config.ts`, `oxlint.config.ts`, `oxlint.tests.config.ts`; root `package.json` scripts. There is no lint-staged, commitlint or changelogen configuration.
- Convention tests: `packages/integration-tests/test/Prisma/SourceConventions.test.ts`, `PublicSurface.test.ts`, `ManagementCoverage.test.ts` (diff), `Providers.test.ts` (diff).
- Practice: the last 40 merged pull requests (titles, sizes), the last 30 Prisma pull requests, the bodies of #3122, #3101 and open #2018, description lengths of the last 100 merged pull requests, title lengths of the last 200, and the last 300 commits on `main` (squash practice, sign-offs).
- Background: `alchemy-pr-description.md`, `alchemy-questions-for-maintainers.md` (start).

Checks run (read-only): `oxfmt --check` on all 71 changed text files (65 matched, all formatted; `.md`/`.mdx` and `llms.txt` are ignored by `oxfmt.config.ts`), `node scripts/sync-exports.ts --check` ("Package exports are up to date"), `node scripts/fix-api-jsdocs.ts --check` ("All API JSDocs are normalized"), `oxlint -c oxlint.tests.config.ts packages/integration-tests/test/Prisma` (exit 0), and every grep from `review.md` sections 2 to 4 over `packages/prisma/src` and the Prisma tests. The pnpm wrapper directory named in the brief does not exist, so I ran the tools from `node_modules/.bin` and `node` directly.

## 3. Violations

Ordered by how likely a maintainer is to object.

### 3.1 New tests run against a fake Management API, against the written rule and against an open maintainer pull request

Rules:

- `AGENTS.md:847`: "Exercise create, update, redeploy, and removal through the stack. **Do not mock HTTP or SDK responses, invoke provider lifecycle methods directly, or call extracted reconciliation helpers as a substitute for a deployment.**"
- `AGENTS.md:848`: "Verify the resulting cloud state through distilled".
- `.agents/skills/audit/procedure.md:63-66`: "Only `test.provider` with `stack.deploy`/`stack.destroy`, or `beforeAll(deploy(Stack))` fixtures. No mocked HTTP/SDK/CLI responses, fake layers, direct lifecycle calls, or fake-cloud engine tests."
- `procedure.md:60-62`: "A new one-off test file — especially one with mocks — fails the audit."
- `procedure.md:72-73`: "If a suite already fakes what it claims to test, say so plainly".
- `procedure.md:9-11`: "If the audit finds a problem shared across the list (e.g. an existing suite full of fakes), propose fixing that first in its own PR off main".
- `AGENTS.md:852`: "Pure utility and engine unit tests remain appropriate for their own behavior; they do not replace live resource lifecycle coverage." (`procedure.md:74-76` says the same.)

Existing practice on `main`: the Prisma suites already use `fixtures/FakeManagementApi.ts`. `Compute.test.ts` on main has 58 direct `.Provider` references and no `test.provider`; `Deployment.test.ts` has 23 direct references and 35 fake references; `ManagementLifecycle.test.ts` and `ComputeLifecycle.test.ts` use the fake too. So the package breaks this rule today. But the maintainer has an open, non-draft pull request, #2018 "test(prisma): deploy real fixtures through test.provider, remove the fake Management API" (+5,450/−19,544, last updated 2026-11-11), whose description says no test calls a provider directly, `FakeManagementApi` is deleted, and "Tests that need Prisma itself to misbehave … are deleted rather than mocked."

What the branch does:

- Adds `packages/integration-tests/test/Prisma/fixtures/ComputeCloud.ts` (432 lines), a fake Compute platform built on `FakeManagementApi`.
- Adds `ActiveVersion.test.ts` (938 lines), `RenamedResources.test.ts` (524 lines) and the fake-backed parts of `ComputeArtifact.test.ts` (328 lines). These run `stack.deploy` through the engine, which is better than direct calls, but against the fake (`Layer.provideMerge(cloud.fake.layer)`, `ActiveVersion.test.ts:59`). They are "fake-cloud engine tests" in the procedure's words, and three of them are new one-off files.
- Rewrites `Compute.test.ts` (−8,106 net lines; now 35 `test.provider` cases and no direct provider calls) onto the same fake.
- Keeps `ComputeVersion.test.ts` (renamed from `Deployment.test.ts`, 2,046 lines) with 52 direct `.Provider` references and the fake.
- Adds live tests that do comply: `ActiveVersion.live.test.ts`, `ComputeArtifact.live.test.ts`, and new cases in `Compute.live.test.ts`; `ComputeService.test.ts` (renamed from `App.test.ts`) is live.
- `ArchiveManifest.test.ts` and `ComputeUrlCheck.test.ts` are pure utility tests (an archive reader and a URL poller against local data), which the rules allow.

Defensible? Partly. The new suites follow the package's existing practice and move `Compute.test.ts` from direct calls to stack deploys. But the written rule is unambiguous, the maintainer is actively deleting the fake, and the branch and #2018 rewrite the same files (`Compute.test.ts`, `Deployment.test.ts`/`ComputeVersion.test.ts`, `Resources.test.ts`), so whichever merges second has a very large conflict. A maintainer can say "you added 1,900 lines of new fake-based tests while I am removing the fake".

Also inaccurate: `alchemy-questions-for-maintainers.md` question 3 says most Prisma tests run against a fake "which `fixtures/ComputeCloud.ts` implements". `ComputeCloud.ts` is new on this branch; the existing fake is `FakeManagementApi.ts`. The question also does not mention #2018, which already answers it.

Fix, in order of preference:

1. Coordinate with #2018 before opening: either base the test work on #2018's branch, or convert the new composition behavior into live `test.provider` cases (as #2018 does with env-var-driven fixtures for crash-on-boot, health status and a server that stays `stopping`) and drop `ComputeCloud.ts`, `ActiveVersion.test.ts` and `RenamedResources.test.ts`. Keep `ArchiveManifest.test.ts` and `ComputeUrlCheck.test.ts`.
2. If that is out of scope for this pull request, open it as a draft, say in one line that the fake-based suites follow the package's current practice and will move to #2018's shape, and correct question 3 so it names `FakeManagementApi.ts` and #2018.

### 3.2 Live tests that are known to fail at destroy, and leak, are shipped ungated

Rules:

- `AGENTS.md:156`: "if a suite is not green after ~3 fix iterations and the blocker is platform behavior …, implement fully, skipIf-gate with the typed tag and exact error, verify a skip-clean run, and report honestly."
- `AGENTS.md:1246`: "a passing test that leaves cloud resources behind is a provider bug by definition."
- `AGENTS.md:1390-1392`: outstanding steps or manual testing go into a draft pull request and a message to the user, "DO NOT include them in the PR description".
- `AGENTS.md:1375`: "Never include a 'Test plan', 'Testing', or checklist of TODOs."

What the branch does: the description says (line 88) "Expect live tests that destroy a Compute to fail at destroy for this reason until the platform is fixed; seven did in the last run." Those tests are not gated, so every maintainer release run (`prepare-release`, `release-overnight`, which require green suites and a clean census) will fail on them and leave stuck versions and services in the test account.

Fix: gate the destroy-dependent live cases behind one Prisma flag (for example `PRISMA_TEST_STUCK_STOP=1`) with a comment quoting the exact error (`DeleteInProgress … still stopping`), keep one ungated case that asserts that typed failure, and delete the sentence from the description. Tell the maintainers about the platform bug outside the description (see 3.4).

### 3.3 The description and title are far longer and more prose-heavy than the rules and practice allow

Rules:

- `AGENTS.md:1371`: "Aim for the minimal content needed to convey the idea."
- `AGENTS.md:1373`: "Prefer code snippets over prose … only add prose to fill in the 'why' the snippet can't show".
- `AGENTS.md:1374`: "Be direct and succinct. Cut adjectives, justifications … If a sentence is restating what the diff already shows, delete it."
- `procedure.md:218-225`: "one plain sentence on what changes and why … prose only for the 'why' a snippet can't show, one or two sentences … no … bullet dumps".
- `AGENTS.md:1369`: conventional-commit title (complies), and the examples are short.

What the description does (`alchemy-pr-description.md`):

- 15,628 characters and 183 lines. The last 100 merged pull requests have a median of 1,275 characters, a 90th percentile of 2,946, and a maximum of 14,860 (a whole new DigitalOcean provider). The Prisma breaking changes #3122 and #3101 are under 2,500 characters each.
- Several long prose paragraphs that explain platform behavior and justify decisions: line 86 (failed versions, "one stayed over an hour"), line 88 (service delete, "refused 5 times in 5", the way out of a stuck destroy), line 104 (where decorations go), line 159 (upgrade path). These are justifications and platform history, which the rules say to cut.
- A 15-item bullet list, "Behaviour that changes with it" (lines 121-134), which is the "bullet dump" the procedure forbids.
- The title is 166 characters. The longest of the last 200 merged titles is 101; the median is 64.
- The file's first line starts with `Title: `; that prefix must not be pasted into the title field.

Heading levels comply: only `###`, no heading before the summary.

Fix: keep the opening sentence, the two `ts` snippets, the plan listing, and one `diff` per breaking rename (resources, props/attributes, errors, helpers, `promote` → `activateVersion`, removal policy). Replace the prose paragraphs with one sentence each or a link to the "Services and versions" docs page, which already has an upgrade section. Drop "Behaviour that changes with it" to the three or four items a user must act on. Aim for 3,000 to 4,000 characters. Shorten the title to under about 100 characters, for example `feat(prisma)!: Prisma.Compute composes ComputeService and ComputeVersion, and keeps replaced versions`.

### 3.4 Open questions for maintainers mean the pull request must be a draft

Rule: `AGENTS.md:1390-1392`: "If there are outstanding steps, manual testing required, or review items, DO NOT leave a comment on the PR and DO NOT include them in the PR description. Instead: 1. Mark the PR as draft. 2. Tell the user …" `alchemy-provider/SKILL.md:131` also says provider work opens as draft pull requests.

What the branch does: the questions were moved out of the description into `alchemy-questions-for-maintainers.md`, which is right for the description. But the questions (upgrade path for outside users, deprecated aliases for `Prisma.App`/`Prisma.Deployment`, converting fake suites) are review items. Posting them as a pull request comment would break the rule.

Fix: open the pull request as a draft, and raise the questions with the maintainers outside the pull request (an issue, or the channel the team uses), not as a pull request comment. Mark it ready once they are answered.

### 3.5 A structural tag check on an `unknown` cause, which the Typed Error Doctrine forbids

Rule: `AGENTS.md:937-949`: "Forbidden patterns — these defeat the type system and must never appear in alchemy code or tests: // ❌ unknown-typed structural predicates". `AGENTS.md:951-962`: required patterns are fully inferred `catchTag`, "no casts, no `unknown`". `prepare-release/SKILL.md:235-237` tells the maintainer to reject a diff that does this.

What the branch does: `packages/prisma/src/ComputeService.ts:1200-1205` (new on this branch):

```ts
Effect.catchIf(
  (error) =>
    error instanceof PrismaComputeVersionWaitTimeout ||
    (error instanceof PrismaComputeVersionDeleteFailed &&
      Predicate.isTagged(error.cause, "Conflict")),
  () => Effect.succeed("stopping" as const),
),
```

`PrismaComputeVersionDeleteFailed.cause` is `unknown` (`ComputeLifecycle.ts:43-48`), so `Predicate.isTagged(error.cause, "Conflict")` is a duck-typed tag check.

Fix: make `destroyComputeVersion` fail with its own tagged error when the platform refuses the delete because the version is still stopping (for example `PrismaComputeVersionStillStopping`, built from the typed `Conflict` of the delete operation), or type `cause` as the delete operation's error union. Then replace the `catchIf` with `Effect.catchTag(["PrismaComputeVersionWaitTimeout", "PrismaComputeVersionStillStopping"], …)`.

### 3.6 Docs snippets that are not whole files, or have `yield*` at module scope

Rules: `alchemy-provider/docs.md:154-157`: "Every block with `import` lines is a complete file with a `// path` comment on its first line. No `...` elisions, no `yield*` at module scope." `write-docs/references/voice.md:43-46` says the same.

What the branch does:

- `website/src/content/docs/prisma/compute/deployments.mdx:52-60`: has two `import` lines, no `// path` first line, and three module-scope `yield*` lines.
- `website/src/content/docs/prisma/compute/apps.mdx:249-254`: starts with `// alchemy.run.ts` and an import, but has `const api = yield* Api.pipe(…)` at module scope and uses `Effect` and `RemovalPolicy` without importing them.

On main neither page had a snippet with imports, so both are new.

Fix: either drop the `import` lines so each is a clearly in-handler fragment, or make each a complete file with a `// path` line, all imports, and the `yield*` inside the stack's `Effect.gen`.

### 3.7 Examples that read secrets from `process.env`

Rules: `write-docs/references/voice.md:51`: "Read config through `Config`: `Config.Redacted("API_KEY")`, never `process.env`." `AGENTS.md:794`: "Environment variables are configuration: read them through `effect/Config`, never `process.env`".

What the branch does (both new lines): `website/src/content/docs/prisma/compute/apps.mdx:149` and the JSDoc example at `packages/prisma/src/Compute.ts:768` use `API_TOKEN: Redacted.make(process.env.API_TOKEN!)`. The JSDoc example also lands in the generated API reference. (Four similar JSDoc examples in `Compute.ts` were already on main.)

Fix: `API_TOKEN: Config.redacted("API_TOKEN")` (or `yield* Config.redacted("API_TOKEN")`, whichever the `env` prop accepts; check against the props type).

### 3.8 Docs prose that talks about the page itself

Rules: `write-docs/SKILL.md:128-131`: "Never write about the page itself. No … 'the rest of this page explains…'. Open on the subject". `voice.md:13-16` and `docs.md:164-166` ("Don't narrate … the docs' own structure").

What the branch does: `deployments.mdx:34-36` "The sections below use the resources it is made of: …" and `deployments.mdx:49-50` "… as shown below:".

Fix: "`Prisma.Compute` declares the service and its versions for you, from `Prisma.ComputeService`, `Prisma.ComputeVersion` and `Prisma.ComputeArtifact`." and "… or let `Prisma.ComputeArtifact` build it:".

### 3.9 New redirects point at pages the site does not have

Rule: `alchemy-provider/docs.md:200-201` and `write-docs/references/structure.md:42-43`: "when a page moves or is removed, map the old path to its closest new page."

What the branch does: `website/src/worker.ts:214-215` adds `"/providers/prisma/app": "/providers/prisma/computeservice"` and `"/providers/prisma/deployment": "/providers/prisma/computeversion"`. The generated Prisma reference is grouped by service: the built site (`website/dist/providers/prisma/reference/`) has `compute`, `bucket`, `postgres` and `project` pages, and `ComputeService`/`ComputeVersion` are sections of `/providers/prisma/reference/compute`. There is no `/providers/prisma/computeservice` page. The new links at `deployments.mdx:293-295` use the same form, as main's existing Prisma pages do, so the link form itself is pre-existing.

Fix: point both redirects at `/providers/prisma/reference/compute` (with `#computeservice` / `#computeversion` if the anchors exist), and consider the same target for the three new links. `pnpm docs:check` will confirm; I did not run it.

### 3.10 Live test timeouts above the speed doctrine

Rule: `AGENTS.md:153`: "Per-test timeout ≤ 90–120s … A suite needing more than ~3–5 minutes total is a bug." `alchemy-provider/SKILL.md:746-748`: failure-path tests "finish in minutes".

What the branch does: new live cases use `timeout: 900_000` (`ActiveVersion.live.test.ts:146`, `:186`; `ComputeArtifact.live.test.ts:123`; `Compute.live.test.ts:438`). Main's Prisma live suite already uses 600,000 and 900,000, so this follows the package's practice.

Fix: none required to match the package, but expect the question. Where a case only waits on the platform's slow stop, gating it (see 3.2) also removes the long timeout.

### 3.11 Lower-priority gaps, mostly carried over from main

- `AGENTS.md:992-997`: "Every resource with a local (dev) provider gets a `{Resource}.local.test.ts`" covering a local roundtrip and the `Alchemy.remote()` opt-out. `ComputeService.ts:1235` and `ComputeVersion.ts:1104` register `ProviderLayer.dual`, and there is no `ComputeService.local.test.ts` or `ComputeVersion.local.test.ts`. `App` and `Deployment` had the same gap on main. `ActiveVersion.test.ts` covers dev mode only against the fake.
- `AGENTS.md:1240`: "Tests that mutate process-global state … must pass `{ exclusive: true }`". `ComputeVersion.test.ts:1336-1411` replaces `Date.now` without `exclusive`. Carried over unchanged from main's `Deployment.test.ts:1482`.
- `AGENTS.md:386`: "You should almost never use `no-op` in the Diff". `ComputeArtifact.ts` and `Website/Artifact.ts` now return `{ action: "noop" }` when their input hash is unchanged. This is deliberate and commented (the archive is content-addressed), which fits the rule's "explicitly designed" exception, but a maintainer may ask.

## 4. Likely review comments that no rule covers

- **Size.** 79 files, +11,075/−11,634, 43 commits. The largest Prisma pull requests merged recently were separate features (#1849 +1,575/−1,075). A maintainer may ask to split the rename (`App`/`Deployment` → `ComputeService`/`ComputeVersion`) from the composition and from `ComputeArtifact`.
- **Overlap with #2018.** Beyond the tests (3.1), both rewrite `Compute.test.ts`, `Deployment.test.ts` and `Resources.test.ts`. Mention #2018 in the description and agree a merge order.
- **Re-using previously removed names.** `PublicSurface.test.ts` on main listed `ComputeService` and `ComputeVersion` under `removedPrismaDeepImports`; the branch moves them to the public list. A maintainer may ask why those names were removed before and why they come back.
- **Stale example READMEs.** The branch changes the code of `examples/prisma-tanstack-start` and `examples/prisma-compute-effect` but not their READMEs: `examples/prisma-tanstack-start/README.md:12-16,45-46` still say "A Prisma App", "A single Deployment", and `examples/prisma-compute-effect/README.md:60` says "The App name". `write-docs/references/verification.md` asks that every name in the docs match the source.
- **Children reporting through `host.bind`.** `Compute.ts:1315` and `:1357` use `host.bind` so child resources report to the Compute. The provider skill forbids `host.bind` in bindings (`alchemy-provider/SKILL.md:539-543`); this is not a binding, but it is a new pattern for a composite resource, so expect a design question.
- **The merge commit and `--no-verify`.** `alchemy-provider/SKILL.md:151-153` says to commit with the repo's hooks and, if one is skipped, to run `oxfmt` yourself and say so. The formatting outcome is clean (every file `oxfmt` covers passes). `main` is squash-merged (no merge commits in the last 300; every subject ends in `(#NNN)`, which `release-blog/scripts/collect-prs.sh` relies on), so the merge commit disappears. The skill's gap-audit step and `audit/procedure.md:22` both merge `origin/main`, so a merge is the documented way to update.
- **Branch is two commits behind `main`.** `origin/main` is now `68e65e3d8` (#3469 and #3326); neither touches Prisma files, llms.txt or the files this branch changes. Merge it before opening so CI runs on current `main` (`alchemy-provider/SKILL.md:134-137`).
- **Attribution lines.** `Agent: hodgkin-12` and "🤖 Generated with Claude Code" are not repository practice; one of the last 100 merged pull requests (#3481) carries the Claude line, none an `Agent:` line. Not a rule.
- **"Behaviour" spelling** (description line 121) where the repository writes "behavior". Minor.
- **Unverifiable numbers in the description**: "refused 5 times in 5", "one stayed over an hour", "seven did in the last run". A maintainer cannot check them from the diff; cutting them (3.3) removes the issue.
- **`Prisma.App` and `Prisma.Deployment` disappear without deprecated aliases.** The questions note raises this; a maintainer may ask for one release of aliases, since saved state is already aliased.

## 5. Rules table

| # | Rule | Source | Status | Note |
| --- | --- | --- | --- | --- |
| 1 | Title in conventional-commit format | AGENTS.md:1369 | Complies | `feat(prisma)!:`; too long, see 3.3 |
| 2 | Never `#`/`##` in the description; smallest heading `###` | AGENTS.md:1370 | Complies | only `###` |
| 3 | No title heading or `### Summary` at the top; summary as plain prose first | AGENTS.md:1370, 1407 | Complies | |
| 4 | Minimal content, simple sentences, bullets for discrete changes | AGENTS.md:1371-1372 | Does not comply | 3.3 |
| 5 | Prefer code snippets over prose | AGENTS.md:1373 | Partly | many snippets, but long prose paragraphs; 3.3 |
| 6 | Direct and succinct, cut justifications | AGENTS.md:1374 | Does not comply | 3.3 |
| 7 | No "Test plan", "Testing" or TODO checklist | AGENTS.md:1375 | Does not comply | "seven did in the last run"; 3.2 |
| 8 | Outstanding work or review items: draft, not in the description, not a PR comment | AGENTS.md:1390-1392 | Does not comply yet | 3.4 |
| 9 | Pass the body with `--body-file` | AGENTS.md:1394-1405 | To do | the opener must use a file |
| 10 | Rewrite the description as DX snippets; one plain sentence first | procedure.md:212-226 | Partly | 3.3 |
| 11 | Provider PR description: runtimes and fat-head sections, long tail in one line | alchemy-provider/SKILL.md:905-922 | Does not apply | for a whole-provider PR |
| 12 | Breaking change marked with `!` in the title | release-blog/SKILL.md:39; distilled AGENTS.md rule 11 | Complies | also `### Breaking changes` with diffs |
| 13 | Contributors do not add blog posts or changelog entries | release-blog/SKILL.md:128-129; AGENTS.md:1426-1452 | Complies | branch touches neither `CHANGELOG.md` nor `website/src/content/docs/blog` |
| 14 | Commit message or sign-off format | none found | Does not apply | no commitlint, no DCO workflow; main has no `Signed-off-by` in its last 200 commits; squash-merged |
| 15 | Commit with the repo's hooks; if skipped, run oxfmt yourself | alchemy-provider/SKILL.md:151-153 | Complies in effect | merge commit used `--no-verify`, but `oxfmt --check` passes on all changed files |
| 16 | Merge `origin/main`; resolve conflicts; re-check semantically | alchemy-provider/SKILL.md:75; procedure.md:22-43 | Complies | 2 commits behind now, no overlap |
| 17 | Format with oxfmt (`pnpm format:check` in CI) | check.yml:47-48; .husky/pre-commit | Complies | 65 of 65 matched files formatted |
| 18 | Never hand-edit `exports`; `pnpm exports:sync`; CI runs `exports:check` | AGENTS.md:109; SKILL.md:333-336 | Complies | "Package exports are up to date" |
| 19 | Non-public modules are `internal.ts` or under `internal/` | AGENTS.md:109 | Complies | new helpers under `src/internal/`; package exports block `./internal/*` |
| 20 | Package source must not import another package's `internal/` | AGENTS.md:109; review.md §1 | Complies | tests import `../../../prisma/src/internal/*`, as main's tests do |
| 21 | Core untouched; other providers untouched | review.md §1; SKILL.md:366-368 | Complies | no changes under `packages/alchemy`, other packages, `scripts`, `.github`, lockfile, submodules |
| 22 | `Providers.ts`: minimal insertions; nested `Layer.mergeAll` ~90 | AGENTS.md:137-138; SKILL.md:376-379 | Complies | three entries swapped in, Prisma has ~13 |
| 23 | Register new resources everywhere they are listed | SKILL.md:341-364 | Complies | `Providers.ts`, `index.ts`, `PublicSurface`, `Providers.test`, `SourceConventions`, `ManagementCoverage` updated; no new package, so root lists do not change |
| 24 | `pnpm lint:providers` clean | check.yml:58-59; SKILL.md:380-381 | Not checked | needs the type check; another agent runs it |
| 25 | Type-check `pnpm exec tsrs -b` before committing | AGENTS.md:1154-1162 | Not checked | another agent runs it |
| 26 | `pnpm lint` (oxlint, type-aware) | check.yml:61-63 | Not checked | needs built declarations |
| 27 | Every test tagged `unit`/`local`/`live` plus `provider:` tags; `pnpm lint:tests` | AGENTS.md:845 | Complies | lint exit 0 |
| 28 | Start and end `test.provider` cases with `stack.destroy()` | AGENTS.md:846; :180 | Complies | live and fake `test.provider` cases do |
| 29 | No mocked HTTP/SDK, no direct lifecycle calls, no fake-cloud tests | AGENTS.md:847; procedure.md:63-66 | Does not comply | 3.1 |
| 30 | Verify cloud state through distilled | AGENTS.md:848 | Complies for live tests | `ActiveVersion.live.test.ts` uses `getService`, `getDeployment`; fake suites cannot |
| 31 | Tests in the resource's existing suite, no one-off files | procedure.md:59-62 | Partly | `ActiveVersion.test.ts`, `RenamedResources.test.ts`, `ComputeUrlCheck.test.ts`, `ArchiveManifest.test.ts`, `WebsiteArtifactResource.test.ts` are new files; the first two are fake-based |
| 32 | Every resource has its own test file | SKILL.md:700-703; review.md §0 | Complies | `ComputeArtifact.test.ts`, `ComputeService.test.ts`, `ComputeVersion.test.ts` |
| 33 | Pure utility tests are fine | AGENTS.md:852; procedure.md:74-76 | Complies | `ArchiveManifest`, `ComputeUrlCheck` |
| 34 | Tests never modify checked-in files | procedure.md:79-81 | Complies | temp directories and the artifact store |
| 35 | No `Date.now()`, UUIDs or random values in physical names | AGENTS.md:864-870 | Complies | random bytes only in archive contents |
| 36 | Tests that mutate process-global state pass `exclusive: true` | AGENTS.md:1240 | Does not comply (carried over) | 3.11 |
| 37 | Per-test timeout ≤ 90–120 s; bounded retries | AGENTS.md:153-154 | Does not comply (package practice) | 3.10 |
| 38 | Platform-blocked failures: gate with typed tag and exact error | AGENTS.md:156; :162-164 | Does not comply | 3.2 |
| 39 | Never `while (Date.now() < deadline)` polling in tests | AGENTS.md:1103 | Complies | source polls with `Clock` and `Effect.sleep`, bounded |
| 40 | Local test file per resource with a local provider | AGENTS.md:992-997 | Does not comply (carried over) | 3.11 |
| 41 | Tests use `FileSystem`/`Path`, not `node:fs` | AGENTS.md:796 | Complies | `ArchiveManifest.test.ts` uses `node:zlib`, `node:crypto` and `execFileSync("lsof")` inside `Effect.sync`, not `node:fs` |
| 42 | Never `Input<T>` in declared Props | AGENTS.md:551-566 | Complies | no added `Input<` |
| 43 | `diff` rarely returns `noop` | AGENTS.md:385-387 | Complies, arguably | deliberate and commented; 3.11 |
| 44 | No `Effect.orDie` in lifecycle operations | AGENTS.md:767-769; review.md §2 | Complies | only in `Providers.ts` layer wiring and credentials |
| 45 | No `async`/`await`, raw `Promise`, `node:fs`, `node:os`, `pathe` in resource code | AGENTS.md:771-797 | Complies | `node:zlib` added to `internal/ArtifactFile.ts`, which already uses `node:fs` on main and is exempt in `SourceConventions`; the `await` hit is inside a generated bundle string |
| 46 | Env vars through `Config`, not `process.env` | AGENTS.md:794; review.md §2 | Complies in code | the `process.env` read at `Compute.ts:981-982` is on main with a lint exemption |
| 47 | Wrap sync Node APIs in `Effect.sync` | AGENTS.md:785 | Complies (spot-checked) | |
| 48 | Reconciler: no `output === undefined` branch | AGENTS.md:406, 428-430; review.md §4 | Complies | 0 hits; `SourceConventions` enforces |
| 49 | Typed error doctrine: no catch-alls, no status checks, no `unknown` tag predicates | AGENTS.md:893-964 | Does not comply | `Predicate.isTagged(error.cause, "Conflict")`; 3.5. `BadRequest`/`Forbidden`/`NotFound`/`Conflict`/`UnprocessableEntity` checks in `internal/ServicePromotion.ts:271-276` are typed members of distilled Prisma's unions |
| 50 | A typed-error gap is fixed in distilled, not in alchemy | AGENTS.md:897-933; SKILL.md:184-197 | Complies | no catch-all handled; no raw Management API call added; branch does not need a distilled change |
| 51 | Raw `HttpClient` only for presigned URLs or the user's own endpoint, with a comment | SKILL.md:228-235; review.md §3 | Complies | `UrlCheck.ts` probes the deployed URL (moved from main); `ArtifactUpload.ts` uses the presigned URL (main) |
| 52 | "Missing is not forbidden" | SKILL.md:399-402; review.md §3 | Complies | `Forbidden` means a refused rollback, not a missing resource |
| 53 | Lists fail loudly and paginate | SKILL.md:403-405; review.md §3 | Complies | page-token loops with a typed pagination error |
| 54 | Implement `list`; nuke ordering where delete order matters | SKILL.md:428-430 | Complies with main's practice | `ComputeVersion.list` returns `[]` as `Deployment` did; service delete removes versions itself |
| 55 | Shared helpers once per provider | SKILL.md:409-410; review.md §4 | Partly (carried over) | private `listApps`/`listAppDeployments` copies exist beside the exported ones in `Operations.ts`, as on main |
| 56 | No other providers' type names | review.md §5 | Complies | 0 hits |
| 57 | JSDoc on every resource, prop and attribute; `@default`; `###` sections and `**Example:**`; metadata tags last | AGENTS.md:232-276, 245-263; docs.md:87-97 | Complies | `docs:check-jsdoc` clean; `SourceConventions` checks props and attributes |
| 58 | Never edit generated reference pages | AGENTS.md:66-69, 188-192; procedure.md:136-138 | Complies | branch touches nothing under `website/src/content/docs/providers/` |
| 59 | `pnpm docs:check` (website build, links, diff blocks) | check.yml:93-97; docs.md:203-208 | Not checked | builds the site; another agent runs it |
| 60 | Hub snippets are whole files; no module-scope `yield*` | docs.md:154-157; voice.md:43-46 | Does not comply | 3.6 |
| 61 | Read config through `Config` in docs snippets | voice.md:51 | Does not comply | 3.7 |
| 62 | Never write about the page itself | write-docs/SKILL.md:128-131; voice.md:13-16 | Does not comply | 3.8 |
| 63 | Commands package-manager neutral (`<PackageManagers>`), CLI bare in prose | write-docs/SKILL.md:112-122 | Complies | `deployments.mdx:271` uses `<PackageManagers run=…>`; no raw `sh` blocks |
| 64 | Plain words, second person; no "the engine", no "provision" | voice.md:8-19 | Partly | "provisioning" at `apps.mdx:258` is on main |
| 65 | Diff blocks start with a column-0 context line | voice.md:53-54 | Not checked by build | `deployments.mdx:238` block: read, starts at column 0 |
| 66 | Sidebar, llms.txt and redirects updated when pages move or rename | docs.md:185-201; structure.md:40-53 | Partly | sidebar label and `llms.txt` updated (URLs kept); redirects point at missing pages, 3.9 |
| 67 | Commit regenerated `public/llms.txt` | structure.md:50-53 | Complies | commit deed5bb43 |
| 68 | Tutorial standard: one new thing per snippet | AGENTS.md:1275-1348 | Does not apply | `part-2.mdx` change is prose only |
| 69 | Examples registered in `tsconfig.json` and `scripts/test-examples.ts` | SKILL.md:978-981 | Does not apply | no new example; both changed examples are in `tsconfig.json`; Prisma examples were never in `test-examples.ts` |
| 70 | New runtime: both forms, `InferEnv`, tests per form | SKILL.md:628-648 | Does not apply | no new runtime; `Prisma.Compute` keeps its forms |
| 71 | Bindings through `<P>Bindings.Bind`, never `host.bind` from a binding | SKILL.md:537-548 | Does not apply | no binding added; `host.bind` in `Compute.ts` is the composite's own wiring (section 4) |
| 72 | SQL migrations prop | AGENTS.md:444-498 | Does not apply | no SQL resource |
| 73 | Never commit lockfile churn or Prisma `generated/contract.*` | prepare-release/SKILL.md:358-361; procedure.md:26-30 | Complies | neither in the diff |
| 74 | No stray untracked `distilled/` worktree, no regenerated example files | procedure.md:26-30 | Complies | `git status` clean |
| 75 | Never edit `submodules/distilled/src/services`; pair Alchemy-facing distilled changes | AGENTS.md:890; distilled AGENTS.md rules 2, 13 | Does not apply | submodule untouched |
| 76 | Package skills: `More:` links, absolute URLs | AGENTS.md:1350-1363 | Does not apply | no package skill touched |
| 77 | Unexplained cross-provider diffs | procedure.md:116-117 | Complies | none |
| 78 | Leaked-resource cleanup through nuke, never test-specific cleanup or adoption | AGENTS.md:1200-1214 | Complies (spot-checked) | live tests destroy through the stack; `fixtures/Live.ts` only asserts absence |
| 79 | Every claim in the description is true of the code | procedure.md:222; review.md §8 | Complies where checked | see section 6 |

## 6. What I could not check, and why

- **Type check, `pnpm lint`, `pnpm lint:providers`, `pnpm docs:check`, and every test suite.** The brief asked me not to run them, because another agent is running the full set of pull request checks in this checkout. Rows 24 to 26 and 59 depend on those results.
- **Whether every claim in the description is true.** I checked the ones that can be read from the code: every renamed and new name exists and every removed name is gone from `packages/prisma/src`; the attribute lists for `Prisma.Compute`, `ComputeService`, `ComputeVersion`, `EnvironmentVariable` and `ComputeArtifact` match the diffs; `start` and `verifyUrl` default to `true`; `ComputeVersion` defaults to `retain`; the 30-second cleanup wait (`CLEANUP_STOP_WAIT_SECONDS = 30`); the manifest check and its `ComputeVersionInvalidProps`; `ComputeServiceTooManyActiveVersions` and its message; the `getBranch` calls; `envClass` refused with `service`; `skipPromote` for a service ID; the health-check timeout message format; the five error classes moved to `ComputeLifecycle`; `ComputeCannotUpgradeInPlace` and its `alchemy state delete <address>` instructions (the CLI has `alchemy state delete`). I did not verify behavior that only a run shows, such as the order of the service delete, the per-attribute `diff` behavior, or the dev-port wait. The platform measurements ("5 times in 5", "over an hour", "seven did in the last run") cannot be checked from the repository.
- **Whether the redirect targets and the `/providers/prisma/<name>` links resolve.** I inferred it from the built site under `website/dist`, which is from this branch (it contains `ComputeArtifact`). The website worker also probes the old v1 site for `/providers/…` paths, so a link may resolve there; `pnpm docs:check` is the authority.
- **Why `ComputeService` and `ComputeVersion` were on main's "removed deep imports" list.** The history search over all of main timed out, so I could not find the commit that removed them.
- **The `alchemy-domain` references** were scanned, not read line by line, because they document how to use `@alchemy.run/domain` and contain no contributor rules.

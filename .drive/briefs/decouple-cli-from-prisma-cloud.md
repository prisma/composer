# Brief: Decouple the CLI from Prisma Cloud

**Tracker:** [Prisma Composer: Decouple CLI from Prisma Cloud](https://linear.app/prisma-company/project/prisma-composer-decouple-cli-from-prisma-cloud-bf4f2b4b51f3)
(Linear, team Terminal/TML, lead Will Madden).

**Operator:** Will Madden. Run this under the **drive process** (`/drive-process`
skill): project workspace in `.drive/projects/<slug>/`, spec + plan + design
notes, implementer subagents on Sonnet-4.6-mid, reviewers on Opus-4.8-mid.
This brief is your starting context; the design work is yours.

## Mission, one sentence

Remove every Prisma Cloud concept from the framework domain
(`packages/0-framework/**`) so that `architecture.config.json`'s
`crossDomainExceptions` entry for `cli → lowering` can be **deleted** with
`pnpm lint:deps` still passing — that deletion is the exit criterion, and it is
the only definition of done that counts.

## Why this project exists

The framework domain is defined as importing nothing:

```json
"framework": { "mayImportFrom": [], "reason": "0-framework is the innermost
domain and imports nothing but external dependencies" }
```

But Prisma Cloud semantics leak through it, held together by one escape hatch
(`architecture.config.json:589`):

```json
{ "from": "packages/0-framework/3-tooling/cli/src/**",
  "to": "packages/1-prisma-cloud/0-lowering/lowering/src/**",
  "reason": "Known debt: the CLI's pre-stack container-ensure step
  (Project/Branch resolution) is Prisma Cloud-specific today; ADR-0017's
  config-driven model should eventually absorb it" }
```

During PR #113 (state-under-branch, merged 2026-07-17) Will reviewed with
"This is a layering violation. Framework may not be aware of prisma cloud."
That PR removed the *worst* instance (state-database deletion in the CLI) by
adding a `teardown` extension hook, but deliberately left the pre-existing
leak in place and scheduled this project to remove it properly. Read PR #113's
review threads for the operator's stance.

## The leak sites, exhaustively

All paths repo-relative; verified at commit `bb31a34` (= main at the merge of
PR #113). Re-verify before designing — this repo moves fast and main has had
same-day collisions (an ADR-number collision and a broken-main incident
happened within hours during #113).

1. **`packages/0-framework/3-tooling/cli/src/ensure-containers.ts`** — the
   heart of the leak. Imports `resolveContainer`, `deleteBranch`,
   `deleteProject`, `ManagementClient`, `managementClientLayer`, `fromEnv`,
   `ResolvedContainer` from `@internal/lowering`. Resolves the app's Project
   (by name, workspace-scoped, create-if-absent on deploy / find-only on
   destroy) and a named stage's Branch (by `gitName`). Reads
   `PRISMA_WORKSPACE_ID` and `PRISMA_SERVICE_TOKEN` from env. Also contains
   `validateStageName` (git ref-name validation via `git check-ref-format`) —
   that part is target-agnostic and may belong in the framework; deciding is
   part of the design.
2. **`packages/0-framework/1-core/core/src/app-config.ts`** — the extension
   SPI. `PreflightInput` and `TeardownInput` both carry
   `projectId: string` / `branchId: string | undefined`, documented as "the
   resolved Prisma Cloud Project id". Two hooks exist: `preflight` (deploy
   prerequisite checks) and `teardown` (post-destroy cleanup; added in #113).
   Their consumers are `packages/1-prisma-cloud/1-extensions/target/src/preflight.ts`
   and `.../teardown.ts`, wired in `.../control.ts`.
3. **`packages/0-framework/3-tooling/cli/src/run-alchemy.ts`** — sets
   `PRISMA_PROJECT_ID` (always) and `PRISMA_BRANCH_ID` (named stages only) on
   the `alchemy` child process. Consumers of those env vars live in
   prisma-cloud: `target/src/control.ts` (lowering-time ids) and
   `lowering/src/state/layer.ts` (`prismaState()` reads them to address the
   stage's state database — the contract PR #113 just built; do not break it).
4. **`packages/0-framework/3-tooling/cli/src/main.ts`** — the pipeline. Step 7
   calls `ensureContainers`; the destroy tail calls the extension `teardown`
   hooks (that loop is clean — it's the pattern to imitate) and then
   `deleteStageBranch` / `deleteAppProject` (both Prisma Cloud operations via
   `ensure-containers.ts`).

Checks that police this, all run by `pnpm lint:deps`:
dependency-cruiser (`dependency-cruiser.config.mjs` + `architecture.config.json`),
`scripts/lint-architecture-coverage.mjs` (**every** source file must be
classified with `{domain, layer, plane}` — new files fail CI until added),
`scripts/lint-publishable-location.mjs`, and
`scripts/lint-framework-vocabulary.mjs`. Also `scripts/lint-casts.mjs`
(bare-`as` ratchet; use `blindCast`/`castAs` with a reason —
`.agents/rules/no-bare-casts.mdc`). New workspace subpaths need an alias in
`tsconfig.depcruise.json` or the coverage check rejects them (this exact miss
broke main once already during #113).

## Settled direction (operator-agreed; refine, don't relitigate)

- **Container resolution becomes a target-supplied step.** ADR-0017's
  config-driven model is the named absorber: the extension descriptor (see
  `ExtensionDescriptor` in `app-config.ts` and its implementation in
  `target/src/control.ts`) grows the container-ensure/teardown behaviour the
  CLI currently hard-codes. The `preflight`/`teardown` hook pattern is the
  proven template — the CLI iterates `config.extensions` and calls hooks
  blind.
- **The product of container resolution reaches core as an opaque,
  target-owned value.** Main's ADR-0033
  (`docs/design/90-decisions/ADR-0033-lowering-types-are-defined-by-their-readers.md`)
  is the exact idiom to reuse: values are typed by their readers; core carries
  `unknown`, the owning extension narrows with its own guard. The hooks'
  inputs then carry that context instead of named `projectId`/`branchId`
  fields.
- **Child-process env becomes something the extension contributes** rather
  than names the CLI knows. `run-alchemy.ts` should thread an
  extension-provided env map, not `PRISMA_*` literals.
- What stays: `deleteBranch`/`deleteProject`/`resolveContainer` code itself
  (it moves *behind* the extension boundary, it doesn't disappear); the
  deploy pipeline's ordering guarantees (containers before Alchemy — ADR-0024;
  destroy's find-only semantics; teardown before container removal).

## Design questions you must settle (not pre-decided)

- Where `validateStageName` lands (generic git-ref validation vs
  target-supplied).
- Whether the destroy tail's container deletion folds into the existing
  `teardown` hook, becomes a second hook, or a target-supplied "containers"
  descriptor with ensure/teardown pairs. Watch ordering: state teardown must
  run before Branch deletion (a Branch with an attached database refuses
  deletion — ADR-0034).
- How the CLI's error surface keeps naming fixes ("environment variable
  PRISMA_WORKSPACE_ID is required") when the CLI no longer knows the
  variable names — the errors must stay operator-actionable
  (`deploy-cli.md` § Error surface).
- Migration for `--name`/`--stage` flag semantics (`main.ts` step 7's
  create-if-absent vs find-only split) through an opaque interface.

## Binding context — read before designing

- `CLAUDE.md` (repo root) and **`docs/design/01-principles/`** — binding, not
  advisory. ADR-0005 (no guessing) especially.
- `docs/design/90-decisions/`: **ADR-0017** (control plane loads through the
  config; registries; descriptors), **ADR-0023/0024** (app = Project, stage =
  Branch; two-phase deploy, containers resolved before Alchemy),
  **ADR-0028** (numbered domains/layers, dependency-cruiser enforcement),
  **ADR-0033** (types defined by readers — the opacity idiom),
  **ADR-0034** (state lives in the stage's Branch — the contract that consumes
  the threaded ids today).
- `docs/design/10-domains/deploy-cli.md` — the pipeline, § Stages and
  containers, § Error surface.
- `.agents/rules/` — all of it. Also `.drive/CODE-REVIEW.md` (mandatory
  jargon sweep for reviews).
- The `teardown` hook commit on main ("fix(state): teardown is the target's
  job, and the review's vocabulary lands") — the worked example of moving a
  CLI-owned Prisma Cloud behaviour behind a hook, including test strategy
  (CLI tests stub an extension and assert the hook contract; the extension's
  own tests cover real behaviour with a fake Management API client).

## Process rules that will bite you if skipped

1. **An ADR and its implementation ship in ONE PR.** Never a docs-only PR
   ("a docs PR on its own is useless" — operator, verbatim). This change
   needs an ADR (it supersedes/amends parts of ADR-0017's consequences and
   the deploy-cli domain doc); write it and land it with the code.
2. **No invented vocabulary.** "control" is a plane identifier, never a
   countable noun; registry entries are "descriptors"; "seam" was purged
   twice repo-wide — do not reintroduce it; name types with words the
   codebase already uses (`ResolvedContainer` exists — a rename to something
   opaque is part of your design, but check for collisions: "target" means
   the deploy target, ADR-0011). The operator reads every comment and has
   rejected work over naming.
3. **Comments:** only what the code cannot express. Test names in plain
   English describing observable behaviour.
4. **Assert platform/tooling behaviour from implementations, not schemas or
   adjacent artifacts.** During #113 four confident claims (an endpoint's
   parameters, its atomicity, a CI check's existence, a latency cause) were
   wrong because they were read off input shapes, comments, or misattributed
   logs. Read the function body; run the check.
5. **Verify live, not just in tests**, before opening the PR: credentials via
   `cp /Users/will/Projects/prisma/makerkit/.env <worktree-root>/.env`, then
   `pnpm run deploy` (never bare `pnpm deploy` — it's a pnpm builtin). Known
   trap: a bootstrap failure saying "Failed to identify your database" is
   usually an account-level Prisma Postgres restriction, not your bug — never
   delete a `prisma-composer-state` database to "fix" it. A failed deploy
   strands its Project/Branch/default-database — clean up after failed runs.
6. **CI facts:** only DCO is a required check. The e2e deploy workflow uses
   one repo-wide concurrency slot (`group: e2e-deploy`,
   `cancel-in-progress: false`) — pending runs get replaced by newer ones, so
   e2e results on busy afternoons take patience; job `timeout-minutes: 3` is
   reported by GitHub as "cancelled", which looks like queue contention but
   may be a timeout — check durations. Main can be red; check main's CI
   before diagnosing your own branch.
7. **Rebase hygiene:** main moves multiple times a day; expect ADR-number
   races (claim your number late, check `docs/design/90-decisions/` on main
   at PR time) and re-verify auto-merged files by hand.
8. **GitHub identity:** all git/GitHub operations as the `wmadden-electric`
   bot (env is pre-wired in agent shells); commits with `-s` plus
   `--trailer "Signed-off-by: Will Madden <madden@prisma.io>"`; push via the
   `bot` remote; PR bodies end with the Claude Code attribution footer;
   repo convention has no Co-Authored-By trailer.

## Adjacent context (don't break, don't absorb)

- **Successor consumer:** the planned GitHub App integration (push-to-deploy
  via pdp-control-plane) will run `prisma-composer deploy` in a sandbox with
  pinned Project/Branch ids and a project-scoped token, and wants a
  "fail rather than create" container mode. Design the opaque-context
  interface so a pinned/no-create mode is expressible later; do not build it.
- **Close-out debt you inherit:** `.drive/projects/state-under-branch/` (the
  previous project's workspace) awaits deletion; fold its removal into your
  first PR (verify its ADR/doc content already lives in `docs/` first — it
  does; the successor-project seed notes were migrated to the Linear
  projects).
- In-flight elsewhere (don't duplicate): a fix for `postgres/Database.ts`'s
  create-then-attach stray-database window; a `ci-cleanup-utils.ts` comment
  correction. Both were spawned as separate sessions from #113.

## Definition of done, restated

- `crossDomainExceptions` entry for `cli → lowering` deleted;
  `pnpm lint:deps` passes.
- `git grep -rn "@internal/lowering" packages/0-framework/ --include='*.ts'`
  returns nothing (source only; ignore `dist/`).
- No `projectId`/`branchId`/`PRISMA_*` vocabulary in
  `packages/0-framework/**` source.
- Full gates: workspace `turbo run test typecheck`, biome, cast ratchet
  delta ≤ 0, `lint:deps`, architecture coverage.
- A live deploy → destroy round trip against the dogfood workspace behaves
  identically to before (zero residue; state on the stage's Branch).
- ADR merged in the same PR; ADR index updated; stale references swept
  (grep the docs for the old model, as #113's done-condition did).

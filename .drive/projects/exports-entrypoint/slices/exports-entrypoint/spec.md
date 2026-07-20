# Slice spec — public entrypoints move to `src/exports/`, exports maps become generated

Orphan slice. This document is the slice contract and dispatch plan; at PR-open
time the spec section is injected into the PR description. Investigation notes
live in [exports-entrypoint-plan.md](./exports-entrypoint-plan.md).

## At a glance

Adopt prisma-next's exports/entrypoint pattern across the Composer workspace:
every package's public subpaths become files under `src/exports/`, the shared
tsdown base generates each `package.json#exports` map from those entries, and
`architecture.config.json` keys plane assignments to entrypoint files instead
of listing every source file. Published subpath keys do not change.

## Chosen design

- **`src/exports/*.ts` is the only public surface.** One file per published
  subpath. Internal implementation stays where it is at the `src/` root — the
  presence of `src/exports/` is the separation; no `src/core/` shuffle.
- **`tsdown.config.ts` entries list only `src/exports/*.ts`.**
- **`@internal/tsdown-config` generates the exports map.** Port prisma-next's
  `customExports` hook (strip the `exports/` prefix, `./` → `.`, single-entry
  collapse fix) and switch `exports: true` to
  `{ enabled: 'local-only', customExports, exclude: [/bin\./] }`. Dist stays
  flat (`dist/control.mjs`); generated maps are committed. Workspace tsdown is
  0.22.4 — the same version prisma-next runs this hook on.
- **Plane globs key off entrypoints.** `architecture.config.json` maps each
  `src/exports/<name>.ts` to its plane plus one `src/**` fallback per package;
  the current 61 mostly-per-file globs collapse. Existing plane assignments
  carry over unchanged.
- **Pure relocation, no renames.** Public entrypoint files move into
  `src/exports/` keeping their filenames; internal modules stay at the `src/`
  root. The `app-config.ts → config.ts` rename considered earlier is
  **dropped**: core keeps an internal `config.ts`, so renaming would put two
  `config.ts` files on `exports/deploy.ts`'s import list (`./config.ts` sibling
  vs `../config.ts` internal) — the exact ambiguity this slice removes. Keep
  `app-config.ts`'s filename and the object entry `config:
  'src/exports/app-config.ts'` (a one-line, commented mapping — the status
  quo). Same reasoning applies to `target/src/pg-connection.ts`: judge in D4,
  default to no rename.
- **ADR + rule ship in this PR** (repo policy: no docs-only PRs): ADR-0033 for
  the decision, `.agents/rules/exports-entrypoints.mdc` for the day-to-day
  rule.

## Coherence rationale

One idea applied everywhere: "public = `src/exports/`". Splitting it across
PRs would leave the workspace half-converted, with two conventions for the
rule and the depcruise config to describe. The diff is large but almost
entirely `git mv` + regenerated manifests, reviewable in one sitting by
checking the invariant (subpath key sets unchanged) rather than every hunk.

## Scope

**In:**

- `@internal/tsdown-config` generation change.
- All 15 workspace packages moved to `src/exports/` entrypoints; hand-written
  exports maps replaced by generated ones wherever generation works.
- `architecture.config.json` rewrite; depcruise still enforces the same
  boundaries.
- ADR-0033, `exports-entrypoints.mdc`, touch-ups to
  `test-import-patterns.mdc` and ADR-0028 cross-references.

**Deliberately out:**

- Any change to published subpath keys or their runtime behavior.
- Restructuring internals into `src/core/` (prisma-next does this for
  multi-plane packages; not needed here).
- Website, examples, and test/** packages (no published surface).
- Renaming the `@internal/*` packages or moving directories.

## Pre-investigated edge cases

| Case | What's known |
| --- | --- |
| Public packages' conditional exports | `@prisma/composer` and `@prisma/composer-prisma-cloud` hand-maintain `{types, default}` maps "for dts bundling", and composer's bin must stay non-importable. Try generation first; keep a manual map only where consumer type resolution demonstrably breaks, and record the exception in the rule. |
| `customExports` on pre-move packages | The hook strips an `exports/` prefix that pre-move entries don't have — a no-op — so the tooling change can land first without breaking anything. |
| Single-entry packages (`rpc`, `assemble`) | tsdown collapses one entry to `.`; prisma-next's hook derives the subpath from the output filename. `index.ts` must still map to `.` — covered by the ported hook, verify in D1. |
| Nested subpaths (`./cron/scheduler-entrypoint`) | Entry keys with slashes (or nested dirs under `exports/`) produce nested subpath keys; composer-prisma-cloud needs this. |
| Stale comment in tsdown-config | The base config's comment claims tsdown 0.15.x; actual is 0.22.4. Fix in D1 so nobody "fixes" the config back. |
| Glob precedence in depcruise | Specific `src/exports/*.ts` globs must win over the `src/**` fallback; verify a known-bad import still fails `pnpm lint:deps`. |

## Slice-specific done conditions

- Every generated `package.json#exports` has the **identical subpath key set**
  to before the change (diff captured in the PR description for the two
  `@prisma/*` packages).
- `pnpm lint:deps` passes, and a deliberately wrong import (control-plane file
  importing execution-plane code) still fails it.
- One example app builds against the rebuilt public packages.

## Open questions

None blocking. The conditional-exports question above resolves inside D5 with
evidence, not up front.

## References

- prisma-next: `.agents/rules/multi-plane-packages.mdc`,
  `no-barrel-files.mdc`, `cli-package-exports.mdc`,
  `packages/0-config/tsdown/base.ts` (the `customExports` hook to port),
  `docs/architecture docs/Package-Layering.md` § Package Exports Pattern.
  Clone at `<scratchpad>/prisma-next`.
- Composer investigation: [exports-entrypoint-plan.md](./exports-entrypoint-plan.md).
- ADR-0028 (numbered domains/layers, depcruise), `.agents/rules/no-bundling.mdc`,
  `test-import-patterns.mdc`.

---

# Dispatch plan

Sequential; one commit (or a few) per dispatch so every commit builds green.
Implementers: Sonnet-4.6-mid. Reviewers: Opus-4.8-mid.

**Gate (all remaining dispatches, tightened after D2's gap).** Every dispatch's
validation gate runs the FULL `pnpm test` (not package-scoped) plus a grep for
the moved file paths across `test/`, `examples/`, and sibling packages — a
consumer can couple to a moved file by hardcoded filesystem path, which a
package-scoped test never catches. Plus `pnpm build && typecheck && lint &&
lint:deps` and the per-package subpath-key parity diff.

**architecture.config.json sequencing (decided during D1 review).** Plane
assignments are currently per-file globs. To keep `pnpm lint:deps` green at
every commit, each package-move dispatch (D2–D5) does a **1:1 glob repoint**
for its own package — rewrite that package's existing glob paths from
`…/src/<name>.ts` to `…/src/exports/<name>.ts`, no collapsing, no fallback
globs. D6 then does the collapse (per-entrypoint globs + one `src/**`
fallback per package) and proves glob precedence with a seeded violation. This
isolates the precedence risk to D6 while keeping the intermediate commits
green.

## D1 — tsdown-config generates exports maps

- **Outcome:** `@internal/tsdown-config` base carries the ported
  `customExports` hook with `exports: { enabled: 'local-only', customExports,
  exclude: [/bin\./] }`, the stale version comment is fixed, and a full
  workspace build produces zero `package.json` diffs (hook is a no-op
  pre-move).
- **Builds on:** origin/main.
- **Hands to:** a base config every later dispatch's rebuild flows through.
- **Focus:** copy prisma-next's hook faithfully (including the single-entry
  collapse fix); don't redesign it.
- **Completed when:** hook in place; `pnpm build` green; `git status` shows no
  manifest churn; packages still using `exports: false` untouched.

## D2 — foundation + core move to `src/exports/`

- **Outcome:** `@internal/foundation` (`assertions`, `casts`, `secret`) and
  `@internal/core` (`index`, `deploy`, `testing`, `app-config`) build from
  `src/exports/` with generated maps; subpath keys byte-identical. Internal
  modules (core's `config.ts`, `contract.ts`, `graph.ts`, `node.ts`,
  `hydrate.ts`, `load-*.ts`, `toposort.ts`, `graph-types.ts`) stay at the
  `src/` root.
- **Builds on:** D1's generating base.
- **Hands to:** the two innermost packages proven on the pattern.
- **Focus:** `git mv` entrypoints into `src/exports/`; fix relative imports
  (`./x.ts` → `../x.ts` for internals, sibling `./y.ts` for other
  entrypoints); fix within-package test import paths; repoint core's tsdown
  entries to `src/exports/*.ts` keeping the object entry `config:
  'src/exports/app-config.ts'`; 1:1 repoint of foundation's + core's
  `architecture.config.json` globs to the new paths (no collapse — that's D6).
  **Hazard:** `exports/deploy.ts` imports both the internal `../config.ts` and
  the sibling entrypoint `./app-config.ts` — keep them distinct; typecheck is
  the proof.
- **Completed when:** both packages build with generated maps; subpath key
  sets identical (diff shown); `pnpm test` green for both; `pnpm lint:deps`
  green; dependent packages still build.

## D3 — remaining framework packages (node, nextjs, rpc, assemble, cli)

- **Outcome:** all `@internal` framework packages expose only `src/exports/`
  entrypoints with generated maps; `cli`'s `bin.ts` stays internal and
  non-importable (covered by the D1 exclude).
- **Builds on:** D2 (pattern proven; core's exports files are what these
  packages import).
- **Hands to:** the whole framework domain converted.
- **Focus:** mechanical fan-out; `rpc`/`assemble` exercise the single-entry
  case. **Convert array entries to object entries with explicit names**
  (`{ index: 'src/exports/index.ts', control: 'src/exports/control.ts' }`) so
  the entry name — not tsdown's path-derived chunk name — fixes the export key
  (`index` → `.`, `control` → `./control`) and the flat `dist/` filename. This
  guarantees subpath-key parity under the `src/exports/` move without depending
  on tsdown's array-naming heuristic (which may not preserve the root `.` key
  for `src/exports/index.ts`). `nextjs/control.ts` imports `./index.ts` — becomes
  a sibling import in `exports/`.
- **Completed when:** five packages build with generated maps, key sets
  identical, tests green, `bin` absent from cli's exports.

## D4 — prisma-cloud packages (SPLIT into D4a + D4b)

Split decided during D3 prep: the five packages have three different shapes.
The primary goal is the `src/exports/` source separation; a generated exports
map is opportunistic and **unsafe for multi-pass packages** (each build pass
would clobber the others' export map), so those keep their hand-maintained map.

### D4a — lowering + target (singleton-pass, generated-map candidates)

- **`lowering`** (inherits base): its public entrypoints are subdirectory index
  barrels — `src/index.ts`, `src/compute/index.ts`, `src/postgres/index.ts`,
  `src/state/index.ts` mapping to `.`, `./compute`, `./postgres`, `./state`.
  Flatten each into `src/exports/<name>.ts` (rewrite the barrel's `./x.ts`
  imports to `../<subdir>/x.ts`); the subdirs keep their implementation files.
  Object entries `{ index, compute, postgres, state }` preserve the **keys**;
  `dist/` flattens (`dist/compute/index.mjs` → `dist/compute.mjs`, a value
  change only). architecture.config.json: `lowering/src/**` glob covers it — no
  change.
- **`target`**: move the 5 entrypoints (`index`, `control`, `prisma-next`,
  `testing`, `pg-connection`) into `src/exports/`; internals (`descriptors/`,
  `pn-*`, `pg-warm-resource`, `serializer`, `service-keys`, `compute`,
  `postgres`, `http`, `s3-*`, `secret`, `param`, `preflight`) stay at root.
  Object entry `connection: 'src/exports/pg-connection.ts'` keeps the
  `./connection` key without a rename. **Generation probe:** drop
  `exports: false` and let the map generate; the workspace build (which builds
  `composer-prisma-cloud`, the dts-bundling consumer) is the test. If dts
  resolution breaks, **revert target to the hand-maintained `{types,default}`
  map and document why** (exception, per the rule). Repoint target's 5
  entrypoint globs in architecture.config.json 1:1 (control → control; index,
  prisma-next, testing, pg-connection → shared).
- **Completed when:** both build, key sets identical, tests green,
  lint:deps green, and the target generated-vs-manual finding is recorded.

### D4b — cron + storage + streams (multi-pass; keep `exports:false`)

- Each has a multi-pass tsdown config where the `*-entrypoint` file is built in
  its own pass with `noExternal`/`external`/`inlineDynamicImports` because
  `assemble()` copies it out standalone. **Preserve the multi-pass structure
  exactly.**
- Move the public entrypoints into `src/exports/` (`index`,
  `<name>-service`, `<name>-entrypoint`, and `testing` for storage/streams);
  internals (`contract`, `module`, `schedule`, `scheduler`, `handler`, stores,
  `sigv4`, servers, etc.) stay at root. Update each pass's entry SOURCE paths to
  `src/exports/...` and fix imports.
- **Keep `exports: false` + the hand-maintained map** — object keys preserve the
  output filenames, so the map's dist values don't change (verify byte-identical
  map). Generation is unsafe across passes.
- architecture.config.json: these use `src/**`-style globs with a few per-file
  plane overrides (e.g. cron's `scheduler-service`/`scheduler-entrypoint` →
  execution) — repoint only the per-file entrypoint globs 1:1.
- **Completed when:** three build, exports maps byte-identical, tests green,
  lint:deps green, the standalone `*-entrypoint` bundles still build in their
  own passes.

## D5 — public packages (composer, composer-prisma-cloud) — source-only move, KEEP hand-maintained maps

Decision (D5 prep): both published packages **keep `exports: false` + their
hand-maintained maps**. They're the published API contract; `composer` has a
`bin` field + 2-pass build, `composer-prisma-cloud` has a 9-pass build with
nested `outDir`s and a framework-externalizing resolve plugin — generation is
clobber-prone across passes for marginal benefit. The target probe (D4a)
already proved generation is dts-safe, so keeping hand-authored maps here is a
deliberate choice, not a failure. This is a **source-only move**: entrypoints
into `src/exports/`, everything else preserved, dist + map + bin field
byte-identical.

- **composer** (`packages/9-public/composer`): move the 11 thin re-export
  entrypoints (`index`, `config`, `deploy`, `testing`, `casts`, `assertions`,
  `rpc`, `node`, `node-control`, `nextjs`, `nextjs-control`) into `src/exports/`;
  they `export * from '@internal/...'` so NO relative-import fixes. Repoint the
  library pass's entry source paths to `src/exports/…`; keep the bin pass
  (`bin: '../../0-framework/3-tooling/cli/dist/bin.mjs'`) unchanged — it reads
  cli's dist, not a src file. Keep `exports:false`, the hand-maintained map, and
  the `bin` FIELD (`{"prisma-composer": "./dist/bin.mjs"}`) untouched. Repoint
  the 11 per-file arch-config globs 1:1.
- **composer-prisma-cloud** (`packages/9-public/composer-prisma-cloud`): move
  the 9 thin re-export entrypoints (`index`, `control`, `prisma-next`, `testing`,
  `cron`, `storage`, `storage-testing`, `streams`, `streams-testing`) into
  `src/exports/`. Update ONLY the passes whose entries are `src/…` paths
  (passes 1,2,4,6,7,9); the re-emit passes (3,5,8) read `@internal/*/dist/*.mjs`
  — unchanged. Keep the resolve plugin, nested `outDir`s, `exports:false`, and
  the hand-maintained map (with nested keys) intact. Repoint the 5 existing
  per-file arch-config globs 1:1 (`control`→control; `index`, `prisma-next`,
  `testing`, `cron`→shared); the `storage`/`streams`/`*-testing` entries are
  unmapped today (leave them — a D6/follow-up concern like storage/streams).
- **Builds on:** D4b (all `@internal` packages converted).
- **Hands to:** the full workspace converted; published surface verified stable.
- **Completed when:** both build; `package.json#exports`, `dist/` file list, and
  `composer`'s `bin` field all byte-identical to HEAD; full `pnpm test` green;
  bin non-importable; an example app builds + typechecks against the rebuilt
  packages.

## D6 — DROPPED (collapse blocked by a latent normalizer bug)

D6's `src/*.ts` collapse was attempted and abandoned: `normalizeGlob` in
`dependency-cruiser.config.mjs` produces `^…/src/[^/]*.ts` (no `$` anchor,
unescaped dot), so `src/*.ts` wrongly matches `src/exports/deploy.ts` (via
"expo"+`.`r+"ts") — entrypoints land in two plane groups and `lint:deps` goes
red. The collapse was maintainability polish; the blocker is a normalizer bug
that's a separate concern (the enforcement engine, not exports/entrypoint work).
**Decision: drop the collapse, keep the correct per-file globs (green), flag the
normalizer bug as a follow-up (spawned task `task_b355e69d`), and fold the
finding into D7's ADR.** D1–D5 use no wildcard-file globs, so the bug is dormant.
The original rescoped intent is preserved below for the follow-up's reference.

### (Superseded) D6 — architecture.config.json simplification

**Critical finding (D6 prep): the `src/**` fallback is INFEASIBLE.**
`dependency-cruiser.config.mjs` has NO glob precedence — it buckets every glob
by `{domain}-{layer}-{plane}` and a file belongs to a group if ANY of that
group's globs match. A `src/** → shared` fallback OVERLAPS a specific
`src/exports/control.ts → control` glob, putting `control.ts` in BOTH plane
groups → false violations (shared can't import control) or masked real ones. The
current per-file globs work precisely because they're non-overlapping. So D6
does a NON-overlapping simplification, not a fallback.

- **Outcome:** collapse per-root-file internal globs to `src/*.ts` ONLY where a
  package's root internals all share one plane. The normalizer maps `*` to
  `[^/]*`, so `src/*.ts` matches root files but NOT `src/exports/…` — no overlap
  with the entrypoint globs. **core** qualifies: 9 shared root globs → one
  `src/*.ts → shared`, alongside its 4 `src/exports/*.ts` globs (13 → 5). Any
  other package whose root internals are uniform-plane gets the same; **mixed-
  plane roots (target)** and **already-single-glob packages** (rpc/assemble/cli/
  lowering `src/**`, foundation `0-foundation/**`) stay as-is.
- **The unmapped gap — DOCUMENT, do not add globs.** `storage`, `streams`, and
  cpc's `storage`/`streams`/`*-testing` files have NO globs today (pre-existing,
  from before this slice). Adding plane globs would impose NEW enforcement on
  pre-existing code and could surface pre-existing (or false) violations — scope
  creep orthogonal to the exports/entrypoint move. Leave them unmapped; record
  the gap as a known follow-up (a comment in `architecture.config.json` and/or a
  line in the D7 ADR). Do NOT expand this slice to fix plane-mapping
  completeness.
- **Builds on:** D5 (final file locations settled).
- **Focus:** every glob change must keep the mapping NON-overlapping — verify no
  file lands in two plane-groups. Prove enforcement by seeding a deliberately-bad
  import (a control-plane file importing execution-plane code), confirm
  `lint:deps` fails, then revert the seed.
- **Completed when:** `pnpm lint:deps` green; the seeded violation fails; no
  file's effective plane changed relative to pre-D6 (spot-check core's
  entrypoints + a few internals); glob count meaningfully reduced where safe.

## D7 — ADR, rule, doc touch-ups, final verification

- **Outcome:** ADR-0033 ("public entrypoints live in `src/exports/`; the
  exports map is generated") and `.agents/rules/exports-entrypoints.mdc`
  exist; `test-import-patterns.mdc` examples and ADR-0028 cross-references
  updated; full suite green.
- **Builds on:** D6 (documents what now exists, including any D5 manual-map
  exception).
- **Hands to:** PR-open (spec section of this doc injected as the
  description).
- **Focus:** rule states the add-a-subpath procedure (add file → add entry →
  build → commit manifest → declare plane); keep both docs terse.
- **Merge reconciliation (also at PR-open):** rebase onto current origin/main
  and fold the upstream cli `./report` subpath into cli's `src/exports/`
  structure (`src/exports/report.ts` + tsdown entry). Recommend **squash-merge**
  to the operator (collapses the D3 intermediate red window into one green
  commit). Also fix the stale `.agents/rules/tsdown-config-package-source-only.mdc`
  path/name (`packages/tsdown-config` / `@prisma/composer-tsdown` →
  `packages/0-framework/0-foundation/tsdown-config` / `@internal/tsdown-config`).
- **Completed when:** `pnpm build && pnpm typecheck && pnpm test && pnpm lint
  && pnpm lint:deps` all green at the branch tip; ADR indexed in the
  90-decisions README.

# Learnings — exports/entrypoint slice

## `git add <old-path>` after `git mv` fails atomically and silently under-stages (D2)

After `git mv src/foo.ts src/exports/foo.ts`, a follow-up `git add src/foo.ts …`
(listing the pre-move path) fails as a whole because the old path is gone — so
OTHER files in the same `git add` (the moved file, tsdown.config.ts) are left
unstaged, and the commit captures only the renames. That commit would not build
green alone. Caught in D2 (foundation) and fixed by amend.
**Apply to D3–D5:** stage post-move paths only; after committing each package,
verify the commit is self-contained (`git stash && pnpm build --filter <pkg>`
or inspect `git show --stat`). Prefer `git add <dir>/src/exports <dir>/tsdown.config.ts`.
**Cross-package variant (bit again in D4b):** when several packages have pending
`git mv`s at once, a scoped commit for package A can inherit package B's already-
staged renames (git mv stages immediately). The D4b storage commit swept in
streams' renames; caught via `git show --stat`, `reset --soft`, re-split.
**Always `git show --stat` (or `--name-only | grep <other-pkg>`) before treating
a per-package commit as done.**

## Object entries with explicit names are the parity-safe mechanism (D2→)

Entry name (object key) — not tsdown's path-derived chunk name — fixes both the
export subpath key and the flat `dist/` filename. `index` → `.`, `control` →
`./control`. Array entries under `src/exports/` risk the root `.` key. All
dispatches convert to/keep object entries. The `customExports` prefix-strip hook
stays as a safety net but is dormant for object-named entries.

## Pre-existing gap: storage + streams have no architecture.config.json globs (found in D4 prep)

`@internal/storage` and `@internal/streams` have zero entries in
`architecture.config.json` — they're unmapped for plane enforcement, yet
`pnpm lint:deps` passes (depcruise doesn't require every package mapped).
Orthogonal to this slice (moving files within `src/` doesn't change it), so
D4b makes no glob change for them. **Flag for D6:** the config rewrite should
decide whether to add proper globs for these two, or leave them intentionally
unmapped. Not a reason to expand the exports/entrypoint slice.

## Gate gap: package-scoped tests miss hardcoded cross-package PATH references (D2→D3)

D2 moved `core/src/index.ts` → `src/exports/index.ts`. `@internal/cli`'s
`run.test.ts` hardcodes core's `src/index.ts` filesystem path (to write a temp
module), so D2 broke 24 cli tests — but D2's gate only ran foundation+core
package-scoped tests and missed it. D3 caught it (full `pnpm test`) and fixed
the path in the cli commit. **Root cause (orchestrator):** the D2 gate should
have included the workspace-wide test command — the build-slice cross-package
rule warns that moving/renaming a surface needs the full suite + a grep for
references, because consumers can couple by hardcoded PATH, not just import
specifier. **Applied:** every remaining dispatch's gate includes full
`pnpm test` + a grep for the moved paths across `test/`, `examples/`, and
sibling packages.

## Accepted: intermediate red window on commits 069ba02..b390d01 (D3 decision)

Because the cli test-path fix landed in the D3 cli commit (`08efb61`), not the
D2 core commit (`069ba02`) that introduced the break, commits `069ba02`
through `b390d01` have cli's 24 run() tests red; the branch TIP is fully green.
**Decision:** accept the red window rather than rewrite 6 bot-signed commits
(history surgery is error-prone; the fix is in cli's own test file, so it's
ownership-appropriate in the cli commit). **Clean resolution = squash-merge**
(single green commit), which is the likely merge mode for this refactor.
Recommend squash-merge at PR-open; flag for the operator.

## Merge-time reconciliation: upstream added cli `./report` (found in D3)

origin/main advanced DURING the session (branch was an ancestor at session
start) and gained a cli `./report` subpath this branch never had. At PR-open,
rebasing onto current origin/main must fold `./report` into cli's new
`src/exports/` structure (add `src/exports/report.ts` + tsdown entry so the
generated map includes `./report`). Bounded, known task. **Deferred to D7 /
PR-open** — rebasing mid-slice would disrupt D4–D6; reconcile once at the end.

## RESOLVED: target's generated exports don't break the public dts bundle (D4a)

The slice's main open question. target's hand-maintained `{types,default}` map
existed "for the public packages' dts bundling." D4a dropped `exports:false` and
generated the string-form map; the full build — including
`@prisma/composer-prisma-cloud`, which rolls up target's `.d.mts` — and
`pnpm typecheck` both stay green. So the conditional form was unnecessary;
generated string form suffices (TS finds the sibling `.d.mts`). No manual-map
exception needed. This de-risks D5 (the public packages).

## REVERSED: internal code importing "up" into src/exports/ (D4a → thin-exports slice)

**This entry recorded an accepted characteristic that has since been rejected.
Kept for the history of how it happened.**

Originally: target's `pg-connection.ts` and `prisma-next.ts` were IMPLEMENTATION
homes (not thin re-exports), and three internal modules imported them from
`src/exports/` (`pg-warm-resource.ts`, `prisma-next-migrate.ts` →
`./exports/pg-connection.ts`; `descriptors/prisma-next.ts` →
`../exports/prisma-next.ts`). That inverts prisma-next's shape, was green
(lint:deps clean — compatible planes), and was ACCEPTED as a consequence of the
slice's deliberate relocation-not-refactor choice, with the purer form noted as
an optional future refactor.

**The operator rejected it.** The follow-up slice (branch
`claude/exports-thin-surfaces`) made the stricter rule binding: `src/exports/*.ts`
holds nothing but re-exports, and no implementation module may import from
`exports/`. All three inversions above are gone. The lesson worth keeping: an
exports file that CAN hold implementation eventually does, and then internal
modules import it, and the published surface becomes something the package's own
internals depend on. "It's green and it's only a relocation" was true and still
the wrong call — greenness under the current rules is not evidence the shape is
right. ADR-0035 now records the strict rule.

## Grep lessons for moving public files (D4a — applied going forward)

Two ways a move breaks despite a `from '...'` grep: (1) INTERNAL non-test source
files import the public entrypoint (target's impl homes) — grep ALL of `src/`,
not just tests + cross-package; (2) DYNAMIC `await import('../x.ts')` string
literals aren't matched by a `from '...'` grep and pass build+typecheck but fail
at test LOAD time — full `pnpm test` is what catches them (validates the D2
gate-tightening). Sweep string literals too.

## Relaxed invariant: dist ENTRY filenames are sacred, internal chunk hashes may churn (D4b decision)

Moving `<x>-service.ts` into `src/exports/` changed its module ID, so rolldown's
internal CONTENT-HASHED shared chunk (imported by both `index` and the service
entry) rehashed for storage + streams (cron was immune — its shared chunk
derives from the unmoved `scheduler.ts`). The implementer correctly halted on my
"byte-identical dist file list" stop-condition. **Decision: ACCEPT the chunk
churn.** That stop-condition was an over-strict proxy for its real intent —
runtime `import.meta.url` sibling resolution — which is preserved: the ENTRY
files (`index.mjs`, `<x>-service.mjs`, `<x>-entrypoint.mjs`, `testing.mjs`) are
byte-identical, the packages are `private` (chunk names never reach npm),
`composer-prisma-cloud` re-bundles from entries and inlines the chunk, nothing
in the repo pins a hashed chunk name (verified — only `.turbo` build logs), and
full `pnpm test` is green incl. the streams real-server integration test.
**The real invariant going forward:** dist ENTRY filenames + `package.json#exports`
byte-identical; internal content-hashed chunk names are allowed to churn. **D7
ADR/rule must state this** so the next mover isn't surprised.

## D6 collapse DROPPED — latent normalizer bug makes `src/*.ts` overlap `src/exports/` (D6)

The D6 `src/*.ts` collapse premise was wrong. `normalizeGlob` in
`dependency-cruiser.config.mjs` turns `src/*.ts` into `^…/src/[^/]*.ts` — with NO
`$` end-anchor and an UNESCAPED dot (only wildcard-free filenames get `^…$`). So
it matches `…/src/exports/deploy.ts`: `[^/]*`=`expo`, `.`=`r`, `ts`=the `ts` in
"exports", and no anchor ignores the `/deploy.ts` tail. Result: entrypoints land
in two plane groups, `lint:deps` exit 2 with false shared→control violations. The
implementer caught it via the required seeded-proof step, reverted, committed
nothing. **Decision: DROP the collapse** — it was maintainability polish, it's
blocked by a normalizer bug that's a SEPARATE concern (the enforcement engine,
not exports/entrypoint work), and the config is correct + green as per-file
globs. D1–D5 use no wildcard-file globs, so the bug stays dormant.

**RESOLVED in D9.** The operator asked why we hadn't just fixed it, and we did:
`normalizeGlob` (which had moved to `scripts/architecture-coverage.mjs`, shared
by the cruiser and the fail-closed coverage check) now treats a dotted last
segment as file-like even with a wildcard (anchor `$`) and escapes literal dots
in the literal parts. Proven to change nothing on the existing config by
enumerating every source file's resolved {domain, layer, plane} under the old and
new normalizer and diffing — identical across all 144 files. The collapse then
landed: core 13→5, cron 8→4, streams 7→5 globs, with a seeded shared→execution
violation confirming the rules still bite. The lesson: a "separate concern"
blocking a cleanup is worth pricing before dropping the cleanup — the fix was
about ten lines and a proof harness.

## depcruise has NO glob precedence — the `src/**` fallback would break plane enforcement (D6 prep)

`dependency-cruiser.config.mjs` buckets every `architecture.config.json` glob by
`{domain}-{layer}-{plane}` and a file joins a group if ANY of its globs match —
there is no most-specific-wins or first-match. So the plan's "`src/**` fallback +
specific `src/exports/control.ts → control` overrides" would put `control.ts` in
BOTH the shared and control groups → false violations or masked ones. The current
per-file globs work because they're non-overlapping. **D6 must keep globs
non-overlapping.** Safe reduction: `src/*.ts` (`*`=`[^/]*`, doesn't cross into
`src/exports/`) replaces per-root-file internal globs where the root is
uniform-plane (core: 13→5). Mixed-plane roots (target) and single-`src/**`
packages stay. This is why I checked the depcruise matcher BEFORE writing D6.

## biome re-sorts/wraps imports after path changes (D2)

Rewriting `./x.ts` → `../x.ts` reorders imports (biome sorts `../` before `./`)
and can push a longer path over the 100-char line width. Expected fallout: run
`biome check --write` on affected files, confirm hunks are pure reorder/wrap,
re-run tests. Not a design change.

## Thin-exports slice traps (T1–T4)

Three things bit while converting 21 exports files to thin re-exports:

- **`export *` silently drops a `default` export.** The three `*-service.ts`
  modules and node/nextjs's build adapters all default-export. A shim written as
  `export * from '../x.ts'` compiles and typechecks, but the default is gone —
  which is what `build.module` points at. Check for `export default` before
  reaching for `export *`; use `export { default } from '../x.ts'`.
- **Some entrypoints are programs, not modules.** The `*-entrypoint.ts` files
  export nothing; they run. There is nothing to re-export, so the shim imports
  for effect (`import '../execution/x.ts';`). Verify the package does not declare
  `sideEffects: false`, or the import would be tree-shaken away.
- **Implementation placement is forced by the plane globs, not by taste.**
  Control/execution implementation cannot sit at the package root of a
  root-collapsed package (`src/*.ts → shared`) — it would be misclassified, and a
  per-file override would overlap the collapsed glob (no glob precedence). Hence
  `src/control/**` and `src/execution/**`. Corollary caught in T4: streams'
  `testing.ts` is execution-plane, so it goes to `src/execution/`, NOT the root.

Also worth repeating: a test that identifies a file by PATH breaks silently when
the file moves. T2 widened node/nextjs's firewall regex (it matched `/control.ts`
but not the new `src/control/` directory) and T3 updated target's
`invariants.test.ts` process-env inventory label. Neither is a build error —
only a reading of what the assertion is for catches them.

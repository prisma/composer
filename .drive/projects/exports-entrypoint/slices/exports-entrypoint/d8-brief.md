# Dispatch D8 — reconcile with origin/main, then the branch is PR-ready

The operator authorized reconciling and opening the PR. `origin/main` has moved a
LOT since this branch was cut (~70 commits: an SPI inversion, a glossary-wide
rename, state-under-branch, a streams bearer-key redesign, and a stricter
dependency-cruiser). This dispatch merges main in and reconciles everything so
the branch is mergeable and green.

## Strategy: MERGE, don't rebase
Merge `origin/main` into the branch (`git merge origin/main`). Do NOT rebase —
16 bot-signed commits against a 70-commit divergence would mean repeated
conflict resolution and risks mangling authorship/sign-offs. We're recommending
squash-merge anyway, so a merge commit is fine. Resolve everything in ONE pass.

## The governing principle for every conflict
**main wins on CONTENT; our branch wins on FILE PLACEMENT.** That is: take
main's functional changes (renamed types, new logic, new entrypoints), but keep
them in our `src/exports/` layout. If main added a new PUBLIC entrypoint, it
moves into `src/exports/`; if main edited a file we relocated, apply main's edit
to the relocated file.

## Known reconciliation items (not exhaustive — the merge will show more)

### 1. ADR number collision — renumber ours to ADR-0035
`main` now has `ADR-0033-lowering-types-are-defined-by-their-readers.md` AND an
`ADR-0034` (the renumbered state ADR). Our `ADR-0033-public-entrypoints-live-in-src-exports.md`
must become **ADR-0035**: rename the file, update the `# ADR-0035:` title, its
entry in `docs/design/90-decisions/README.md` (place it after 0034), and every
cross-reference (ADR-0028's pointer to it, and any reference inside our ADR or
the rule). Verify no other doc references our old 0033 number.

### 2. Two NEW public entrypoints from main must move into `src/exports/`
- **`cli/src/render-deployment.ts`** — main's `./report` subpath (main's cli
  keeps `exports:false` with a hand map aliasing `./report` →
  `dist/render-deployment.mjs`, entry array incl. `src/render-deployment.ts`).
  Our branch switched cli to GENERATED exports with `bin: false`. Reconcile so
  BOTH hold: move it to `src/exports/render-deployment.ts` and keep the public
  key `./report`. With generated exports the object entry name IS the subpath,
  so `{ index: 'src/exports/index.ts', bin: 'src/bin.ts', report:
  'src/exports/render-deployment.ts' }` yields keys `.` + `./report` with `bin`
  excluded — preserving main's public surface. (That changes the dist filename to
  `report.mjs`; confirm nothing references `render-deployment.mjs` by path — the
  generated stack imports the SUBPATH `@internal/cli/report`, which is fine.) If
  generated exports can't preserve `./report` cleanly, falling back to main's
  `exports:false` hand map for cli is acceptable — say so and why. **Preserving
  the `./report` public key is the hard requirement; how you get there is not.**
- **`composer/src/report.ts`** — main added a `./report` subpath to the published
  `@prisma/composer`. Move it to `src/exports/report.ts`, add its entry to
  composer's tsdown pass-1 object entries, and keep composer's hand-maintained
  map (composer stays `exports:false`) with `./report` intact.

### 3. architecture.config.json — main went 61 → 95 globs AND fails closed
main now maps essentially every module per-file (it CLOSED the storage/streams
gap we'd deferred), and main's dependency-cruiser "fails closed on an edge it
cannot see" / "every module is classified and aliased to source". So:
- Take main's expanded glob set as the base, then **repoint every glob whose file
  we moved** to its `src/exports/…` path. This includes storage (12 globs),
  streams (8), cpc's `storage.ts`/`storage-testing.ts`/`streams.ts`/`streams-testing.ts`,
  `composer/src/report.ts`, cli's `render-deployment.ts`, plus all the ones our
  branch already repointed (core, node, nextjs, target, cron, composer, cpc).
- Keep globs NON-overlapping (no `src/**` fallback — no glob precedence).
- `pnpm lint:deps` is now a strong check: with fail-closed, an unclassified moved
  module errors. Green lint:deps ≈ proof every move is classified.

### 4. Code conflicts in files we relocated
main edited several files our branch moved or modified. Apply main's content to
our relocated paths. Known overlaps: `target/src/index.ts` (→ `src/exports/index.ts`),
`lowering/src/state/index.ts` (→ `src/exports/state.ts`, flattened),
`streams/src/streams-module.ts` (we changed its `./exports/streams-service.ts`
cross-ref; main changed it for the bearer key), `composer/tsdown.config.ts`,
`streams/tsdown.config.ts`, `cli/package.json`, `cli/tsdown.config.ts`, plus
tests: `core/src/__tests__/lowering.test.ts`, `node/src/__tests__/{assemble,node}.test.ts`,
`cli/src/__tests__/run.test.ts`, `target/src/__tests__/{control-lowering,extension,invariants}.test.ts`,
`streams/src/__tests__/entrypoint.integration.test.ts`, `target/src/descriptors/prisma-next.ts`.
Remember the two grep gaps: internal non-test source importing an entrypoint, and
DYNAMIC `await import('…')` string literals.

### 5. Our ADR's follow-ups may now be STALE — check and update
- The "storage/streams are unmapped for plane enforcement" follow-up is **closed
  by main** — remove it from the ADR (and anywhere else we wrote it).
- The `normalizeGlob` wildcard-file follow-up: main CHANGED
  `dependency-cruiser.config.mjs`. Check whether main already fixed the
  normalizer (anchor/escape) — if so, remove or rewrite that follow-up too; if
  not, keep it accurate against main's current code.
Do not leave a claim in a permanent ADR that main has already falsified.

## Verification (the whole point)
Full suite green AFTER the merge: `pnpm build && pnpm typecheck && pnpm lint &&
pnpm lint:deps && pnpm test`. `lint:deps` matters most — main's fail-closed
cruiser proves every moved module is classified. Also confirm:
- Every package still has its public entrypoints under `src/exports/`.
- The published surfaces still carry their full key sets, now INCLUDING main's
  additions: `@prisma/composer` gains `./report`; `@internal/cli` keeps `./report`.
- Build + typecheck one example app.

## Commit
One merge commit is fine (`Merge origin/main into claude/prisma-exports-entrypoint-996287`)
plus follow-up fixup commits if that's cleaner. Bot identity + both sign-offs on
any non-merge commit. Explicit staging. `git show --stat` before treating done.

## Heartbeat
`wip/heartbeats/implementer.txt`: `<ISO-ts> | D8 | <phase> | <status>`.

## Return shape
The merge strategy used; the full conflict list and how each was resolved; the
new ADR number + everything renumbered; how `./report` (both packages) was
preserved; the architecture.config.json reconciliation (glob count, what was
repointed); which ADR follow-ups you removed as stale and why; the FULL gate
results; the commit SHA(s). If something can't be reconciled without a judgment
call bigger than "main's content in our layout", STOP and report it rather than
guessing.
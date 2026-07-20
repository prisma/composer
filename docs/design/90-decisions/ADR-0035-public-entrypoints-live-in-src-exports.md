# ADR-0035: Public entrypoints live in `src/exports/`; the exports map is generated where safe

## Decision

Every package's public surface is exactly the files under `src/exports/`. One
file there is one published subpath; everything else under `src/` is internal
implementation. An exports file holds **nothing but re-exports** — no
functions, classes, constants, or type declarations — and no implementation
module may import from `exports/`. The surface points at the implementation; it
never holds it, and implementation never depends on it.

A package's `tsdown.config.ts` lists only `src/exports/*` as entries, using
**object entries with explicit names** — the entry name is both the export
subpath key and the flat `dist/` filename:

```text
packages/0-framework/1-core/core/
  src/
    exports/
      index.ts      →  "."            →  dist/index.mjs
      deploy.ts     →  "./deploy"     →  dist/deploy.mjs
      config.ts     →  "./config"     →  dist/config.mjs   (entry key `config`, file app-config.ts)
      testing.ts    →  "./testing"    →  dist/testing.mjs
    config.ts       internal — stays at the src/ root
    graph.ts        internal
    node.ts         internal
    …
```

```ts
// core/tsdown.config.ts — object entries; the key fixes the subpath and dist name
entry: {
  index: 'src/exports/index.ts',
  deploy: 'src/exports/deploy.ts',
  config: 'src/exports/app-config.ts',
  testing: 'src/exports/testing.ts',
}
```

Where it is safe, `package.json#exports` is **generated**, not hand-written. The
shared base config `@internal/tsdown-config` carries a `customExports` hook that
strips the `exports/` prefix from each generated key (so `src/exports/deploy.ts`
publishes as `./deploy`, not `./exports/deploy`), with `enabled: 'local-only'`
(the map is committed, never regenerated at publish, so it cannot drift) and
`exclude: [/^bin$/]` (a `bin` entry builds but is not an importable subpath). The
generated map is string-form (`"./deploy": "./dist/deploy.mjs"`); TypeScript
resolves types from the adjacent `dist/deploy.d.mts`.

## Reasoning

Before this, entrypoint files sat at the `src/` root mixed with internals, and
nothing marked which files were public. Adding a file meant deciding — and often
forgetting — whether it was surface or plumbing. Making `src/exports/` the one
public directory turns that decision into a location: a file is public because of
where it lives, and the build, the plane map, and a reader all read the same
signal.

Generating the exports map removes the second hand-maintained source of truth.
The build already knows every entry and its output name, so it can write the map;
a committed map means no drift locally and none in CI. Object entries are what
make generation parity-safe: the entry **name** (not tsdown's path-derived chunk
name) fixes both the subpath key and the flat `dist/` filename, so moving a
source file into `src/exports/` never changes the published surface. (For a
single-entry package tsdown would otherwise collapse the key to `.`; the
`customExports` hook re-derives the subpath from the output filename, and the
`exports/` prefix strip is the same hook — both stay dormant for object-named
multi-entry packages but are the safety net.)

**Two deliberate exceptions keep a hand-maintained map and `exports: false`:**

- **Multi-pass packages** — `@internal/cron`, `@internal/storage`,
  `@internal/streams`. Each runs several tsdown passes (the `*-entrypoint` file
  is bundled standalone because `assemble()` copies it out with no siblings).
  Generation runs per pass and would clobber the map, so these declare their
  subpaths by hand.
- **The two published packages** — `@prisma/composer` (a `bin` field plus a
  two-pass build) and `@prisma/composer-prisma-cloud` (a nine-pass build with a
  resolve plugin and nested output directories). These are the published API
  contract, kept explicit on purpose.

These are choices, not workarounds: generation was proven safe for the case that
looked riskiest. `@internal/prisma-cloud` (the target extension) hand-maintained
a `{types, default}` conditional map "for the public packages' dts bundling";
dropping it and generating the string-form map keeps the whole build green,
including `@prisma/composer-prisma-cloud`, which rolls up the target's `.d.mts`.
So the conditional form was unnecessary, and the two exceptions above stand on
their own reasons (generation clobbers the map across build passes, and the
published API contract), not on a dts limitation.

## Consequences

- **Adding a subpath is a fixed procedure:** add `src/exports/<name>.ts`, add the
  object entry, build, commit the regenerated `package.json#exports` (never
  hand-edit a generated map), and declare its plane in
  `architecture.config.json`. The day-to-day steps live in
  [`.agents/rules/exports-entrypoints.mdc`](../../../.agents/rules/exports-entrypoints.mdc).

- **The dist invariant is entry-filename stability, not a byte-identical
  `dist/`.** Moving a source file that backs a rolldown shared chunk (one imported
  by both `index` and a sibling service entry) rehashes that internal
  content-hashed chunk — `storage` and `streams` saw this; `cron` did not, because
  its shared chunk derives from an unmoved internal file. That churn is fine: the
  runtime `import.meta.url` resolution targets the **entry** file
  (`storage-service.mjs`), which is byte-identical; these packages are `private`,
  so a chunk name never reaches npm; the public package re-bundles from the entry
  and inlines the chunk; and nothing in the tree pins a hashed chunk name. The
  real invariant a mover must hold is: **entry filenames and `package.json#exports`
  stay byte-identical; internal content-hashed chunk names may churn.**

- **An exports file is a surface, not a home.** It contains only re-export
  statements and comments. Everything else — every function, class, constant and
  type declaration — lives in an implementation module outside `exports/`, and
  **no implementation module imports from `exports/`**. Tests are the one
  exemption: a test or fixture that imports the public surface is consuming it as
  a consumer would, which is what the repo's test-import rule asks for, and probe
  fixtures such as core's `probe-core-authoring.ts` exist precisely to bundle the
  public barrel and assert what it drags in.

- **Implementation is placed by plane, because the globs cannot overlap.**
  Shared implementation sits at the package root (`src/<name>.ts`),
  control-plane implementation in `src/control/**`, execution-plane
  implementation in `src/execution/**`. This is forced, not stylistic: `core`,
  `cron` and `streams` classify their roots with a single `src/*.ts → shared`
  glob, so a control- or execution-plane module placed at the root would be
  classified `shared`, and adding a per-file override for it would overlap the
  `src/*.ts` glob — which, with no glob precedence, puts that file in two plane
  groups. A subdirectory is the only placement that stays non-overlapping.
  Packages whose root is genuinely mixed-plane (`target`, `storage`) keep one
  glob per root file instead.

- **This is stricter than the pattern it adapts.** Prisma Next's own
  `adapter-postgres/src/exports/column-types.ts` carries about 185 lines of
  implementation. We took the stricter rule deliberately: an exports file that
  can hold implementation eventually does, and then internal modules import it,
  and the published surface quietly becomes something the package's own
  internals depend on — which is the inversion this rule exists to prevent.

- **Plane globs stay per-file and non-overlapping.**
  [ADR-0028](ADR-0028-numbered-domains-and-layers-enforced-by-dependency-cruiser.md)
  maps entrypoints to planes in `architecture.config.json`, and this pattern
  keeps that: `src/exports/deploy.ts → control`, `src/exports/index.ts → shared`,
  and so on. `dependency-cruiser.config.mjs` has **no glob precedence** — a file
  joins a plane group if *any* of that group's globs match it — so there is
  deliberately no `src/** → shared` fallback (it would overlap the specific
  `src/exports/control.ts → control` glob and put one file in two planes).
  Within that constraint, a package whose root internals all share one plane
  collapses to a single `src/*.ts` glob — `normalizeGlob` (in
  `scripts/architecture-coverage.mjs`, shared by the cruiser config and the
  coverage check) anchors a file-like pattern and escapes literal dots, so
  `src/*.ts` becomes `^…/src/[^/]*\.ts$` and matches root files only, never
  `src/exports/…`. `core`, `cron`, and `streams` use it; `target` and `storage`
  keep one glob per root file because their root internals span two planes, and
  no single glob can say that.

- **Every module is classified, and the check fails closed.** `pnpm lint:deps`
  runs the cruiser plus a coverage check that errors on any source file no glob
  matches, so a new `src/exports/` entrypoint cannot be added without declaring
  its plane. That makes a green `lint:deps` proof that the layout and the plane
  map agree.

## Alternatives considered

- **Keep entrypoints at the `src/` root.** The status quo; nothing marks the
  public surface, so every new file is an undocumented judgement call and the
  plane map has to name each file individually with no structural cue. Rejected:
  the separation is the whole point.

- **Generate every package's map, including the multi-pass and published ones.**
  Uniform, but generation across a package's multiple tsdown passes overwrites the
  map, and the published packages are the API contract we least want a tool to
  own silently. Rejected for those; kept everywhere it is safe.

- **A `src/** → shared` fallback plus specific `src/exports/*` plane overrides.**
  Reads naturally, but dependency-cruiser has no most-specific-wins, so the
  fallback overlaps every specific glob and breaks plane enforcement. Rejected —
  globs must be non-overlapping.

- **Collect internals under `src/core/**`, as Prisma Next does.** We separate
  implementation from surface the same way, but name the directories after the
  planes the cruiser already enforces (`src/control/**`, `src/execution/**`,
  root for shared) rather than adding a `core/` level. That keeps one vocabulary
  — ADR-0017's planes — instead of two, and it is what makes the globs
  non-overlapping.

## Related

- [ADR-0028](ADR-0028-numbered-domains-and-layers-enforced-by-dependency-cruiser.md)
  — names `src/exports/<plane>.ts` as the plane-mapped entrypoint convention;
  this ADR realizes it across every package and generates the exports maps.
- [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md) — the
  control/execution import surfaces the plane globs enforce. This repo's
  execution-plane entrypoints exist per package (e.g. cron's
  `scheduler-service.ts`, `scheduler-entrypoint.ts`), not as a single
  `src/exports/runtime.ts`.
- [`.agents/rules/exports-entrypoints.mdc`](../../../.agents/rules/exports-entrypoints.mdc)
  — the day-to-day rule for adding a subpath.
- Prisma Next: `docs/architecture docs/Package-Layering.md` § Package Exports
  Pattern — the pattern this adapts (its `customExports` hook and multi-plane
  layout).

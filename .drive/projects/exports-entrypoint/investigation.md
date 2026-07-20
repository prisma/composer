# Plan: separate package source from exports via `src/exports/` entrypoints

Branch: `claude/prisma-exports-entrypoint-996287` (based on origin/main).
Reference: prisma-next (cloned read-only into the session scratchpad).

## The pattern in prisma-next

Sources studied: `.agents/rules/multi-plane-packages.mdc`,
`multi-plane-entrypoints.mdc`, `no-barrel-files.mdc`, `cli-package-exports.mdc`,
`directory-layout.mdc`, `tsdown-dist-layout-in-tests.mdc`,
`docs/architecture docs/Package-Layering.md` (§ Package Exports Pattern,
§ Multi-Plane Packages), `packages/0-config/tsdown/base.ts`, and the
`adapter-postgres` package as a worked example.

1. **`src/exports/*.ts` is the only public surface.** Every file there is one
   published subpath; everything else under `src/` is internal implementation
   (multi-plane packages put shared implementation in `src/core/**`).
2. **`tsdown.config.ts` lists only `src/exports/*.ts` as entries.**
3. **`package.json#exports` is generated, not hand-written.** The shared tsdown
   base sets `exports: { enabled: 'local-only', customExports, exclude: [/cli\./] }`.
   `customExports` strips the `exports/` prefix so `src/exports/control.ts`
   publishes as `./control` and builds to `dist/control.mjs` (flat dist). The
   generated map is committed; publish does not regenerate it, so drift is
   impossible locally and absent in CI.
4. **Plane enforcement keys off the entrypoint files.** `architecture.config.json`
   maps `src/exports/control.ts` → migration plane, `src/exports/runtime.ts` →
   runtime plane, `src/core/**` → shared plane; dependency-cruiser enforces.
5. **No barrel files** outside `src/exports/` — an exports file is an
   intentional API surface, not a convenience re-export.
6. Within-package tests import source (`../src/...`); cross-package tests import
   the package identifier. (Composer already has this rule.)

## Composer today

- 15 workspace packages. Entrypoint files sit at the `src/` root mixed with
  internals (e.g. `core/src` has `index.ts`, `testing.ts`, `deploy.ts`,
  `app-config.ts` next to `graph.ts`, `hydrate.ts`, `toposort.ts`, …). Nothing
  marks which files are public.
- `@internal/tsdown-config` already mirrors prisma-next's base (`exports: true`)
  but 7 of 15 packages opt out with `exports: false` and hand-maintain their
  maps. Its doc comment claims tsdown 0.15.x; the workspace actually has
  0.22.4 — the same version prisma-next uses, so `enabled: 'local-only'` +
  `customExports` port directly.
- `architecture.config.json` has 61 entries, mostly per-file globs
  (`core/src/deploy.ts` → control, `core/src/graph.ts` → shared, …) because
  public and internal files share one directory. Every new file needs a config
  edit; a forgotten one silently gets no plane.
- `core`'s `./config` subpath builds from `src/app-config.ts` via an object-form
  entry because `src/config.ts` is already taken by an internal module — exactly
  the collision the pattern removes.

## Plan

One PR, bottom-up through the layers, one package per commit so every commit
builds green. ADR + rule ship in the same PR as the code (repo policy: no
docs-only PRs).

### Phase 0 — tooling: `@internal/tsdown-config`

- Port prisma-next's `customExports` (strip `exports/` prefix, `./` → `.`,
  single-entry collapse fix) into `baseConfig`.
- Switch `exports: true` → `exports: { enabled: 'local-only', customExports,
  exclude: [/bin\./] }` (excludes the CLI bin from importable subpaths).
- Fix the stale 0.15.x comment.

### Phase 1 — per-package moves (mechanical)

For each package: `git mv` entrypoint files into `src/exports/`, fix relative
imports, point `tsdown.config.ts` entries at `src/exports/*.ts`, drop
`exports: false` and the hand-maintained map, rebuild, commit the generated
map. Internals stay where they are — `src/exports/` existing is the separation;
no `src/core/` shuffle needed.

| Package | `src/exports/` files (source → subpath) |
|---|---|
| `@internal/foundation` | `assertions.ts`, `casts.ts`, `secret.ts` |
| `@internal/core` | `index.ts`, `deploy.ts`, `testing.ts`, `app-config.ts` → **rename to `exports/config.ts`** (kills the object-entry collision) |
| `@internal/node`, `@internal/nextjs` | `index.ts`, `control.ts` |
| `@internal/rpc` | `index.ts` |
| `@internal/assemble` | `index.ts` |
| `@internal/cli` | `index.ts` (`bin.ts` stays internal; excluded from exports) |
| `@internal/lowering` | `index.ts`, `compute.ts`, `postgres.ts`, `state.ts` (replacing the `compute/index.ts`-style subdir entries with thin exports files) |
| `@internal/prisma-cloud` (target) | `index.ts`, `control.ts`, `prisma-next.ts`, `testing.ts`, `pg-connection.ts` → `exports/connection.ts` |
| `@internal/cron` | `index.ts`, `scheduler-service.ts`, `scheduler-entrypoint.ts` |
| `@internal/storage` / `@internal/streams` | `index.ts`, `*-service.ts`, `*-entrypoint.ts`, `testing.ts` |
| `@prisma/composer` | all 11 subpath files (`index`, `config`, `deploy`, `testing`, `casts`, `assertions`, `rpc`, `node`, `node-control`, `nextjs`, `nextjs-control`) — these are already thin re-exports, pure moves |
| `@prisma/composer-prisma-cloud` | all 8; nested subpaths (`./cron/scheduler-entrypoint`) keep object-form entry keys with slashes (`'cron/scheduler-entrypoint': 'src/exports/cron/scheduler-entrypoint.ts'` or nested dirs under `exports/`) |

Open point to verify during Phase 1, not before: the two public packages
hand-maintain `{types, default}` conditional exports "for the public packages'
dts bundling", and `@prisma/composer` needs `exports: false` anyway (its bin
entry plus `noExternal` bundling). Try auto-generation first; keep a manual map
**only** where the generated one demonstrably breaks consumer type resolution,
and document the exception in the rule (prisma-next's `cli-package-exports.mdc`
treats manual maps as exception-only, same stance).

Test fallout: within-package tests that import a moved file
(`../control.ts` → `../exports/control.ts`) get their paths fixed; imports of
internals are untouched. Cross-package tests are unaffected — subpath keys do
not change.

### Phase 2 — `architecture.config.json` rewrite

Replace the 61 mostly-per-file globs with, per package:

- `…/src/exports/<name>.ts` → its plane (control / execution / shared), and
- one `…/src/**` fallback glob → the package's internal/default plane.

Entrypoint plane assignments carry over from the current config (e.g.
`exports/control.ts` → control, cron's `exports/scheduler-*.ts` → execution).
Adding an internal file no longer needs a config edit; adding a public
entrypoint forces a deliberate plane declaration. Verify `pnpm lint:deps` still
fails on a known-bad import (glob order: specific before `src/**`).

### Phase 3 — guardrails + docs (same PR)

- **ADR-0033** "Public entrypoints live in `src/exports/`; the exports map is
  generated": the separation, the subpath naming (`control.ts` convention,
  which Composer already follows), generated-manifest policy, manual-map
  exceptions.
- **`.agents/rules/exports-entrypoints.mdc`**: only `src/exports/*` is public;
  tsdown `entry` lists exports files only; never hand-edit a generated
  `package.json#exports`; how to add a subpath (add file → add entry → build →
  commit manifest → declare plane in `architecture.config.json`).
- Touch-ups: `test-import-patterns.mdc` example paths; ADR-0028 cross-reference;
  the `no-bundling` / build-isolation rules are unaffected.

### Verification

- `pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm lint:deps`.
- Diff every generated `package.json#exports` against the pre-change map: the
  **set of subpath keys must be identical** for the two `@prisma/*` packages
  (published surface) and for all `@internal/*` consumers.
- Build one example app against the rebuilt public packages.

### Risks

- tsdown 0.22.4 `customExports` shape: prisma-next runs the identical version
  with this exact hook, so this is a copy, not an experiment.
- Generated string-form exports (`"./x": "./dist/x.mjs"`) rely on TS finding
  the sibling `dist/x.d.mts`; the packages already built this way (`core`,
  `node`) prove resolution works. The two public packages are where a
  `{types, default}` form might still be required — checked in Phase 1.
- `@prisma/composer`'s inlined-`@internal` bundling (ADR-0028) is orthogonal:
  entry file locations change, bundle contents don't.

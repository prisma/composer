# Slice A — Build pipeline (tsdown → dist), exact prisma-next model

> **STATUS: COMPLETE.** A1 `2f1e861`, A2 `16a02c0`, A3 `1971782`, A4 `7b0a572`.
> All 9 publishable packages build to dist; `pnpm build/test/typecheck/lint` green
> from a clean tree under the build-first loop; both CLI bins run. Packages remain
> `private: true` (un-private + publishConfig is Slice B).
>
> **Findings worth carrying forward:**
> - tsdown auto-preserves the source `#!/usr/bin/env node` shebang and sets the
>   dist bin executable — no banner needed.
> - The unscoped `prisma-app` launcher must set `external: ['@prisma/app-cli']`, or
>   tsdown inlines the CLI (a stale snapshot) instead of depending on it. Fixed;
>   launcher is a 147-byte shim.
> - `test`/`typecheck` use turbo `dependsOn: ["^build", "build"]` — `^build` for
>   sibling imports, `build` for self-name imports in fixtures.
> - **Local gotcha (not CI):** after `git reset --hard` + repeated incremental
>   installs, bun's resolution of a workspace package can wedge even with a valid
>   symlink. A clean `node_modules` reinstall fixes it; fresh CI checkouts are
>   unaffected.


One PR. Introduces a build so every publishable package emits `dist/` via tsdown,
with `exports`/`types` pointing at `dist` in every context (build-always), matching
prisma-next's packaging exactly. No versioning, manifests-hygiene, or workflows —
those are Slices B/C.

**Base:** `main` @ `a88097d` (post-#24). Re-baseline done; worktree is on merged main.

## Slice contract

- **In:** shared tsdown base config package; a prod tsconfig for dts emit; per-package
  `tsdown.config.ts` + `build`/`clean` scripts; flip `exports`→`dist`; `files`;
  the unscoped `prisma-app` launcher package; build-first dev/test loop; turbo wiring.
- **Out:** `private` removal, `publishConfig`, `license`/`repository`, version lockstep,
  `workspace:<version>` pinning (all Slice B); publish/preview workflows (Slice C);
  npm enablement (Slice D). Packages stay `private: true` through Slice A.
- **DoD:** `pnpm build` emits correct `dist/` (`.mjs` + `.d.mts`) for all 9;
  `pnpm test` / `typecheck` / `lint` green under the build-first loop;
  `node packages/app-cli/dist/bin.mjs --help` and the launcher's dist both run;
  no change to which packages are private or published (still all private).

## Grounded package inventory (origin/main)

Publishable set and their export subpaths (each → one tsdown entry):

| Package | dir | export subpaths |
| --- | --- | --- |
| `@prisma/app` | `packages/app` | `.`, `./deploy`, `./casts`, `./assertions` |
| `@prisma/app-cloud` | `packages/app-cloud` | `.`, `./target` |
| `@prisma/alchemy` | `packages/alchemy` | `.`, `./postgres`, `./compute`, `./state` |
| `@prisma/app-nextjs` | `packages/app-nextjs` | `.`, `./assemble` |
| `@prisma/app-node` | `packages/app-node` | `.`, `./assemble` |
| `@prisma/app-rpc` | `packages/app-rpc` | `.` |
| `@prisma/app-assemble` | `packages/app-assemble` | `.` |
| `@prisma/app-cli` | `packages/app-cli` | `.` + bin `prisma-app` (→ `dist/bin.mjs`) |
| `prisma-app` (new) | `packages/prisma-app` | bin-only launcher |

External deps to externalize (never bundle): `effect`, `alchemy`,
`@prisma/management-api-sdk`, `clipanion`, `postgres`. `skipNodeModulesBundle: true`
in the base config handles this. Note `@prisma/management-api-sdk` is an **external**
`@prisma/*` package — do not treat the `@prisma/` prefix as "internal" (design-notes
Decision 2).

## Build decisions (faithful to prisma-next, adapted where makerkit differs)

1. **Base config verbatim.** Add private `@prisma/app-tsdown` with prisma-next's
   `base.ts` copied as-is: `dts: { enabled, sourcemap }`, `skipNodeModulesBundle`,
   `sourcemap`, `exports: { enabled: 'local-only', customExports: <strip exports/ +
   filename-derive>, exclude: [/cli\./, /bin\./] }`, `tsconfig: 'tsconfig.prod.json'`.
   Add `bin\.` to the exclude so the CLI bin chunk is not exported.

2. **Keep makerkit's current `src/` file layout; list `entry` explicitly.** prisma-next
   puts export entries under `src/exports/*.ts`; makerkit's live at `src/index.ts`,
   `src/deploy.ts`, `src/postgres/index.ts`, etc. Faithful packaging does **not**
   require reorganizing the source tree — it requires the same tool, base config, and
   dist output shape. Each `tsdown.config.ts` lists `entry` at the real current paths;
   the base `customExports` derives subpath keys from output filenames
   (`dist/deploy.mjs` → `./deploy`). **Verify** the auto-generated `exports` matches the
   table above per package; if a key mis-derives (e.g. two `index.ts` in subdirs →
   collision), fall back to `exports: { enabled: false }` + a hand-written `exports`
   map for that package (the CLI already uses this escape hatch).

3. **Prod tsconfig for dts.** makerkit's `tsconfig.base.json` is source-consumption
   (`noEmit`, `allowImportingTsExtensions`, `bundler`). Add a `tsconfig.prod.json`
   (shared, extended per package) that enables declaration emit for tsdown's dts pass
   and drops `noEmit`/`allowImportingTsExtensions`. Mirror `@prisma-next/tsconfig/prod`.

4. **CLI bin.** `@prisma/app-cli` `tsdown.config.ts`: `entry` includes `src/bin.ts`;
   `exports: { enabled: false }`; `outputOptions` banner adds `#!/usr/bin/env node` to
   the bin chunk (prisma-next's exact CLI pattern). `bin: { "prisma-app": "./dist/bin.mjs" }`.

5. **Unscoped `prisma-app` launcher.** New `packages/prisma-app` — bin-only, same bin
   entry, its own `dist/bin.mjs`, `files: ["dist"]`, no library exports (mirrors
   prisma-next's unscoped `prisma-next`). Depends on `@prisma/app-cli` (or re-bundles
   the same entry — match prisma-next's launcher, which re-declares deps + builds its
   own dist). Stays `private` until Slice B/D.

6. **Build-first dev/test loop.** Add root `dev` = `turbo watch build`; make `test`
   build package deps first (turbo `test` gains `dependsOn: ["^build"]`; `typecheck`
   likewise). Runner stays `bun test`. Within-package tests import `./src` directly;
   cross-package imports now resolve to `dist`, so a build must precede cross-package
   tests. Update any example that imports a framework package to build-first.

7. **turbo.json.** `build` already declares `dist/**` outputs; add `^build` to
   `test`/`typecheck`/`test:types` `dependsOn`. Add `clean` to remove `dist`.

## Top risks (validate before fan-out)

1. **TS 6 × tsdown.** makerkit is on `typescript ^6.0.3`; prisma-next's toolchain is
   `tsdown 0.22.1` + `typescript 5.9.3`. tsdown/rolldown-dts on TS 6 is unverified. If
   it breaks, options: pin tsdown to a TS6-compatible release, or align makerkit's
   TypeScript to the version tsdown supports. **This is why Task 1 is a one-package
   end-to-end spike.**
2. **`effect` / `alchemy` heavy types in dts.** dts generation over `effect`'s types can
   be slow or surface resolution issues. The spike package (`@prisma/app`, which pulls
   `effect`) exercises this early.
3. **`.ts`-extension imports.** Source imports siblings as `./foo.ts`
   (`allowImportingTsExtensions`). tsdown bundles these fine, but the prod tsconfig must
   not choke on them during dts. Covered by the spike.

## A1 outcome (DONE — committed `2f1e861`)

The core risk is retired and the approach is locked:

- **tsdown 0.15.12 (already the workspace version, as a runtime dep) builds `@prisma/app`
  under TypeScript 6 with `effect`/`alchemy`, emits `.mjs` + `.d.mts` cleanly, exit 0.**
  No TS downgrade, no second tsdown version needed.
- **`.mjs`/`.d.mts` output** via `outExtensions`; **tsdown generates the `exports`/`main`/
  `types` map** pointing at `dist`, with keys derived from the **current `src/` layout** —
  no `src/exports/` reorg required.
- **No `tsconfig.prod.json` needed.** The package's default `tsconfig.json` (source-
  consumption config) drives dts generation fine; skip the prod-tsconfig step prisma-next
  uses. Revisit only if tests later pollute dts.
- **Base config uses `exports: true`, not `{ enabled: 'local-only', exclude }`.** Those are
  tsdown 0.22 features absent from 0.15.12's typed API. `exports: true` produces the same
  generated map. Consequence: the `'local-only'` publish-drift guard and regex `exclude`
  are unavailable until/unless build tsdown is bumped to 0.22 (which would mean two tsdown
  versions). **Deferred decision for Slice B** — 0.15.12 + `exports: true` is the current
  choice.
- **Invariant tests evolve with the build.** `@prisma/app`'s `invariants.test.ts` needed
  two intent-preserving updates: tolerate the `./package.json` manifest export, and allow
  the build-only `@prisma/app-tsdown` devDep (not target/runtime coupling). **Expect
  similar per-package invariant tests during A2** — handle each the same way.

## Task decomposition (dispatch units)

- **A0 — Re-baseline (done).** Worktree reset to `origin/main`; stale `makerkit-*` dirs
  removed.
- **A1 — Spike (done, committed).** `@prisma/app-tsdown` base config + `@prisma/app`
  converted; verified build + dts + load + `bun test` (95 pass) + typecheck + lint.
- **A2 — Fan out to the 6 remaining libraries.** app-cloud, alchemy, app-nextjs,
  app-node, app-rpc, app-assemble: per-package `tsdown.config.ts` + `build`/`clean`,
  flip `exports`→`dist`, `files: ["dist","src"]`. Verify each package's auto-exports.
- **A3 — CLI + launcher.** `@prisma/app-cli` bin build (banner, `exports:false`,
  `bin`→dist); new unscoped `packages/prisma-app` launcher. Verify both dist bins run.
- **A4 — Loop + turbo wiring.** `dev` = `turbo watch build`; `test`/`typecheck`
  `dependsOn ^build`; fix examples to build-first. Full `pnpm build && pnpm test &&
  pnpm typecheck && pnpm lint` green.

Dispatch A1 solo and gate on it (it answers the version risk). A2 can fan out per-package
in parallel once A1's config is proven. A3, A4 sequential after A2.

## Verification (slice DoD gate)

```
pnpm build                       # dist for all 9
pnpm test && pnpm typecheck && pnpm lint
node packages/app-cli/dist/bin.mjs --help
node packages/prisma-app/dist/bin.mjs --help
# spot-check a tarball's exports point at dist (full leak/pin gate is Slice B):
pnpm --filter @prisma/app pack && tar -xzOf prisma-app-*.tgz package/package.json | grep -A6 '"exports"'
```

# Dispatch D5 brief (ready once D4b is SATISFIED)

# Dispatch D5 — public packages to `src/exports/` (source-only move; KEEP hand-maintained maps)

D4b is reviewed and SATISFIED — every `@internal` package is now on the pattern.
D5 converts the two PUBLISHED packages. These are the published API contract, so
this is deliberately the most conservative dispatch: a **source-only move**.
KEEP `exports: false` and the hand-maintained maps for BOTH (composer has a `bin`
field + 2-pass build; composer-prisma-cloud has a 9-pass build with nested
`outDir`s + a resolve plugin — generation is clobber-prone here for no real gain,
and D4a already proved generation is dts-safe, so this is a deliberate choice).

Both packages' entrypoints are thin re-exports (`export * from '@internal/...'`)
— so there are NO relative-import fixes; the moves are clean. The entire risk is
in the multi-pass tsdown configs and preserving the published surface.

**Invariant (both packages):** after building, `package.json#exports`, the
`dist/` file list, AND composer's top-level `bin` field must all be
byte-identical to HEAD. Any change is a STOP condition.

Carry-over: stage post-`git mv` paths only; gate is full `pnpm test`; grep ALL
of `src/` + dynamic-import string literals for references to moved files.

## Package 1 — `@prisma/composer` (`packages/9-public/composer`)
- `git mv` these 11 thin re-export entrypoints into `src/exports/`: `index.ts`, `config.ts`, `deploy.ts`, `testing.ts`, `casts.ts`, `assertions.ts`, `rpc.ts`, `node.ts`, `node-control.ts`, `nextjs.ts`, `nextjs-control.ts`.
- They import `@internal/...` (not relative) — no import fixes inside them. Grep the package + tests for any reference to these files' paths and repoint (unlikely — they're leaf re-exports).
- tsdown: keep BOTH passes. Pass 1 (library): repoint the 11 object-entry source paths to `src/exports/…` (keys unchanged: `index`, `config`, `deploy`, `testing`, `casts`, `assertions`, `rpc`, `node`, `node-control`, `nextjs`, `nextjs-control`). Pass 2 (bin): `entry: { bin: '../../0-framework/3-tooling/cli/dist/bin.mjs' }` — UNCHANGED (reads cli's dist, not a src file). Keep `exports:false` on both passes, keep `external: ['esbuild']` and `noExternal: [/^@internal\//]`.
- Do NOT touch `package.json`'s hand-maintained `exports` map or the `bin` field (`{"prisma-composer": "./dist/bin.mjs"}`).
- architecture.config.json: repoint all 11 per-file globs 1:1 to `src/exports/…` (deploy, config, node-control, nextjs-control → control; index, testing, casts, assertions, rpc, node, nextjs → shared).
- Verify: exports map, `dist/` file list, and `bin` field byte-identical to HEAD.

## Package 2 — `@prisma/composer-prisma-cloud` (`packages/9-public/composer-prisma-cloud`)
- `git mv` these 9 thin re-export entrypoints into `src/exports/`: `index.ts`, `control.ts`, `prisma-next.ts`, `testing.ts`, `cron.ts`, `storage.ts`, `storage-testing.ts`, `streams.ts`, `streams-testing.ts`.
- All import `@internal/...` — no relative fixes. Grep for path references + repoint if any.
- tsdown: keep ALL NINE passes, the `externalizeFramework` resolve plugin, the `FRAMEWORK` map, all `outDir`/`external`/`dts:false` options, and `exports:false`. Update ONLY the entries that reference `src/…` files — repoint to `src/exports/…`:
  - Pass 1: `{ index: 'src/exports/index.ts', control: 'src/exports/control.ts', 'prisma-next': 'src/exports/prisma-next.ts', testing: 'src/exports/testing.ts' }`
  - Pass 2 (→dist/cron): `{ index: 'src/exports/cron.ts' }`
  - Pass 4 (→dist/storage): `{ index: 'src/exports/storage.ts' }`
  - Pass 6 (→dist/storage): `{ testing: 'src/exports/storage-testing.ts' }`
  - Pass 7 (→dist/streams): `{ index: 'src/exports/streams.ts' }`
  - Pass 9 (→dist/streams): `{ testing: 'src/exports/streams-testing.ts' }`
  - Passes 3, 5, 8 read `@internal/*/dist/*.mjs` — LEAVE UNCHANGED.
- Do NOT touch the hand-maintained `exports` map (nested keys `./cron/scheduler-entrypoint`, `./storage/storage-entrypoint`, `./storage/testing`, `./streams/…`).
- architecture.config.json: repoint the 5 existing per-file globs 1:1 (`control`→control; `index`, `prisma-next`, `testing`, `cron`→shared). The `storage`/`storage-testing`/`streams`/`streams-testing` source files have NO globs today — leave them unmapped (a D6/follow-up concern, same as the storage/streams packages).
- Verify: exports map + `dist/` file list (nested structure) byte-identical to HEAD.

## Scope
IN: the two public packages. OUT: switching either to generated exports (both STAY hand-maintained), D6's glob collapse, the `./report` upstream reconciliation (D7/PR-open), any file rename.

## Completed when (binary)
- [ ] Both packages: entrypoints under `src/exports/`; multi-pass configs, resolve plugin, nested outDirs, exports:false all preserved.
- [ ] `package.json#exports` byte-identical to HEAD for both; `dist/` file list byte-identical for both; composer's `bin` field byte-identical.
- [ ] Full gate GREEN: `pnpm build && pnpm typecheck && pnpm lint && pnpm lint:deps` + full `pnpm test`.
- [ ] **Example-app check:** build + typecheck at least one example app against the rebuilt public packages (pick one under `examples/` that imports `@prisma/composer` and/or `@prisma/composer-prisma-cloud`; report which). Confirms the published surface still resolves for a real consumer.
- [ ] Two commits, self-contained + green alone, bot identity + both sign-offs, explicit staging.

## Commits
`refactor(composer): move public entrypoints to src/exports` and `refactor(composer-prisma-cloud): move public entrypoints to src/exports`. Bodies note "source-only move; hand-maintained exports map + multi-pass config + bin field preserved."

## Heartbeat
`wip/heartbeats/implementer.txt`: `<ISO-ts> | D5 | <pkg>:<phase> | <status>`.

## Return shape
Per package: confirm `package.json#exports` byte-identical (paste), `dist/` file list unchanged, composer's `bin` field unchanged. Overall: full gate results, the example-app build/typecheck result (which app), two commit SHAs, grep results, and any surprise. Any exports-map / dist-layout / bin-field change is a stop condition — report and stop.
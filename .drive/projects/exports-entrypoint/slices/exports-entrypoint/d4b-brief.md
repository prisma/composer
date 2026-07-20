# Dispatch D4b brief (ready once D4a is SATISFIED)

# Dispatch D4b — cron + storage + streams to `src/exports/` (multi-pass; keep `exports:false`)

D4a (lowering + target) is reviewed and SATISFIED. D4b converts the three
multi-pass shared-module packages. These are DIFFERENT from every prior
dispatch: **keep `exports: false` and the hand-maintained exports map** — do
NOT switch to generated. Their tsdown configs run multiple build passes (the
`*-entrypoint` file is built standalone with special bundling because
`assemble()` copies it out), and generated exports across passes would clobber
the map. The goal here is only the `src/exports/` source separation.

**Critical invariant — dist layout must stay byte-identical.** These packages
resolve sibling `.mjs` files at RUNTIME via `import.meta.url` (e.g. the comment
"cronScheduler resolves `./scheduler-service.mjs`"). Object entry keys preserve
output filenames (`dist/scheduler-service.mjs` etc.), so moving SOURCE into
`src/exports/` must NOT change `dist/` at all. After building, diff the `dist/`
file list and each `package.json#exports` against HEAD — both must be
byte-identical. Any dist-layout or exports-map change is a STOP condition.

Carry-over: stage post-`git mv` paths only; `biome check --write` after
`./`→`../` changes; **gate is full `pnpm test`** (streams/storage have
`*-entrypoint` integration tests — they must stay green) + grep of moved paths
across `test/`/`examples/`/siblings.

## Package 1 — `@internal/cron` (`packages/1-prisma-cloud/2-shared-modules/cron`)
- Public entrypoints → `src/exports/`: `index.ts`, `scheduler-service.ts`, `scheduler-entrypoint.ts`. Internals stay at root: `contract.ts`, `module.ts`, `schedule.ts`, `scheduler.ts`, `serve-schedule.ts`.
- Import fixes: `exports/index.ts` → `../contract.ts`, `../module.ts`, `../schedule.ts`, `../scheduler.ts`, `../serve-schedule.ts`. `exports/scheduler-service.ts` → `../scheduler.ts`. `exports/scheduler-entrypoint.ts` → `../scheduler.ts`. (No internal file imports these entrypoints — confirmed.)
- tsdown: keep BOTH passes and `exports:false`; repoint source paths only — pass 1 `{ index: 'src/exports/index.ts', 'scheduler-service': 'src/exports/scheduler-service.ts' }`, pass 2 `{ 'scheduler-entrypoint': 'src/exports/scheduler-entrypoint.ts' }`.
- architecture.config.json: repoint 3 globs 1:1 — `index.ts`→shared, `scheduler-service.ts`→execution, `scheduler-entrypoint.ts`→execution (to `src/exports/…`). Leave the others.
- Map unchanged: `.`, `./scheduler-service`, `./scheduler-entrypoint`, `./package.json`.

## Package 2 — `@internal/storage` (`packages/1-prisma-cloud/2-shared-modules/storage`)
- Public entrypoints → `src/exports/`: `index.ts`, `storage-service.ts`, `storage-entrypoint.ts`, `testing.ts`. Internals stay at root: `contract.ts`, `handler.ts`, `memory-store.ts`, `pg-store.ts`, `sigv4.ts`, `storage-module.ts`, `storage-server.ts`, `store.ts`.
- Import fixes:
  - `exports/index.ts` → `../contract.ts`, `../storage-module.ts`, and SIBLING `./storage-service.ts` (entrypoint stays `./`).
  - `exports/storage-service.ts` → `../contract.ts`.
  - `exports/storage-entrypoint.ts` → `../pg-store.ts`, `../storage-server.ts`, and SIBLING `./storage-service.ts`.
  - `exports/testing.ts` → `../pg-store.ts`, `../storage-server.ts`.
  - **CROSS-REF:** internal `storage-module.ts` (stays at root) imports `./storage-service.ts` (now an entrypoint) → change to `./exports/storage-service.ts`.
- tsdown: keep ALL THREE passes and `exports:false`; repoint source paths only (pass 1 index + storage-service; pass 2 storage-entrypoint; pass 3 testing).
- architecture.config.json: storage has NO globs (unmapped) — no change.
- Map unchanged: `.`, `./storage-service`, `./storage-entrypoint`, `./testing`, `./package.json`.

## Package 3 — `@internal/streams` (`packages/1-prisma-cloud/2-shared-modules/streams`)
- Public entrypoints → `src/exports/`: `index.ts`, `streams-service.ts`, `streams-entrypoint.ts`, `testing.ts`. Internals stay at root: `contract.ts`, `streams-module.ts`, `streams-server.d.ts`.
- Import fixes:
  - `exports/index.ts` → `../contract.ts`, `../streams-module.ts`, SIBLING `./streams-service.ts`.
  - `exports/streams-service.ts` → `../contract.ts`.
  - `exports/streams-entrypoint.ts` → SIBLING `./streams-service.ts`.
  - `exports/testing.ts` → (no relative imports — confirm).
  - **CROSS-REF:** internal `streams-module.ts` (stays at root) imports `./streams-service.ts` → change to `./exports/streams-service.ts`.
  - Watch `streams-server.d.ts` (ambient/types file) — confirm nothing references a moved path.
- tsdown: keep ALL THREE passes (note pass 2 uses `outputOptions: { inlineDynamicImports: true }`) and `exports:false`; repoint source paths only.
- architecture.config.json: streams has NO globs (unmapped) — no change.
- Map unchanged: `.`, `./streams-service`, `./streams-entrypoint`, `./testing`, `./package.json`.

## Scope
IN: cron, storage, streams. OUT: public packages (D5), D6 collapse, switching any of these to generated exports (they STAY `exports:false`), any file rename.

## Completed when (binary)
- [ ] All three: public entrypoints under `src/exports/`, internals at root, multi-pass configs preserved (same number of passes, same bundling options — only source paths repointed).
- [ ] `package.json#exports` byte-identical to HEAD for all three; `dist/` file list byte-identical to HEAD for all three (the runtime `import.meta.url` invariant).
- [ ] Full gate GREEN: `pnpm build && pnpm typecheck && pnpm lint && pnpm lint:deps` + **full `pnpm test`** (the `*-entrypoint` integration tests included).
- [ ] Three commits, self-contained + green alone, bot identity + both sign-offs, explicit staging.

## Commits
`refactor(cron): move public entrypoints to src/exports`, `refactor(storage): …`, `refactor(streams): …`. Bodies note "multi-pass config + hand-maintained exports map preserved; dist layout unchanged."

## Heartbeat
`wip/heartbeats/implementer.txt`: `<ISO-ts> | D4b | <pkg>:<phase> | <status>`.

## Return shape
Per package: confirm `package.json#exports` byte-identical (paste) AND `dist/` file list unchanged. Overall: full gate results (incl. `pnpm test` task count + the `*-entrypoint` integration tests passing), three commit SHAs, grep results for moved-entrypoint references (esp. the `*-module.ts` cross-refs), and any surprise. Any exports-map or dist-layout change is a stop condition — report and stop.
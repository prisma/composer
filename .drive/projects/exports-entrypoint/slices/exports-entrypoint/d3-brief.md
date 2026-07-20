# Dispatch D3 brief (ready to send once D2 is SATISFIED)

# Dispatch D3 — move the remaining framework packages to `src/exports/`

D2 (foundation + core) is reviewed and SATISFIED. D3 converts the five remaining `@internal` framework packages. Same pattern: public entrypoints move into `src/exports/`, internals stay at the `src/` root, **object entries with explicit names**, subpath **key** sets byte-identical. One commit per package; each builds green alone.

**Convention reminder (from D2 learnings):** stage post-move paths only (never the pre-`git mv` path — that fails the whole `git add` atomically and silently under-stages). After each commit, confirm it's self-contained (`git show --stat <sha>`). biome will re-sort/wrap imports after `./`→`../` changes — run `biome check --write` on affected files and confirm hunks are pure reorder/wrap.

Use object entries so the entry NAME fixes the export key (`index`→`.`, `control`→`./control`) and flat `dist/` filename — do NOT keep array entries.

## Package 1 — `@internal/node` (`packages/0-framework/2-authoring/node`)
- `git mv` `index.ts`, `control.ts` → `src/exports/`.
- Grep the package for relative imports of these two + tests importing them; fix paths. (Expected: both have no relative imports of their own; `__tests__` may import `../index.ts`/`../control.ts` → `../exports/...`.)
- tsdown: `{ index: 'src/exports/index.ts', control: 'src/exports/control.ts' }`.
- architecture.config.json: repoint `node/src/index.ts`→`…/src/exports/index.ts` (plane `shared`), `node/src/control.ts`→`…/src/exports/control.ts` (plane `control`). 1:1, no collapse.
- **DO NOT TOUCH the runtime `build()` call** inside `control.ts` — it must keep `config: false` (`.agents/rules/runtime-tsdown-build-isolation.mdc`). Moving the file must not alter that call.
- Keys unchanged: `.`, `./control`.

## Package 2 — `@internal/nextjs` (`packages/0-framework/2-authoring/nextjs`)
- `git mv` `index.ts`, `control.ts` → `src/exports/`.
- `control.ts` imports `./index.ts` (`NextjsBuildAdapter` type) — a sibling in `exports/`, so it stays `./index.ts`. Fix any other relative imports + tests via grep.
- tsdown: `{ index: 'src/exports/index.ts', control: 'src/exports/control.ts' }`.
- architecture.config.json: repoint `nextjs/src/index.ts` (shared), `nextjs/src/control.ts` (control).
- Same runtime `build()` `config:false` caution as node.
- Keys unchanged: `.`, `./control`.

## Package 3 — `@internal/rpc` (`packages/0-framework/2-authoring/rpc`)
- Single public entrypoint: `git mv src/index.ts src/exports/index.ts`. Internals stay at root: `client.ts`, `contract.ts`, `rpc.ts`, `serve.ts`, `standard-schema.ts`.
- Fix `exports/index.ts` imports: `./client.ts`→`../client.ts`, `./contract.ts`→`../contract.ts`, `./rpc.ts`→`../rpc.ts`, `./serve.ts`→`../serve.ts`. Internals import each other with `./` — leave those. Fix `__tests__` imports of `../index.ts`→`../exports/index.ts`.
- tsdown: `{ index: 'src/exports/index.ts' }`.
- architecture.config.json: NO change — rpc uses the `…/rpc/src/** → shared` glob, which still covers `src/exports/`. Confirm and leave.
- Keys unchanged: `.`.

## Package 4 — `@internal/assemble` (`packages/0-framework/3-tooling/assemble`)
- Single public entrypoint: `git mv src/index.ts src/exports/index.ts`. Internals stay: `assemble-error.ts`, `assemble-services.ts`.
- Fix `exports/index.ts` imports: `./assemble-error.ts`→`../assemble-error.ts`, `./assemble-services.ts`→`../assemble-services.ts`. Fix `__tests__` imports of `../index.ts`.
- tsdown: `{ index: 'src/exports/index.ts' }`.
- architecture.config.json: NO change — assemble uses `…/assemble/src/** → control`. Confirm and leave.
- Keys unchanged: `.`.

## Package 5 — `@internal/cli` (`packages/0-framework/3-tooling/cli`) — the delicate one
- Public entrypoint: `git mv src/index.ts src/exports/index.ts`.
- **`bin.ts` STAYS at `src/` root** — it is the executable target, not an importable module. Do not move it into `exports/` (only importable public surface belongs there).
- Internals stay at root: `cli.ts`, `cli-error.ts`, `ensure-containers.ts`, `generate-stack.ts`, `load-config.ts`, `load-entry.ts`, `main.ts`, `run-alchemy.ts`, `validate-coverage.ts`.
- Fix `exports/index.ts` imports (`./cli.ts`, `./cli-error.ts`, `./generate-stack.ts`, `./load-entry.ts`, `./main.ts`, `./run-alchemy.ts` → `../…`). `bin.ts`'s `./cli.ts` stays (bin at root). Fix `__tests__` importing `../index.ts`.
- tsdown: switch to generated exports — DROP `exports: false`. Entry `{ index: 'src/exports/index.ts', bin: 'src/bin.ts' }`. The base config's `exclude: [/^bin$/]` keeps `bin` out of the generated `exports` map. Keep a short comment saying the base excludes `bin` so the executable stays non-importable.
- **Preserve any top-level `bin` FIELD** in `package.json` (that's the npm executable declaration, separate from `exports` — tsdown's exports generation must not drop it; if generation touches it, restore it). Check whether `@internal/cli` even has a `bin` field and preserve its current state exactly.
- architecture.config.json: NO change — cli uses `…/cli/src/** → control` (covers both `exports/` and `bin.ts`). Confirm and leave.
- **Key parity:** generated map must have keys `.` and `./package.json` (matching today), with `bin` absent. The VALUE form of `.` may change from the hand-written `{types,default}` to tsdown's generated form (string or conditional) — that's acceptable as long as the KEY set is unchanged and resolution works (typecheck + build prove it). If generation drops `./package.json`, add it back the way tsdown does for other packages.
- Grep the package for any runtime `tsdown build()` call; if present it must keep `config:false` (likely none here — node/nextjs are the ones that bundle — but confirm).

## Scope
IN: the five packages above. OUT: prisma-cloud packages (D4), public packages (D5), the D6 glob collapse, any file rename.

## Completed when (binary, per package + overall)
- [ ] All five packages: public entrypoints under `src/exports/`, internals (and cli's `bin.ts`) at `src/` root.
- [ ] `pnpm build` (workspace) green — zero unexpected `package.json` churn beyond the five packages' own regenerated maps.
- [ ] `pnpm typecheck` green.
- [ ] Package-scoped tests green for all five.
- [ ] `pnpm lint` and `pnpm lint:deps` green.
- [ ] **Subpath-key parity** for every package (before/after key lists pasted). cli: `.` + `./package.json`, `bin` absent. Any key delta is a STOP condition.
- [ ] Five commits, each self-contained + green alone, bot identity + both sign-offs, explicit staging.

## Validation gate
`pnpm build && pnpm typecheck && pnpm lint && pnpm lint:deps` + package-scoped tests for the five + the per-package subpath-key parity diff.

## Commits (one per package)
`refactor(node): move public entrypoints to src/exports`, `refactor(nextjs): …`, `refactor(rpc): …`, `refactor(assemble): …`, `refactor(cli): move public entrypoint to src/exports and generate exports map`. Each: `git commit -s --trailer "Signed-off-by: Will Madden <madden@prisma.io>" -m '…'`. No `git add -A`, no `--no-verify`.

## Heartbeat
`wip/heartbeats/implementer.txt`: `<ISO-ts> | D3 | <pkg>:<phase> | <status>`.

## Return shape
Per package: before/after subpath-key lists. Overall: validation gate results, the five commit SHAs, the grep results for moved-entrypoint importers, cli's `bin` field handling, confirmation node/nextjs runtime `build()` calls are untouched, and any surprise. A key-set mismatch is a stop condition — report and stop.
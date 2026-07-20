# Dispatch D4a brief (ready once D3 is SATISFIED)

# Dispatch D4a — lowering + target to `src/exports/`

D3 (framework packages) is reviewed and SATISFIED. D4a converts the two
singleton-pass prisma-cloud packages. Same invariants: public entrypoints move
into `src/exports/`, internals stay at `src/` root, **object entries with
explicit names**, subpath **key** sets unchanged. Commit per package (lowering
first, then target). Carry-over from D2/D3: stage post-`git mv` paths only;
`biome check --write` after `./`→`../` import changes (confirm pure
reorder/wrap); **gate now includes full `pnpm test`** + a grep of the moved
paths across `test/`/`examples/`/siblings.

## Package 1 — `@internal/lowering` (`packages/1-prisma-cloud/0-lowering/lowering`) — flatten subdir barrels

Current public entrypoints and subpaths:
- `.` ← `src/index.ts`
- `./compute` ← `src/compute/index.ts`
- `./postgres` ← `src/postgres/index.ts`
- `./state` ← `src/state/index.ts`

Move all four into `src/exports/`, flattening the subdir barrels:
- `git mv src/index.ts src/exports/index.ts`
- `git mv src/compute/index.ts src/exports/compute.ts`
- `git mv src/postgres/index.ts src/exports/postgres.ts`
- `git mv src/state/index.ts src/exports/state.ts`

The subdirs keep their implementation files (`compute/{ComputeService,Deployment,EnvironmentVariable,ServiceKey,artifact}.ts`, `postgres/{Connection,Database,Project}.ts`, `state/{bootstrap,errors,layer,lock,schema,service,transient}.ts` + `state/__tests__`), and `src/{client,container,credentials,http}.ts` stay at root.

Import rewrites (grep to confirm exact lines — do not trust this list as exhaustive):
- `exports/compute.ts`, `exports/postgres.ts`, `exports/state.ts` (the moved barrels): their `export … from './X.ts'` become `'../compute/X.ts'` / `'../postgres/X.ts'` / `'../state/X.ts'`.
- `exports/index.ts` (the moved root — has BOTH forms, the hazard):
  - DEEP imports into subdir implementation files (`./compute/ComputeService.ts`, `./postgres/Connection.ts`, …) → `../compute/…`, `../postgres/…`.
  - root-file imports (`./client.ts`, `./credentials.ts`, `./container.ts`) → `../client.ts`, etc.
  - barrel re-exports `export * from './compute/index.ts'` and `'./postgres/index.ts'` → these subdir indexes NO LONGER EXIST; repoint to the **sibling entrypoints** `'./compute.ts'` and `'./postgres.ts'`.
- Grep for any OTHER file importing the moved barrels by path (`from './compute/index`, `'../compute/index'`, etc.) and repoint. `__tests__` files that hardcode `src/index.ts`/`src/compute/index.ts` paths get repointed to `src/exports/...`.
- tsdown: `{ index: 'src/exports/index.ts', compute: 'src/exports/compute.ts', postgres: 'src/exports/postgres.ts', state: 'src/exports/state.ts' }` (object entries — keys `.`, `./compute`, `./postgres`, `./state`).
- architecture.config.json: lowering uses `…/lowering/src/** → control` — NO change. Confirm and leave.
- **Key parity:** keys `.`, `./compute`, `./postgres`, `./state`, `./package.json` unchanged. The dist VALUES flatten (`./dist/compute/index.mjs` → `./dist/compute.mjs`) — that's expected, only KEYS must match.

## Package 2 — `@internal/prisma-cloud` (`packages/1-prisma-cloud/1-extensions/target`) — 5 entrypoints + generation probe

Current public entrypoints (hand-maintained `{types,default}` map, `exports:false`):
- `.` ← `src/index.ts`
- `./control` ← `src/control.ts`
- `./prisma-next` ← `src/prisma-next.ts`
- `./testing` ← `src/testing.ts`
- `./connection` ← `src/pg-connection.ts`

Move all five into `src/exports/` (keep filenames — including `pg-connection.ts`). Internals stay at root: `descriptors/`, `compute.ts`, `http.ts`, `param.ts`, `pg-warm-resource.ts`, `pn-config.ts`, `pn-migration-resource.ts`, `postgres.ts`, `preflight.ts`, `prisma-next-migrate.ts`, `s3-*.ts`, `secret.ts`, `serializer.ts`, `service-keys.ts`.

- Fix the 5 entrypoints' relative imports of internal modules `./X.ts` → `../X.ts` (grep authoritative — these entrypoints import many internals). Sibling entrypoint refs (if any among the 5) stay `./`.
- Grep the package + `test/`/`examples/`/siblings for references to the 5 moved files (imports AND hardcoded paths) and repoint.
- tsdown entry (object, keep the `./connection` subpath via object key `connection` mapping the `pg-connection.ts` file):
  `{ index: 'src/exports/index.ts', control: 'src/exports/control.ts', 'prisma-next': 'src/exports/prisma-next.ts', testing: 'src/exports/testing.ts', connection: 'src/exports/pg-connection.ts' }`
- **GENERATION PROBE:** DROP `exports: false` and let the map generate. Then build the WHOLE workspace (`pnpm build`) — this builds `@prisma/composer-prisma-cloud`, which bundles target's dts. If the generated string-form exports break the public package's dts resolution / build, **revert target to its hand-maintained `{types,default}` map** (keep `exports:false`, repoint the dist values if any changed — they shouldn't, object keys preserve output names) and record WHY in the commit message + report. Do not force generation if it breaks dts.
- architecture.config.json: repoint target's 5 entrypoint globs 1:1 to `src/exports/…` — `control.ts` → control; `index.ts`, `prisma-next.ts`, `testing.ts`, `pg-connection.ts` → shared. Leave the internal-file globs (`descriptors/**`, `pn-migration-resource`, `pg-warm-resource`, `prisma-next-migrate`, `serializer`, `service-keys`, `compute`, `postgres`, `pn-config`, `http`) untouched.
- **Key parity:** keys `.`, `./control`, `./prisma-next`, `./testing`, `./connection`, `./package.json` unchanged. If generated: value form may change (string vs `{types,default}`) — acceptable if the workspace + dts build stays green. If reverted to manual: byte-identical to today.

## Scope
IN: lowering, target. OUT: cron/storage/streams (D4b), public packages (D5), D6 collapse, any file rename beyond the barrel-index flattening (which is a move, `index.ts`→`<name>.ts`).

## Completed when (binary)
- [ ] Both packages: public entrypoints under `src/exports/`, internals at root.
- [ ] Full gate GREEN: `pnpm build && pnpm typecheck && pnpm lint && pnpm lint:deps` + **full `pnpm test`** (not just package-scoped).
- [ ] Per-package subpath-key parity (before/after key lists pasted; before = current HEAD). Any KEY delta is a stop condition.
- [ ] target generation-probe outcome decided (generated OR reverted-with-reason) and reported.
- [ ] Two commits, self-contained + green alone, bot identity + both sign-offs, explicit staging. (Run full `pnpm test` after EACH commit, or at least confirm each is green alone — the D2 red-window lesson.)

## Commits
`refactor(lowering): move public entrypoints to src/exports` and either
`refactor(target): move public entrypoints to src/exports and generate exports map`
or (if reverted) `refactor(target): move public entrypoints to src/exports` with the manual-map rationale in the body.

## Heartbeat
`wip/heartbeats/implementer.txt`: `<ISO-ts> | D4a | <pkg>:<phase> | <status>`.

## Return shape
Per package: before/after subpath-key lists. Overall: full gate results (incl. `pnpm test` task count), the two commit SHAs, the grep results for moved-entrypoint references, the **target generation-probe decision + evidence** (did generated form keep composer-prisma-cloud's dts build green?), and any surprise. Key-set mismatch = stop condition.
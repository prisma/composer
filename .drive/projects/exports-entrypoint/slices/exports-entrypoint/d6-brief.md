# Dispatch D6 brief (ready once D5 is SATISFIED)

# Dispatch D6 — architecture.config.json safe simplification

D5 is reviewed and SATISFIED — the full workspace is on the `src/exports/`
pattern. D6 is a CONFIG-ONLY dispatch (no source moves): a safe, non-overlapping
reduction of `architecture.config.json`, plus a documented note about a
pre-existing gap, proven by a seeded violation. Small dispatch; one commit.

## Critical constraint — NO glob precedence
`dependency-cruiser.config.mjs` buckets every glob by `{domain}-{layer}-{plane}`
and a file joins a group if ANY of that group's globs match it. There is NO
most-specific-wins. So a `src/** → shared` fallback would OVERLAP a specific
`src/exports/control.ts → control` glob and put `control.ts` in BOTH plane groups
→ false violations. **Every glob must stay NON-overlapping.** Do NOT introduce a
`src/**` fallback anywhere.

## The one safe reduction: `src/*.ts` for uniform-plane root internals
`src/*.ts` normalizes to `.../src/[^/]*.ts` — the `[^/]*` cannot cross into
`src/exports/…`, so `src/*.ts` matches ONLY root-level files, never entrypoints.
Use it to replace per-root-file internal globs ONLY where a package's root
internals ALL share one plane:

- **core** (`packages/0-framework/1-core/core`): replace these 9 shared
  per-file globs — `src/config.ts`, `src/contract.ts`, `src/graph.ts`,
  `src/graph-types.ts`, `src/hydrate.ts`, `src/load-module.ts`,
  `src/load-service.ts`, `src/node.ts`, `src/toposort.ts` — with ONE
  `src/*.ts → shared`. Keep the 4 `src/exports/*.ts` globs (deploy→control,
  app-config→control, index→shared, testing→shared). 13 → 5 globs.
- **cron** (`packages/1-prisma-cloud/2-shared-modules/cron`): replace these 5
  shared per-file globs — `src/module.ts`, `src/contract.ts`, `src/schedule.ts`,
  `src/scheduler.ts`, `src/serve-schedule.ts` — with ONE `src/*.ts → shared`.
  Keep the 3 `src/exports/*.ts` globs (scheduler-service→execution,
  scheduler-entrypoint→execution, index→shared). 8 → 4 globs.

**Leave everything else as-is:**
- **target** — mixed-plane root (some files control, some shared) → cannot use a
  single `src/*.ts`. Keep its per-file globs.
- **composer, node, nextjs, composer-prisma-cloud** — all-entrypoint packages
  (no root internals) → nothing to collapse; keep per-file exports globs.
- **rpc, assemble, cli, lowering** (`src/**`), **foundation** (`0-foundation/**`)
  — already single-glob; keep.

## The pre-existing unmapped gap — DOCUMENT, do NOT add globs
`storage`, `streams`, and cpc's `storage`/`storage-testing`/`streams`/
`streams-testing` entrypoints have NO globs (pre-existing, from before this
slice). Do NOT add plane globs — that would impose new enforcement on
pre-existing code and risks surfacing pre-existing/false violations (scope creep
orthogonal to this slice). Instead add a short comment in
`architecture.config.json` (or its README if it has one) noting these packages
are currently unmapped for plane enforcement as a known follow-up. Keep it terse.

## Verification (the important part)
1. **Non-overlap check:** after editing, confirm NO file matches two plane groups.
   Concretely: `pnpm lint:deps` must stay green, AND spot-check that core's
   `src/exports/deploy.ts` is still ONLY control (not also shared via `src/*.ts`)
   and `src/config.ts` is shared. If the config exposes a way to print a file's
   resolved group, use it; otherwise reason via the normalized regex
   (`src/[^/]*.ts` cannot match `src/exports/deploy.ts`).
2. **Seeded-violation proof:** temporarily add an import that SHOULD be forbidden
   — e.g. in a core control-plane file (`src/exports/deploy.ts`) import from an
   execution-plane module, or a shared file importing a control file — run
   `pnpm lint:deps`, confirm it FAILS with a plane violation, then REVERT the
   seed. This proves enforcement still bites after the collapse. Report the
   violation message you saw.
3. **No effective-plane change:** the set of {file → plane} assignments must be
   identical to pre-D6 for every real source file (only the glob COUNT drops).

## Scope
IN: `architecture.config.json` (core + cron collapse; the doc comment for the
unmapped gap). OUT: any source move; adding globs for storage/streams; a `src/**`
fallback; touching target/composer/node/nextjs/cpc globs.

## Completed when (binary)
- [ ] core 13→5 globs, cron 8→4 globs, via non-overlapping `src/*.ts → shared`.
- [ ] Unmapped gap documented (comment), no globs added for it.
- [ ] `pnpm lint:deps` green; the seeded violation FAILS (proof pasted); seed reverted.
- [ ] `pnpm build && typecheck && lint && full pnpm test` still green (config change shouldn't affect them, but confirm).
- [ ] One commit, bot identity + both sign-offs, explicit staging.

## Commit
`refactor(arch-config): collapse core + cron root-internal globs to src/*.ts` with a body noting the no-precedence constraint (why no `src/**` fallback) and the documented unmapped gap.

## Heartbeat
`wip/heartbeats/implementer.txt`: `<ISO-ts> | D6 | <phase> | <status>`.

## Return shape
The before/after glob counts for core + cron; the non-overlap reasoning; the seeded-violation message (proof enforcement bites) + confirmation you reverted it; full gate results; the commit SHA. If `lint:deps` goes red or any file's plane changes, that's a stop condition.
# Dispatch plan — Slice R8, Prisma-hosted Alchemy state store

Contract: [`spec.md`](spec.md). Design: [`design-note.md`](design-note.md).
Implementers: Sonnet (mid); reviewer: Opus (mid). Sequential.

## Dispatch 1 — the store over a DSN

**Outcome:** `@makerkit/prisma-alchemy/state` exists with a
`makePrismaStateService(sql)` implementing alchemy's 12-method `StateService`
over postgres.js against a given Postgres URL: two-table schema
(`alchemy_resource_state`, `alchemy_stack_output`), idempotent
`create table if not exists` migration, values through alchemy's
`encodeState`/`reviveStateRecursive`.
**Builds on:** nothing (first dispatch).
**Hands to:** a tested store any DSN can back — D2 wraps it in bootstrap + lock.
**Focus:** fidelity and the strict repo rules (no bare `as`; postgres.js only,
no Bun APIs). Unit tests against a real local Postgres cover: all 12 methods
round-trip; `Redacted`/`Duration` marker fidelity; `list` excludes outputs;
`deleteStack` with and without `stage`; migration idempotence.
**Completed when:** `pnpm typecheck && pnpm lint && pnpm lint:casts` green;
store tests pass against a local Postgres; the subpath export resolves.

## Dispatch 2 — bootstrap + lock → `prismaState({ workspaceId })`

**Outcome:** the public Layer. On init (scoped, once per stack run):
find-or-create the `makerkit-state` project via the Management API (reuse
`client.ts`/`credentials.ts`; adopt-on-race by re-list), use its default
database (never create one — FT-5220), mint a fresh connection and read
`endpoints.direct.connectionString` (PRO-212), run the migration, acquire
`pg_try_advisory_lock(hashtextextended('makerkit:'||stack||'/'||stage, 0))` on
a reserved connection; release on scope close; contention = immediate error
naming stack/stage; a dropped lock connection mid-run fails loudly, never
continues unlocked.
**Builds on:** D1's store (`makePrismaStateService`).
**Hands to:** the complete `prismaState()` D3 wires as the target default.
**Focus:** lock lifecycle correctness. Contention/release/crash-release tests
need two real sessions (real Postgres, not PGlite). Bootstrap's Management API
calls tested with a stubbed client; no cloud in unit tests.
**Completed when:** gates green; lock tests prove acquire/contend/release/
crash-release; `prismaState({ workspaceId })` typechecks as
`Layer<State, never, StackServices>`.

## Dispatch 3 — the `Target.state` seam + prisma-cloud default

**Outcome:** `Target` gains optional `state?: () => AlchemyStateLayer`
(exported type in `@makerkit/core/deploy`); `lower()` resolves
`opts.state ?? target.state?.() ?? localState()`; `prismaCloud()` supplies
`state: () => prismaState({ workspaceId: o.workspaceId })`. core-model.md's
`LowerOptions`/Target sketch amended to match (doc covenant).
**Builds on:** D2's `prismaState`.
**Hands to:** hosted-by-default deploys for D4 to prove live.
**Focus:** precedence tests (opts wins > target > localState); core still has
no prisma dependency (invariant 1 test must stay green — the *type* seam is
generic; only the pack imports prisma-alchemy).
**Completed when:** gates green; precedence covered by a core test; invariant
tests untouched/green; docs amended.

## Dispatch 4 — live proof + docs + CI pinning

**Outcome:** the slice DoD proof executed against real Prisma Cloud: destroy
the standing storefront-auth demo; deploy hosted from workdir A (round trip
renders `auth.verify() -> { ok: true }`); deploy same stack from a fresh
workdir B with no `.alchemy/` → zero duplicate resources; concurrent deploy
fails fast on the lock; kill-mid-deploy then redeploy proves crash-release;
destroy cleans the stack, `makerkit-state` project survives. CI e2e state
decision made and pinned explicitly. `layering.md` Step 1 marked
shipped-interim; `plan.md` updated; the Management API ask drafted as
`platform-ask.md` in this slice dir (Linear filing is operator/manual — no
Linear access in agent sessions).
**Builds on:** D3 (hosted default live in the pack).
**Hands to:** the reviewed, provable branch D5 reviews.
**Focus:** real-cloud footguns (creds from root `.env`; never print secrets;
PRO-200/211/212/213 behaviors). Evidence (plan outputs, curl results) recorded
in the dispatch return, not screenshots.
**Completed when:** every proof item observed and recorded; e2e workflow
green or its state pinning committed.

**Status: complete (2026-07-09).** Ran against the real workspace, which held
zero projects at the start (the standing demo was already gone). Proof
results:

- **Deploy A** (`pnpm build` then `bunx --bun alchemy deploy --yes`, hosted
  state, no code changes needed): `Plan: 13 to create` → `Done: 26 succeeded`.
  Bootstrap created `makerkit-state` (`proj_cmrddknia06h6ynf44njheoou`) and the
  stack created `storefront-auth` (`proj_cmrddkvdq06i0ynf4xu9osuvu`) —
  confirmed via `GET /v1/projects`.
- **Round trip:** the storefront's post-promote URL
  (`https://w5nxxidc5rfe4evnyk3ls49v.ewr.prisma.build/`) rendered `Auth
  /verify says: true` on the first curl (PRO-200 handled — the deploy output
  already returns the post-promote domain).
- **Headline (zero-duplicate redeploy):** deleted
  `examples/storefront-auth/.alchemy` (the only local `.alchemy/` anywhere in
  the repo tree; it held only an empty CLI log, no state — confirming hosted
  state is genuinely the default with nothing local backing it), then ran
  `pnpm run deploy` unchanged. Result: `Plan: 1 to update, 12 to noop` — every
  provisioned resource noop'd; only `storefront-deploy` updated (the known
  Next `BUILD_ID` non-determinism from rebuilding). `GET /v1/projects`
  afterward showed the same two project ids — zero duplicates.
- **Lock contention:** a scratchpad script (bootstrap + `acquireStateLock`,
  same code path as the Layer) held the `storefront-auth/dev_will` lock; a
  concurrent `alchemy deploy` failed immediately with
  `StateLockContentionError: another deploy holds the state lock for
  storefront-auth/dev_will`.
- **Crash-release:** `kill -9` on the lock holder, then redeploy — acquired
  the lock and completed (`Plan: 13 to noop`), proving the session-scoped
  advisory lock releases on connection drop with no bookkeeping.
- **Destroy:** `bunx --bun alchemy destroy --yes` → `Plan: 13 to delete` →
  `Done: 13 succeeded`. `GET /v1/projects` afterward: `storefront-auth` gone,
  `makerkit-state` survives.
- **State-row sanity:** post-destroy, `alchemy_resource_state` for
  `storefront-auth/dev_will` is empty (0 rows). One
  `alchemy_stack_output` row for `storefront-auth/dev_will` remains —
  traced to alchemy's own `Apply.ts`: `deleteStack` is only invoked by the
  `alchemy state delete` CLI command, never by `alchemy destroy` (whose plan
  has no `output`, so `setOutput`/`deleteStack` are never called in that
  path). This is stock alchemy behavior, reproducible with any state backend
  (including alchemy's own local file store) — not a defect in this store.
  The row is inert (no live resources reference it) and gets overwritten
  cleanly (`on conflict (stack, stage) do update`) on the next deploy of the
  same stack/stage.
- **CI pinning decision:** kept hosted state as the default for
  `.github/workflows/e2e-deploy.yml` — no file change. CI already sets
  `PRISMA_SERVICE_TOKEN` and `PRISMA_WORKSPACE_ID` (needed for `prismaCloud()`
  regardless), which is everything the hosted-state bootstrap needs; CI's
  per-run unique `STOREFRONT_STACK_NAME` means concurrent/ephemeral runs never
  collide on the advisory lock or duplicate a project. No code fixes were
  required in `packages/prisma-alchemy/src/state/**` — D1–D3 held up against
  the real platform as designed.

## Dispatch 5 — Opus review + fix round

**Outcome:** Opus (mid) reviews the full slice diff against spec + design
note; findings triaged; fixes landed with negative-probe verification where
applicable; PR opened (bot remote, DCO dual sign-off) with the slice spec as
description basis.
**Builds on:** D4's proven branch.
**Hands to:** operator merge.
**Completed when:** review findings closed or explicitly deferred with
rationale; PR open and CI green.

# feat(prisma): Bucket + BucketKey resources, providers({dev}) override, Postgres state backend

We're adopting the Prisma provider in Prisma Composer (the framework layer on
top of Prisma Cloud) and deleting our own resource implementations in its
favor. This PR adds the pieces Composer needs that the provider doesn't have
yet. Everything follows the provider's existing conventions; the contract
fixture, coverage counts, public-surface and source-convention suites are
updated rather than bypassed.

## 1. `Prisma.Bucket` / `Prisma.BucketKey`

Covers the 7 previously deferred `/v1/buckets` Object Storage routes
(`deferredRoutes` is now empty in the contract fixture; coverage 71 → 78).

- `Bucket`: read-then-create reconcile, replace on project/name/branch change
  (no PATCH route exists), identity-verified delete (persists `projectId` +
  `createdAt`), real `list` for nuke.
- `BucketKey`: the secret access key is **reveal-once** — the API never
  returns it after create, so persisted state is authoritative (the
  `Connection` pattern). Keys are created under a deterministic
  `instanceId`-derived physical name and looked up before create, so a crash
  between the create call and the state write cannot mint a second,
  unenumerable credential — the orphan from the lost response is found by
  name and revoked before a fresh key is created. Existence is re-verified on
  read/reconcile via `listBucketKeys` (secrets always from state); note
  `bucketName` is the provider-side S3 bucket name, not the display name.
- Docs: `prisma/data/buckets` page + sidebar entry, mirroring connections.

## 2. `providers({ dev })` + `liveProviders()`

`Prisma.providers()` selects dev-vs-live internally, which means an embedder
with its own local emulation cannot compose with the live providers without
hand-rebuilding the client/auth wiring. Two additive changes, defaults
unchanged:

- `providers({ dev })` — a supplied layer replaces the built-in dev layer in
  `alchemy dev` only. `PrismaLocalProviders` is typed structurally (the union
  of the twelve resource providers), so an embedder layer typechecks without
  casts — the test builds one from `Provider.succeed` per resource and passes
  it with no `as`.
- `liveProviders()` — the live provider layer exported for frameworks that do
  their own mode selection.

Composer uses both: upstream live providers on deploy, its own emulator
providers in dev.

## 3. `State/PostgresState`

A Postgres state backend: `postgresState({ client | dsn, lockKeyPrefix, id })`
over two tables, with a per-`(stack, stage)` session advisory lock
(`pg_try_advisory_lock(hashtextextended(key, 0))` on a reserved connection,
holder re-verified against `pg_locks` **from a different pool connection**),
and a TTL-amortized lease check wrapping every operation. Stage-less
`deleteStack` locks each stage before deleting. The schema migration runs
under a transaction-scoped advisory lock — concurrent
`create table if not exists` genuinely fails on Postgres (duplicate `pg_type`
errors), so first-boot races between two stacks are handled.

Motivation: the `Compute` docstring tells users to "use a durable, locked
state backend" for safe deployment recovery, and no in-tree backend provides
locking. Uses the repo's existing `pg` dependency; deliberately **not**
re-exported from the `State` barrel (a comment explains: the barrel is
imported by engine files that get bundled for workers, and `pg` must stay off
that graph) — import via `alchemy/State/PostgresState`.

Tests are hermetic stubs per the existing state-backend convention
(`HttpStateStore`). Two real-Postgres behaviors were verified against a live
PostgreSQL 15 during development and are documented in comments rather than
CI-tested: the 64-bit advisory-lock key reconstruction from
`pg_locks.classid/objid` (intentional bigint shift wraparound), and the
concurrent-DDL failure that motivates the migration lock.

## 4. `Resource.ts`: `Aliases` typing

`ResourceClass.Aliases` is `readonly string[] | undefined`, but
`ResourceClassLike.Aliases?: readonly string[]` — under a consumer tsconfig
with `exactOptionalPropertyTypes: true`, every `Provider.effect(cls, …)` call
fails to typecheck (Composer currently carries this as a pnpm patch). One
line: `Aliases?: readonly string[] | undefined`.

## Verification

- `bun run format:check` clean; `bun tsc -b` (monorepo) clean.
- `bun alchemy-test --fast test/Prisma test/State`: 391 passed / 0 failed.
- Core engine suites (exercising the `Resource.ts` change): 549 passed / 0
  failed.
- `generate-api-reference`: no new category; Prisma gains the two bucket
  pages. `docs:check` builds clean.

This PR completes three gaps in the Prisma provider that show up the moment a real framework embeds it. After it, this works:

```ts
import * as Alchemy from "alchemy";
import * as Prisma from "alchemy/Prisma";
import { postgresState } from "alchemy/State/PostgresState";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "Media",
  {
    // Bring your own local emulation in `alchemy dev`; live stays live.
    providers: Prisma.providers({ dev: myEmulatorProviders() }),
    // Durable, *locked* state — what Compute's own docs ask for.
    state: postgresState({ dsn: process.env.STATE_DSN! }),
  },
  Effect.gen(function* () {
    const project = yield* Prisma.Project("app", {});

    // Object storage: the last deferred Management API surface.
    const bucket = yield* Prisma.Bucket("media", { project });
    const key = yield* Prisma.BucketKey("media-rw", {
      bucket,
      role: "read_write",
    });

    return { endpoint: key.endpoint, bucket: key.bucketName };
  }),
);
```

The three ship together because they're the set a production embedder needs at once — we (Prisma Composer, the framework layer over Prisma Cloud) are deleting our own resource implementations in favor of this provider, and these were the three things we couldn't do with it. Each is an independent commit-sized concern; happy to split into separate PRs if you'd rather review them that way.

## Object storage: `Prisma.Bucket` / `Prisma.BucketKey`

The 7 `/v1/buckets` routes were the provider's only deferred Management API surface. This adds them to the client/operations layer and puts two resources on top, shaped like their siblings (`Database`/`Connection` conventions throughout: `Refs` string-or-resource references, replace-on-identity-change diff, identity-verified delete, real `list` for nuke).

The interesting part is the key secret. The API returns `secretAccessKey` exactly once, at create — it can never be re-read. So persisted state is authoritative for the secret (the `Connection` pattern), which raises the crash-window question: what if the process dies after `POST …/keys` succeeds but before state is written? A naive retry would mint a second, working, never-expiring credential that no state row references and `list` can't surface. To close that, keys are created under a deterministic `instanceId`-derived physical name and looked up by name before create; a hit on retry means "create succeeded, response lost" — that orphan's secret is gone for good, so it is revoked and one fresh key is minted. Existence is re-verified on read/reconcile (secrets always from state), so a key revoked in the Console reads as gone instead of haunting the stack.

Docs: `prisma/data/buckets` page + sidebar entry, mirroring connections.

## An embedder seam for dev mode: `providers({ dev })` + `liveProviders()`

`Prisma.providers()` picks dev-vs-live internally. That's the right default, but it's closed: an embedder with richer local emulation (we run a compute emulator that supervises the real artifact, a local S3, and a persistent dev Postgres) can't swap the dev half without rebuilding the client/auth wiring by hand. Two additive changes, defaults untouched:

- `providers({ dev })` — the supplied layer replaces the built-in dev providers during `alchemy dev` only. `PrismaLocalProviders` is a structural type (the union of the twelve resource providers), and the test proves an embedder layer built from `Provider.succeed` typechecks with **no casts** — that's the seam's contract.
- `liveProviders()` — the live layer exported for frameworks doing their own mode selection.

What implementing the dev side actually looks like — a provider per resource you emulate, plain `Provider.succeed`, no casts:

```ts
const devDatabase = Provider.succeed(Prisma.Database, {
  stables: ["databaseId"],
  list: () => Effect.succeed([]),
  diff: Effect.fn(function* () {
    return { action: "update" } as const;
  }),
  read: Effect.fn(function* ({ output }) {
    return output;
  }),
  reconcile: Effect.fn(function* ({ id, news }) {
    // Start (or adopt) a local Postgres for this database and
    // hand back the same attribute shape the live provider emits.
    const server = yield* myDevPostgres.ensure(id);
    return {
      databaseId: server.instanceName,
      databaseName: resolveId(news.project),
      directConnectionString: Redacted.make(server.url),
      databaseUrl: Redacted.make(server.url),
      status: "ready",
      // pooled/accelerate/origin fields are optional — omit what
      // your emulator doesn't have.
    };
  }),
  delete: Effect.fn(function* ({ output }) {
    yield* myDevPostgres.destroy(output.databaseId);
  }),
});

const myEmulatorProviders = (): Prisma.PrismaLocalProviders =>
  Layer.mergeAll(devDatabase, devConnection, devCompute /* … */);

// Deploy is untouched; `alchemy dev` runs on your emulators:
Prisma.providers({ dev: myEmulatorProviders() });
```

And a framework that owns mode selection entirely skips `providers()` and composes the exported live layer with its own local one:

```ts
const providers = isDev ? myEmulatorProviders() : Prisma.liveProviders();
```

## A locked state backend: `State/PostgresState`

`Compute`'s recovery docs tell users to "use a durable, locked state backend" — and no in-tree backend has locking. This adds one on the dependency the repo already carries (`pg`):

- per-`(stack, stage)` **session advisory lock** (`pg_try_advisory_lock(hashtextextended(key, 0))`) held on a reserved connection, with the holder re-verified against `pg_locks` from a *different* pool connection — so a silently dropped lock connection is detected, not trusted;
- a TTL-amortized lease check wrapping every operation; stage-less `deleteStack` locks each stage before touching it;
- schema migration under a transaction-scoped advisory lock, because concurrent `create table if not exists` genuinely fails on Postgres (duplicate `pg_type` errors — reproduced on PG 15) and first-boot races between two stacks are exactly the case a state store must survive.

It is deliberately **not** re-exported from the `State` barrel: the barrel is imported by engine files that get bundled for workers, and `pg` must stay off that graph. Deep import: `alchemy/State/PostgresState` (a comment in the barrel says why).

Tests are hermetic stubs per the existing backend convention (`HttpStateStore`). Two real-Postgres behaviors were verified against live PostgreSQL 15 during development and documented in comments rather than CI-tested: the 64-bit lock-key reconstruction from `pg_locks.classid/objid` (intentional bigint wraparound), and the concurrent-DDL failure motivating the migration lock.

## One-line core fix: `Aliases` typing

`ResourceClass.Aliases` is `readonly string[] | undefined`, but `ResourceClassLike.Aliases?: readonly string[]`. Under a consumer tsconfig with `exactOptionalPropertyTypes: true`, every `Provider.effect(cls, …)` call fails to typecheck (we currently carry a pnpm patch for this). The fix widens the optional to `| undefined`.

## Verification

- `bun run format:check` clean; `bun tsc -b` (monorepo) clean.
- `bun alchemy-test --fast test/Prisma test/State`: 391 passed / 0 failed.
- Core engine suites (exercising the `Resource.ts` change): 549 passed / 0 failed.
- `generate-api-reference`: no new category; Prisma gains the two bucket pages; `docs:check` builds clean. Contract fixture updated (`deferredRoutes` now empty; route coverage 71 → 78).

## Alternatives considered

- **Three separate PRs.** Kept together because they're one consumer's complete need and the review context overlaps (BucketKey's crash-window design references Connection's; the dev seam is what makes the state backend's locking story testable end-to-end for us). Say the word and we'll split.
- **`ReturnType<typeof devProviderLayer>` for `PrismaLocalProviders`.** It bakes the built-in stubs' literal `stables` tuples into the public type — no real embedder layer can satisfy it without `as never`. Structural union instead.
- **Exporting `postgresState` from the `State` barrel.** Poisons worker bundles with `pg`. Deep import + explanatory comment instead.
- **Letting embedders rebuild the live wiring themselves** (no `liveProviders()` export). Works today but couples every embedder to the private composition of client/auth/upload layers — each upstream refactor breaks them silently.
- **A migration-free schema bootstrap** (plain `create table if not exists`). Fails under concurrency on real Postgres; see above.

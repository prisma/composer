# S2 — Cron as a driver System

One PR. Realizes [ADR-0020](../../../../docs/design/90-decisions/ADR-0020-scheduled-work-is-a-driver-not-a-resource.md)
on top of S1's structured params. Design of record: ADR-0020 and the worked
example in [config-params.md](../../../../docs/design/10-domains/config-params.md).
Linear: TML-3010.

## Summary

Cron is a **driver**: an always-on `cron-scheduler` compute service that depends
on a single `trigger(jobId)` endpoint and calls it on a timer. The app writes a
`router` that implements `trigger(jobId)` and dispatches each id to real work.
The job ids have one source of truth (`defineSchedule`), checked by the compiler
against the router's handlers (`serveSchedule`). None of this needs a new
composition primitive — the scheduler is an ordinary consumer of the router's
exposed endpoint, exactly the storefront→auth shape.

New package `@prisma/compose-cron` ships the reusable pieces; an in-repo example
proves the whole pipeline. After this slice a service can be scheduled without
writing a timer, and the schedule rides through S1's structured `jobs` param end
to end.

## Deliverables

1. **`@prisma/compose-cron` package** with the reusable scheduler, the two authoring
   utilities, and the trigger contract.
2. **A worked in-repo example** — scheduler + user router + target service,
   composed in a Cron system, deploy-ready, proven to fire on schedule by an
   in-process integration test.
3. **Doc sync** — ADR-0020 status, and any core-model touch-ups.

## 1. The trigger contract (`packages/app-cron/src/contract.ts`)

The one call edge, an RPC contract with a single method:

```ts
export const triggerContract = contract({
  trigger: rpc({ input: type({ jobId: 'string' }), output: type({ ok: 'boolean' }) }),
});
export type TriggerContract = typeof triggerContract;
```

The scheduler depends on it (`rpc(triggerContract)`); the router exposes it
(`expose: { trigger: triggerContract }`). The `jobId` travels as data through
this one method — adding a job never adds a method, service, or port (ADR-0020,
"One clock serves every job").

## 2. `defineSchedule` (`packages/app-cron/src/schedule.ts`)

Turns a job-id → interval map into a schedule value that (a) carries the typed
job ids for `serveSchedule`'s exhaustiveness and (b) yields the structured `jobs`
list the scheduler's param stores:

```ts
export interface Schedule<Ids extends string> {
  readonly jobs: ReadonlyArray<{ readonly jobId: Ids; readonly every: string }>;
}
export function defineSchedule<const S extends Record<string, string>>(
  spec: S,
): Schedule<keyof S & string>;
```

`defineSchedule({ tick: '60s', mrr: '24h' })` →
`{ jobs: [{ jobId: 'tick', every: '60s' }, { jobId: 'mrr', every: '24h' }] }`.
The `Ids` type parameter (`keyof S`) is what `serveSchedule` reads to force a
handler per job.

The `every` grammar is `<integer><unit>` with `unit ∈ {s,m,h,d}` (e.g. `30s`,
`24h`). A helper `parseEvery(s: string): number` returns milliseconds and throws
on a malformed value. This is the only interval format v1 supports.

## 3. The reusable scheduler (`packages/app-cron/src/scheduler.ts` + entry)

### The node

```ts
const scheduleSchema = type({ jobId: 'string', every: 'string' }).array();

export function cronScheduler<Ids extends string>(schedule: Schedule<Ids>) {
  return compute({
    name: 'scheduler',
    deps: { trigger: rpc(triggerContract) },
    params: { jobs: param(scheduleSchema, { default: schedule.jobs }) },
    build: node({ module: import.meta.url, entry: '../dist/scheduler-entry.mjs' }),
  });
}
```

The schedule value only sets the `jobs` param's **default** — the value the
deploy serializes into config. Nothing else about the scheduler varies per app;
it is job-agnostic.

### The entry (`packages/app-cron/src/scheduler-entry.ts` → `dist/scheduler-entry.mjs`)

The reusable boot module. It does **not** import the app's scheduler node — it
constructs its own and reads the real jobs from `config()`. This works because
S1's stash keys config by owner+param-name, address-free, not by node identity:
a scheduler node with the same `jobs`/`trigger` shape reads the same env keys the
platform wrapper stashed from the app's node.

```ts
import service from './scheduler.ts';        // a bare scheduler node (empty schedule)
const { trigger } = service.load();          // typed trigger(jobId) client
const { jobs } = service.config();           // the app's real schedule, from env
runScheduler({ jobs, call: (jobId) => trigger.trigger({ jobId }) });
```

**`runScheduler` is pure and injectable** so the firing logic is unit-testable
without a live process:

```ts
export function runScheduler(opts: {
  jobs: ReadonlyArray<{ jobId: string; every: string }>;
  call: (jobId: string) => Promise<unknown>;
  setTimer?: (fn: () => void, ms: number) => void;  // defaults to setInterval
}): void;
```

It parses each job's `every`, schedules a repeating timer per job that invokes
`call(jobId)`, and swallows/logs a rejected `call` (a missed tick is healed by an
idempotent target, never by scheduler state — ADR-0020). The default `setTimer`
is `setInterval`; tests pass a fake.

The scheduler carries the reserved `port` param (every `compute()` does) but
serves no HTTP — it is a caller. Binding a health port is out of scope; leave
`port` unused. (The "port should be an ingress capability" redesign is the
project's recorded follow-up, not this slice.)

## 4. `serveSchedule` (`packages/app-cron/src/serve-schedule.ts`)

The router's entry. Mirrors `@prisma/compose-rpc`'s `serve()` exactly — a fetch
handler that is **exhaustive over the schedule** at compile time — but the single
exposed `trigger` method dispatches internally on `jobId` to the matching
handler:

```ts
export function serveSchedule<S extends AnyRunnable, Ids extends string>(
  service: S,               // exposes { trigger: triggerContract }
  schedule: Schedule<Ids>,
  handlers: { [Id in Ids]: (deps: ReturnType<S['load']>) => Promise<unknown> },
): (req: Request) => Promise<Response>;
```

- `handlers` is a **required** mapped type over `Ids` — omitting a job id, or
  handling an id not in the schedule, is a type error, the same way a missing
  `serve()` method is (mirror `serve-handlers.test-d.ts`).
- Returns a `(req) => Promise<Response>` built on the same routing as `serve`:
  `POST /rpc/trigger` with `{ jobId }`, dispatch to `handlers[jobId]`, `{ ok:
  true }` on success. A malformed body is a 400 (arktype validates the wire like
  any RPC input); a well-formed but unscheduled `jobId` throws inside the handler
  and surfaces as `serve`'s 500 — unreachable from a matched scheduler, so it is
  left on `serve`'s standard error path rather than given bespoke 4xx handling.
- Calls `service.load()` once; passes the hydrated deps to each handler (like
  `serve`). The example's handlers close over the target client.

Prefer implementing `serveSchedule` **in terms of** `serve()` where clean (wrap
the single `trigger` method to dispatch on `jobId`); if `serve`'s internals don't
compose, a small parallel handler is acceptable, but the routing/error contract
must match.

## 5. The `cron()` system helper (`packages/app-cron/src/system.ts`)

The swap boundary. The app calls `cron(...)` and never provisions the scheduler
itself, so a future native realization (platform timer instead of an always-on
service) is an internal change, not an app change (ADR-0020, "Native later is a
realization swap"):

```ts
export function cron<RD extends Deps, Ids extends string>(
  name: string,
  opts: {
    schedule: Schedule<Ids>;
    router: ServiceNode<RD, any, { trigger: TriggerContract }>;  // must expose trigger
  },
): SystemNode<RD, Record<never, never>>;
```

The returned system's boundary `deps` mirror the router's own deps, forwarded
into the router; its body provisions the router and the scheduler and wires the
scheduler's `trigger` to the router:

```ts
system(name, { deps: opts.router-deps }, ({ inputs, provision }) => {
  const router = provision('router', opts.router, /* forward inputs */);
  provision('scheduler', cronScheduler(opts.schedule), { trigger: router.trigger });
  return {};
});
```

The parent wires the real work target into the cron system:
`provision('cron', cron('cron', { schedule, router: ingestRouter }), { ingest: ingest.rpc })`.
The exact generic plumbing for "forward the router's deps as the system's deps"
is the implementer's call, guarded by the example type-checking.

## 6. Package shape (`packages/app-cron/`)

**Superseded in review:** cron shipped as its own package briefly, then folded into `@prisma/compose-cloud/cron` — a subpath of Prisma Cloud's common-Systems package rather than a standalone one (one entry point per System, tree-shakable). The package-shape details below describe the superseded standalone-package form.

Model on `@prisma/compose-rpc` (authoring utilities) plus a built entry like a
compute service. `package.json` exports `.` (the authoring API) and the built
`scheduler-entry`. `tsdown.config.ts` lists `index` and `scheduler-entry` as
entries. Public API from `index.ts`: `defineSchedule`, `serveSchedule`,
`cronScheduler`, `cron`, `triggerContract`, and the `Schedule`/`TriggerContract`
types. `parseEvery`/`runScheduler` are internal (tested directly, not exported)
unless a test needs them exported.

Dependencies: `@prisma/compose`, `@prisma/compose-cloud` (`compute`), `@prisma/compose-node`
(`node` build adapter), `@prisma/compose-rpc` (`contract`, `rpc`, `serve`), `arktype`.

## 7. The worked example (`examples/cron-datahub/` or similar)

A minimal app proving the pipeline, structured like `examples/storefront-auth`:

- A **target** service exposing the real work (e.g. an `ingest` compute service
  with a `tick()`/`refreshMrr()` RPC contract, or reuse a trivial one).
- A **router** compute service: `deps: { ingest: rpc(ingestContract) }`,
  `expose: { trigger: triggerContract }`, entry = `serveSchedule(service,
  schedule, { tick: (d) => d.ingest.tick(), mrr: (d) => d.ingest.refreshMrr() })`.
- A **root system** composing them: provision the target, provision
  `cron('cron', { schedule, router })` wired to the target.
- `defineSchedule({ tick: '2s', mrr: '5s' })` (short intervals so the test is
  quick), its own `package.json`/`tsconfig`/`tsdown.config`, and a
  `prisma-compose.config.ts` if it is to be deployable.

**Proof of firing (the DoD test).** An in-process integration test (bun test,
like storefront-auth's `page.integration.test.ts`) that:

1. Boots the router's real entry with `bootstrapService` (from
   `@prisma/compose-cloud/testing`) against a fake target, so `POST /rpc/trigger`
   works over real HTTP.
2. Drives `runScheduler` (or the scheduler entry) with a **fake timer** against
   the booted router URL, advances time, and asserts `trigger` was called with
   the right `jobId`s the right number of times, and that each reached its
   handler.

A live cloud deploy is **not** required for the slice DoD (it is slow and the
always-on scheduler is awkward to tear down); the example is deploy-*ready* and
the firing is proven in-process with controlled time. Do not wire the example
into CI's "Deploy, verify, destroy" job.

## Definition of done

- [ ] `defineSchedule` yields the typed `Schedule`; `parseEvery` handles `s/m/h/d`
      and rejects malformed input (unit tests).
- [ ] `runScheduler` fires `call(jobId)` on each job's interval under a fake timer,
      and a rejected call does not stop the loop (unit test).
- [ ] `serveSchedule` forces a handler per schedule job id at compile time
      (`.test-d.ts` mirroring `serve-handlers.test-d.ts`) and dispatches
      `POST /rpc/trigger {jobId}` to the right handler at runtime (unit test).
- [ ] `cronScheduler(schedule)` builds a `compute()` whose `jobs` param default is
      the schedule; the scheduler entry reads jobs from `config()` and trigger from
      `load()`.
- [ ] The example composes scheduler + router + target in a Cron system, type-checks,
      and the integration test proves `trigger` fires on schedule end to end — the
      structured `jobs` param exercised through deploy-encode → boot-decode →
      `config()`.
- [ ] ADR-0020 status updated to Accepted; docs match what shipped.
- [ ] `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint` green from a clean tree.

## Non-goals (this slice)

- **Native platform cron.** Only the emulated always-on realization ships; the API
  is shaped so a native lowering is possible later (spec § Non-goals).
- **Durable / exactly-once / dynamic scheduling.** Stateless, build-time schedule,
  idempotent targets (ADR-0020 Consequences).
- **A live cloud deploy in CI.** Proof is in-process with controlled time.
- **The port→ingress redesign.** The scheduler keeps the reserved `port`; the
  redesign is the project's recorded follow-up.
- **Wiring datahub onto this cron.** That is the Forcing-Function Apps project.

## Files in play

New: `packages/app-cron/**` (`contract.ts`, `schedule.ts`, `scheduler.ts`,
`scheduler-entry.ts`, `serve-schedule.ts`, `system.ts`, `index.ts`,
`package.json`, `tsconfig.json`, `tsdown.config.ts`, `__tests__/**`);
`examples/<cron-example>/**`. Changed:
`docs/design/90-decisions/ADR-0020-*.md` (status), root `package.json`/workspace
if a package list needs the new package, `docs/design/10-domains/core-model.md`
if it enumerates packages.

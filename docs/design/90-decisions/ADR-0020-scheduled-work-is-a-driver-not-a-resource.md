# ADR-0020: Scheduled work is a driver, not a resource

## Status

Proposed

## Decision

Cron is modelled as a **driver**: a scheduler service that *depends on* the
endpoint it calls and invokes it on a timer. It is not a resource — nothing ever
`load()`s a cron binding. The schedule itself is **build-time configuration**, a
structured param on the scheduler, never runtime state.

```ts
// The reusable scheduler: depends on what it calls; the schedule is a param.
compute({
  name: 'scheduler',
  params: { jobs: /* [{ jobId: 'tick', every: '60s' }, …] — a structured param */ },
  deps:   { trigger: rpc(triggerContract) },   // trigger(jobId) — the ONE call edge
  build:  node({ module: import.meta.url, entry: '../dist/scheduler.js' }),
});

// The app composes it with a router it writes, inside a Cron system:
const router = provision('router', myRouter, { ingest: inputs.ingest });
provision('scheduler', cronScheduler(schedule), { trigger: router.trigger });
```

The user's `router` implements `trigger(jobId)` and dispatches each job id to
real work; the scheduler stays generic. Its deployment keeps one instance
always running — it is the clock.

## Reasoning

An ingest service exposes an endpoint that runs one budgeted step of work, and
it should be called every sixty seconds. The instinct is to model "cron" the way
the framework models a database — a resource the service depends on. But the
arrow points the wrong way. A resource is something the consumer *calls*: you
`load()` a client and invoke it. Cron *calls you*. It exposes nothing a consumer
could load; it is a caller.

Seen that way, no new machinery is needed. A caller is an ordinary consumer of
the callee's exposed endpoint — the same shape as a storefront depending on an
auth service's RPC port. The scheduler is a plain service whose declared
dependency is a `trigger(jobId)` endpoint; at runtime it `load()`s a typed
client for it and calls it when a job is due. The scheduler depends on the
router; the router does not depend on the scheduler. No cycle, no
"reverse-edge" primitive, and every call path — scheduler to router to target —
is a declared dependency, visible in the static graph the framework derives
from source.

**The schedule must be build-time data.** Suppose instead the scheduler exposed
a `schedule(interval, jobId)` endpoint and jobs registered themselves at
runtime. Two things break. Compute instances are stateless and get recycled at
the platform's discretion, so a schedule held in a booted instance's memory
evaporates on every restart. And the schedule becomes invisible at deploy time:
machinery that translates the graph into platform state can only translate what
the graph contains, so a runtime-registered schedule can never be lowered into a
platform's own scheduling primitives. Baking the jobs in as a param fixes both
— the scheduler re-reads them from config on every boot, and the same static
table is there for a native realization to read. This is what the structured,
schema-typed param exists for
([ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md)).

**One clock serves every job.** The job id travels as *data* through the single
fixed `trigger(jobId)` dependency, so adding a job never adds a service or a
port — the router's dispatch grows by one case and the `jobs` param by one
entry. That matters because the scheduler must run always-on: the platform has
no timer primitive and idle services scale to zero, so the emulated realization
pays for exactly one warm instance per app — never per job. A native platform
timer would remove even that.

**The authoring surface keeps jobs and handlers in sync.** Declaring a job in
the schedule and forgetting its handler (or vice versa) should not be
expressible. The framework already has this pattern: `serve()` forces a handler
for every method a service exposes. Scheduling gets the same pair — a schedule
definition, and a `serve()`-analog that is exhaustive over it:

```ts
export const schedule = defineSchedule({ tick: '60s', mrr: '24h' });

// The router's entry — omitting a job id is a type error, like a missing serve() method:
export default serveSchedule(service, schedule, {
  tick: () => ingest.tick(),
  mrr:  () => ingest.refreshMrr(),
});
```

`defineSchedule` produces the scheduler's `jobs` param; `serveSchedule` produces
the router's `trigger` handler. The job ids have one source of truth, checked by
the compiler.

**Native later is a realization swap, not an app change.** The router only ever
speaks the `trigger(jobId)` interface, and the schedule is static data. A native
scheduler realization lowers the same `jobs` table into platform triggers that
call `router.trigger(jobId)` directly, and the always-on service disappears.
Nothing the app authored moves.

## Consequences

- **Cron composes from existing primitives.** A service depending on a
  sibling's exposed endpoint, wrapped with a router in a system — nothing new in
  the composition model. If an implementation reaches for a new primitive, that
  is a signal the design is being misread.
- **The scheduler holds no state.** The schedule is config; missed ticks are
  healed by idempotent targets, not by scheduler bookkeeping. Durable,
  exactly-once, and runtime-registered scheduling are deliberately excluded
  until a real consumer needs them — they are a different, stateful feature.
- **The emulated realization keeps one instance always on**, because the
  platform offers no timer and scales idle services to zero. One standing
  instance per app is the accepted cost; a platform timer primitive is the thing
  that would eliminate it.
- **Cron and resources do not share a mould.** Object storage is a resource (you
  load a client and call it); cron is a driver (it calls you). Modelling them
  identically would force one of them through the wrong shape.

## Alternatives considered

- **A stateful cron server with runtime registration** (`schedule(interval,
  jobId)` RPC). Rejected: the schedule dies with each stateless instance, the
  call edges vanish from the static graph, and the scheduler↔router dependency
  becomes cyclic (each calls the other).
- **One scheduler service per job.** Rejected on cost: every scheduler is an
  always-on instance. Job-id-as-data fans one clock out to any number of jobs.
- **A "resource that calls you" — a reverse-edge composition primitive.**
  Rejected as unnecessary: reframing the scheduler as an ordinary consumer of
  the target's endpoint makes the inversion disappear.
- **Cron as a loadable resource with a client** (`load()` returns a cron
  handle). Rejected: there is nothing meaningful for the consumer to call; the
  interaction is entirely inbound. The binding model has nothing to bind.

## Related

- [`ADR-0018`](ADR-0018-config-params-carry-a-caller-owned-schema.md) /
  [`ADR-0019`](ADR-0019-the-target-owns-config-serialization.md) — the
  structured, target-serialized param the schedule rides on.
- [`ADR-0013`](ADR-0013-resources-are-provisioned-by-systems-deps-are-declarations.md)
  — the resource model cron deliberately is *not*.
- [`ADR-0016`](ADR-0016-a-system-has-the-same-boundary-as-a-service.md) — the
  system composition the Cron wrapper uses.
- [`../10-domains/scheduled-work.md`](../10-domains/scheduled-work.md) — the
  topology and authoring surface in full.

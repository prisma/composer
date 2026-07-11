# Scheduled work (cron)

How the framework runs work on a schedule. Rests on
[ADR-0020](../90-decisions/ADR-0020-scheduled-work-is-a-driver-not-a-resource.md)
(cron is a driver, not a resource); the schedule rides on a structured param
([`config-params.md`](config-params.md)).

## The problem in one example

An ingest service exposes an endpoint that runs one budgeted step of work —
pull a page of records, checkpoint, return. It needs to be called every sixty
seconds, and a rollup endpoint next to it every day. The platform offers no
timer: services are invoked by requests, and idle services scale to zero.
Something has to *be* the clock, and the app has to declare — in code, visibly
in its graph — what gets called on what schedule.

## Cron is a driver

The framework's resources (a database, object storage) are things a service
*calls*: you `load()` a client and invoke it. Cron is the opposite — it calls
*you*. There is nothing for a consumer to load; the interaction is entirely
inbound. So cron is not modelled as a resource with a binding but as a
**driver**: an ordinary service whose declared dependency is the endpoint it
invokes, exactly the shape of a storefront depending on an auth service's RPC
port. The dependency arrow already points the right way; no new composition
primitive is involved.

## The three units

```
Cron system  (input: the target's interface)
├── scheduler   depends on trigger(jobId) · schedule as a param · the clock
└── router      exposes trigger(jobId) · depends on the target · dispatches jobId → work
```

The **scheduler** is reusable and shipped by the framework: a service with one
dependency — a `trigger(jobId)` endpoint — and one param — the schedule. Its
runtime reads the schedule, arms a timer per entry, and calls
`trigger(jobId)` when one is due. It knows nothing about any particular job.

The **router** is the user's, and small: it implements `trigger(jobId)` and
dispatches each id to real work through its own declared dependencies. The
scheduler depends on the router; the router does not depend on the scheduler —
no cycle.

The **Cron system** wraps the two behind one boundary, taking the target's
interface as its input. The app wires it like any other system:

```ts
// system.ts
const ingest = provision('ingest', ingestService, { db });
provision('cron', cron(schedule, router), { ingest: ingest.rpc });
```

`cron(schedule, router)` is the extension's system factory: it provisions the
scheduler (schedule baked into its param) and the user's router, and wires
`scheduler.trigger → router` internally.

## The schedule is build-time data

The schedule is a param on the scheduler — declared in code, serialized into
the deployment's config, re-read on every boot — never state registered at
runtime. Two facts force this. Instances are stateless and recycled at the
platform's discretion, so a schedule held in a booted process's memory dies
with it. And deploy-time machinery can only act on what the graph contains: a
schedule that exists only inside a running instance can never be translated
into a platform's own scheduling primitives, while a static `jobs` table can.

Because a schedule is a structured value (a list of `{ jobId, every }`), it
rides on a schema-typed param and round-trips through platform storage like any
other config — that pipeline, with this very value as the worked example, is
[`config-params.md`](config-params.md).

## One clock, jobId as data

Adding a job adds an entry to the schedule and a case to the router — never a
service or a port. The job id travels as data through the single fixed
`trigger(jobId)` edge, and the router fans it out. This is what keeps the cost
model flat: because the platform has no timer and idles services to zero, the
scheduler must run always-on, and one warm instance per app is the entire
standing cost — regardless of how many jobs it drives.

## Authoring surface

A job declared without a handler, or a handler without a job, should not
compile. The framework already has this pattern in `serve()`, which forces a
handler for every exposed method; scheduling mirrors it:

```ts
// jobs.ts — static; read at deploy (the scheduler's param) and at boot (the router)
export const schedule = defineSchedule({ tick: '60s', mrr: '24h' });

// router entry — exhaustive over the schedule's job ids:
const { ingest } = service.load();
export default serveSchedule(service, schedule, {
  tick: () => ingest.tick(),
  mrr:  () => ingest.refreshMrr(),
});   // omitting `mrr` is a type error, like a missing serve() method
```

`defineSchedule` produces the schedule (the scheduler's `jobs` param);
`serveSchedule` produces the router's `trigger` handler, checked exhaustive
over the same object. The job ids have one source of truth.

## Emulated now, native later

The always-on scheduler is the **emulated** realization — a plain compute
service being a clock, because the platform has no better primitive. A
**native** realization, on a platform with its own scheduler, lowers the same
static `jobs` table into platform triggers that call `router.trigger(jobId)`
directly — and the standing service disappears. The router and everything
behind it are untouched: they only ever spoke the `trigger` interface, and the
schedule was always static data both realizations read. Swapping realizations
is a deployment concern, not an app change.

## Deliberately excluded

Durable, exactly-once, and runtime-registered (dynamic) scheduling. The
scheduler holds no state: the schedule is config, and a missed tick is healed
by the target being idempotent — the datahub-style ingest pattern of budgeted,
checkpointed, re-runnable steps. Stateful scheduling is a different feature,
added when a real consumer needs it, not before.

## Related

- [ADR-0020](../90-decisions/ADR-0020-scheduled-work-is-a-driver-not-a-resource.md)
  — the decision and its alternatives.
- [`config-params.md`](config-params.md) — the structured param the schedule
  rides on.
- [`system-composition.md`](system-composition.md) — the boundary/wiring model
  the Cron system uses.
- [`connection-contracts.md`](connection-contracts.md) — `rpc`/`serve`, which
  `trigger` and `serveSchedule` build on.

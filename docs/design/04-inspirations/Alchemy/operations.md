# Alchemy operations (research)

This document enumerates the "verbs" (operations) on the core domain concepts, as
implied by the **Alchemy v2** model.

Source context: [Alchemy v2 docs](https://v2.alchemy.run) (local mirror: `./docs/`)

## Operations on Resources

- **Declare a Resource**
  - `Cloudflare.R2Bucket("Bucket")`, `AWS.SQS.Queue("Jobs")`, etc. Returns a
    description; nothing happens until it's `yield*`-ed in a Stack.
  - Authoring a new kind: define `Resource<Type, Props, Attributes>` + a Provider.
- **Yield a Resource into the graph**
  - `const bucket = yield* Bucket` inside the Stack effect — joins the plan.
- **Reference a Resource elsewhere**
  - `Resource.ref(id, { stack, stage })` — read an already-deployed resource's
    attributes from persisted state.
- **Lifecycle (engine-driven, via the Provider)**
  - `read` (observe live/persisted state), `diff` (no-op / update / replace),
    `reconcile` (converge to desired), `delete` (idempotent removal).

## Operations on Stacks and Stages

- **Define a Stack**
  - `Alchemy.Stack(name, { providers, state }, Effect.gen(...))`; export default.
- **Deploy / destroy / plan**
  - `alchemy deploy` (plan → approve → apply), `alchemy destroy` (plan with all
    marked deleted), `alchemy plan` / `--dry-run` (print diff, exit).
- **Local dev**
  - `alchemy dev` — plan + apply continuously on file changes; infra in cloud,
    handler local.
- **Select a Stage**
  - `--stage prod` (default `dev_$USER`); each stage has isolated state + names.

## Operations on Platforms (compute)

- **Declare a Platform**
  - `Cloudflare.Worker(name, { main }, initEffect)` / `AWS.Lambda.Function(...)` /
    `Cloudflare.Container(...)`. The init Effect returns the runtime handler(s).
- **Bind Resources to it**
  - Inside init: `const bucket = yield* Cloudflare.R2.ReadWriteBucket(Bucket)`.
- **Handle requests**
  - Return `{ fetch: Effect.gen(...) }` (Effect style) or `async fetch(req, env)`
    (async style with `InferEnv`).

## Operations on Bindings

- **Bind a Resource**
  - `yield* Resource.bind(target)` / `yield* Cloudflare.R2.ReadWriteBucket(ref)`.
  - At deploy: records permissions (IAM / Worker binding) + env/config.
  - At runtime: returns the typed SDK client (`bucket.get(...)`, `bucket.put(...)`).
- **Bind an event source**
  - `SQS.messages(queue).subscribe(fn)`, `Kinesis.records(stream).process(fn)`,
    `DynamoDB.stream(table).process(fn)` — records arrive as an Effect `Stream`.
- **Bind a sink**
  - `SQS.QueueSink.bind(queue)` — exposes the resource as an Effect `Sink` and
    emits the matching batch IAM.

## Operations on Layers

- **Define a Layer**
  - `Layer.effect(ServiceTag, Effect.gen(...))` — declare resources, wire
    bindings, return the typed service implementation.
- **Provide a Layer**
  - `.pipe(Effect.provide(JobServiceKV))` to satisfy a consumer's service
    dependency; `Layer.provide` to satisfy a Layer's own deps privately.
- **Compose Layers**
  - `Layer.mergeAll(a, b, c)` for multiple independent services;
    `Layer.provideMerge` to supply *and* expose a service.
- **Swap an implementation**
  - Change the provided Layer (`JobServiceKV` → `JobServiceR2`); consumers are
    untouched, the next deploy retires the old resources.

## Operations on Providers

- **Author a Provider**
  - `Provider.effect(ResourceClass, Effect.gen(...))` returning a `ProviderService`
    with `reconcile` + `delete` (and optional `diff` / `read` / `precreate`).
- **Acquire credentials**
  - Declare a credentials service; resolve it from the profile/auth system
    (`AuthProvider`: `configure` / `login` / `logout` / `read`).
- **Bundle into a `providers()` Layer**
  - `Provider.collection([...])` + `Layer.provide(...)` so users wire it with one
    call (like `Cloudflare.providers()`).

## Operations on State

- **Choose a store**
  - Default local `.alchemy/`; remote via `state: Cloudflare.state()`; or a
    custom `StateService` Layer (Postgres/S3/Redis/…).
- **Persist / read**
  - Engine writes state per `{ stack, stage, fqn }` on apply; references read it
    at plan time.

## Open questions / assumptions

- Assumption: every operation routes through the engine + state store; there is
  no first-class "serialize the desired graph and hand it off" verb.
- Open question: exact mechanics of extracting/serializing the resource graph for
  an external consumer (would underpin a MakerKit "emit artifact" operation).

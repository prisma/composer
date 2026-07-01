# Alchemy execution flows (research)

This document captures the common execution flows that define the **Alchemy v2**
interaction pattern — especially the loop: **declare resources, wire bindings,
deploy (plan → apply), run**.

Source context: [Alchemy v2 docs](https://v2.alchemy.run) (local mirror: `./docs/`)

## Flow 1: The core developer loop (declare → bind → deploy → run)

### 1) Declare resources and platforms

User writes a program: passive Resources (`R2Bucket`, `D1Database`, `SQS.Queue`)
and Platforms that carry runtime code (`Cloudflare.Worker`, `AWS.Lambda.Function`).
Resources are descriptions until `yield*`-ed inside a Stack.

### 2) Wire with bindings

Inside a Platform's init closure, `yield* Resource.bind(...)` returns a typed
client and records — for deploy time — the permissions and env that client needs.
"The binding is the client."

### 3) `alchemy deploy`

The engine **plans**: each Provider's `read` + `diff` compares desired props
against persisted state and classifies every resource (create / update / replace /
delete / no-op). After approval it **applies**: `reconcile` / `delete` run in
dependency order, and state is persisted per stack/stage.

### 4) Run

The deployed Platform handles requests. Bindings resolve to live SDK clients at
cold start; the `fetch` closure runs per request.

Key property: **one typed program defines and provisions the system** — no
separate manifest, no ARN/env plumbing by hand.

## Flow 2: Plantime vs runtime (the phase split)

1. The **init closure** (outer) runs at **plantime** to discover bindings — so
   the engine can wire permissions, env, and references.
2. It runs **again at runtime cold start** inside the deployed handler, where the
   same `bind()` calls return live SDK clients.
3. The **runtime closure** (inner `fetch`) runs only in the deployed handler, per
   request. `Alchemy.RuntimeContext` exists only here; the type system rejects
   runtime-only effects at plantime ("colored functions").

This is how Alchemy ships `bucket.get(...)` into a Worker without bundling
provisioning code: provisioning lives in `Binding.Policy` (plantime), the SDK
wrapper in `Binding.Service` (runtime).

## Flow 3: Swap an implementation behind a Layer (ports/adapters)

1. Define a service interface (`Context.Service`, e.g. `JobService`) — no cloud
   in the signature.
2. Implement it as a Layer that declares its own resources + bindings
   (`JobServiceKV` backs it with a KV namespace).
3. A consumer `yield* JobService` and `.pipe(Effect.provide(JobServiceKV))`.
4. To move to R2: swap the provided Layer to `JobServiceR2`. The consumer's
   `fetch` is byte-for-byte unchanged; the next deploy retires the KV namespace
   and creates the R2 bucket.

The Cloudflare-vs-AWS surface is absorbed by the Layer; the consumer's type
collapses to `RuntimeContext` only.

## Flow 4: Connect across Stacks / Stages (references)

1. A long-lived `staging` stage owns an expensive resource (e.g. a Neon DB).
2. An ephemeral `pr-42` stage does `Neon.Project.ref("app-db", { stage: "staging" })`
   or `yield* Backend` to read another stack's exposed outputs.
3. Resolution is **lazy, at plan time, from persisted state** — no cloud call,
   fails fast with `InvalidReferenceError` if the upstream isn't deployed.

This is concrete, address-based coupling (`{ stack, stage, id }`), distinct from
the interface-based substitution of Flow 3.

## Flow 5: Local development (`alchemy dev`)

1. `alchemy dev` deploys the **real** infrastructure to the cloud (R2, D1, KV are
   real), and runs the **handler locally** in `workerd` behind a proxy.
2. File changes hot-reload the handler in milliseconds; cloud resources persist
   across reloads.
3. Alchemy deliberately **rejects full local emulation** ("no fidelity gaps") —
   only application code runs locally.

## Flow 6: Stream pipeline (event source → transform → sink)

1. Bind an event source: `DynamoDB.stream(OrdersTable).process(...)` hands records
   as an Effect `Stream`.
2. Transform with ordinary `Stream` combinators (`filter`, `map`, `retry`,
   `groupedWithin`).
3. Run into a sink: `Stream.run(SQS.QueueSink.bind(Outbound))`.
4. Alchemy generates both sides of the IAM and the event-source mapping; the
   whole pipeline is one expression.

## Open questions / assumptions

- Assumption: Flows 1–2 always run through the engine; there is no documented
  "produce the plan/graph as a portable artifact and stop" flow.
- Assumption: `alchemy dev`'s "real cloud, local handler" model is a fixed stance,
  not a configuration — relevant where MakerKit wants local emulation instead.
- Open question: how event-source/sink flows (Flow 6, tied to cloud queues) would
  map onto a Durable-Streams-backed substrate.

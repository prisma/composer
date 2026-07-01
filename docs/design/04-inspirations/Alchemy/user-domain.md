# Alchemy user domain map (research)

This doc focuses on the **user's mental model**: what concepts they name,
configure, and rely on day-to-day — and how that maps to internal mechanics. It
describes **Alchemy v2**.

Source context: [Alchemy v2 docs](https://v2.alchemy.run) (local mirror: `./docs/`)

## The user's ubiquitous language (what they "think in")

- **Resource**: "a cloud thing I want to exist — a bucket, a database, a worker"
- **Stack**: "all my app's resources, deployed together as one unit"
- **Stage**: "which environment — my dev copy, staging, prod, this PR"
- **Platform**: "the compute my code runs on — a Worker or a Lambda"
- **Binding**: "the resource, handed to my code as a typed client — no env vars,
  no IAM by hand"
- **Layer**: "a swappable implementation behind an interface — KV today, R2
  tomorrow, without touching the consumer"
- **Provider**: "the thing that knows how to create a resource type"

### The key user promise

The recurring flow is:

1. **Declare resources and platforms** in TypeScript (one program, not a separate
   infra project).
2. **Wire them with bindings** — `bind()` returns a typed client and, at deploy,
   emits the permissions/env that client needs.
3. **(Optionally) hide infrastructure behind Layers** so consumers depend on an
   interface, not a cloud primitive.
4. **`alchemy deploy`** — the engine plans and applies the whole graph against
   the cloud; **`alchemy dev`** runs the same infra with the handler local.

The core shift vs traditional IaC: **infrastructure and the application logic
that uses it are the same typed program** — "the binding is the client", not a
manifest plus an ARN lookup.

## User concepts vs internal mechanics (mapping)

| User concept | What it feels like | Internal-ish mechanism it implies |
|---|---|---|
| Resource | "Declare a cloud thing; it exists after deploy" | Provider `reconcile` in a plan→apply loop, state persisted per stack/stage |
| Binding | "The resource *is* my client" | Deploy-time IAM/Worker-binding + env injection; runtime SDK wrapper (`Binding.Policy` vs `Binding.Service`) |
| Platform | "Where my handler runs" | A Resource that also bundles + uploads the runtime Effect |
| init vs `fetch` | "Set up once, handle each request" | Plantime/runtime phase split; `RuntimeContext` gates runtime-only effects |
| Layer | "Swap the backing store without rewrites" | Effect `Layer` provides a `Context.Service`; resources join the stack when the Layer is provided |
| Reference | "Use something another stack already deployed" | Lazy read of persisted state by `{ stack, stage, id }` |
| Stage | "An isolated copy of my app" | State namespace + deterministic physical names per stage |

## Is the user's domain map the same as the system's?

Largely yes — more so than most tools, because **the program *is* the system**.
The user declares resources and the engine reconciles exactly those resources;
there is no parallel manifest to drift.

The main indirections the user must internalize:

- **Plantime vs runtime** — the init closure runs both at deploy and at cold
  start, the `fetch` closure only in the deployed handler. The type system
  enforces it (a runtime-only effect won't compile at plantime), but it is a
  concept users must hold.
- **Layer vs Reference** — two different "connect to something" mechanisms: Layer
  is in-process interface substitution; Reference is a concrete cross-deployment
  pull from state. They do not unify.
- **The engine owns state** — "what's deployed" lives in a state store (local or
  remote), not just in the cloud. Losing/relocating state matters.

## Open questions / assumptions

- Assumption: most Alchemy users think in "**resources + the code that binds
  them**", deployed from their own machine/CI, against their own cloud
  credentials. The developer's program is the orchestrator.
- Open question: how much does the **client-side apply + client-side state**
  model match a *managed* platform's needs (where the platform, not the
  developer, should own reconciliation state)? This is the crux for MakerKit —
  see `takeaways-for-makerkit.md`.

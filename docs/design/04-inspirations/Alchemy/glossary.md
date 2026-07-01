# Alchemy glossary (research)

This glossary is written from a DDD perspective: *terms*, *what they mean*, and
*what operations exist on them*. It describes **Alchemy v2** ("Infrastructure-as-
Effects").

Source context: [Alchemy v2 docs](https://v2.alchemy.run) (local mirror: `./docs/`)

## Core terms

### Resource

A named cloud entity Alchemy manages — bucket, database, queue, worker, IAM
role, DNS record. Typed as `Resource<Type, Props, Attributes>`. Declared as an
Effect and `yield*`-ed inside a Stack; "just a description until yielded".

- **User-facing?** Yes (the central noun).
- **Key operations**: declare, `yield*`, reference (`.ref`); engine-driven
  `diff` / `reconcile` / `delete`.

### Props (input properties)

The desired configuration passed when declaring a Resource. Pure data.

- **User-facing?** Yes.
- **Key operations**: set at declaration; diffed against previous props on deploy.

### Attributes (output attributes)

The values the cloud returns after creation — ARNs, URLs, generated ids.
Surfaced as `Output`s.

- **User-facing?** Yes (read).
- **Key operations**: read, flow into other Resources' props.

### Stack

A collection of Resources deployed together as a unit; the root of an Alchemy
program. `Alchemy.Stack(name, { providers, state }, effect)`.

- **User-facing?** Yes.
- **Key operations**: define, `deploy`, `destroy`, `plan`, `dev`.

### Stage

An isolated instance of a Stack — `dev_sam`, `staging`, `prod`, `pr-42` — each
with its own state and distinct physical resource names.

- **User-facing?** Yes.
- **Key operations**: select (`--stage`), reference across stages.

### Provider

Teaches Alchemy how to manage a Resource type; implements the lifecycle
(`reconcile`, `delete`, optional `diff` / `read`). A Provider is an Effect
`Layer`, wired into a Stack via `Cloudflare.providers()` / `AWS.providers()`.

- **User-facing?** Partially — you *select* providers; you *author* one only to
  support a new cloud / third-party API.
- **Key operations**: implement lifecycle hooks, bundle into `providers()`,
  register against a Resource type.

### Platform

A special kind of Resource that ships **runtime code along with its
infrastructure** — Cloudflare Worker, AWS Lambda, Cloudflare Container. Bundles
cloud config + the Effect that runs inside it.

- **User-facing?** Yes (this is where your handler lives).
- **Key operations**: declare, bind Resources to it, deploy.

### Binding

Connects a Resource to a Platform. One `bind()` call emits the permissions (IAM
on AWS / native Worker binding on Cloudflare) **and** env/config, **and** returns
a typed SDK client. "The binding **is** the client" — no `env.BUCKET`, no
hand-written policy.

- **User-facing?** Yes.
- **Key operations**: `bind`; call the typed client at runtime; (deploy-time:
  emit policy + env). Also event-source (`.subscribe` / `.process`) and sink
  variants.

### Layer

A unit of *encapsulated infrastructure* behind a typed service interface (Effect
`Layer` + `Context.Service`). Owns whatever Resources and bindings it needs,
returns a typed implementation, hides the rest. Consumers depend on the
interface, not the implementation — swap the Layer to swap the infrastructure.

- **User-facing?** Yes.
- **Key operations**: define (`Layer.effect`), `provide`, `mergeAll`, swap.

### Output<T>

Alchemy's lazy reference type — the values that flow between Resources, composed
with `.pipe` / map / interpolation and resolved during deploy.

- **User-facing?** Yes.
- **Key operations**: map, interpolate, resolve.

### Reference

A typed, lazy pointer to an **already-deployed** Resource or Stack in another
stack/stage. Resolves from the persisted state store at plan time (no cloud
call). `Resource.ref(id, { stack, stage })` / `yield* MyStack`.

- **User-facing?** Yes.
- **Key operations**: `ref`, read exposed stack outputs; fails fast with
  `InvalidReferenceError` if the upstream isn't deployed.

### Action

A node in the dependency graph that runs an Effect during apply when its inputs
change.

- **User-facing?** Yes (advanced).
- **Key operations**: declare, run-on-change.

### Secret / Config

Env vars and secrets read via `effect/Config` at init time and automatically
bound onto the deploy target (e.g. as a `secret_text` binding).

- **User-facing?** Yes.
- **Key operations**: read (`Config`), bind as secret.

## Internal-ish terms (helpful for modeling)

### Engine (plan → apply loop)

Drives providers: `read` + `diff` build the plan; `reconcile` + `delete` apply it
in dependency order. The same engine powers `deploy`, `destroy`, and `dev`.

- **User-facing?** Indirectly (via the CLI).

### reconcile / diff / read / delete

The provider lifecycle verbs. `reconcile` is convergent (observe → ensure →
sync → return) so partial failures are safe to retry.

- **User-facing?** Only for provider authors.

### Phases: plantime vs runtime

Two phases of every program. **Plantime** = the deploy (build the graph, run
providers, persist state). **Runtime** = the deployed handler, per request. The
init closure runs at both; the runtime closure runs only in the deployed handler.

- **User-facing?** Yes (you write init vs `fetch`).

### RuntimeContext

The Effect service that exists *only* inside the runtime closure. The type system
rejects runtime-only effects anywhere else — a type-level "colored function"
boundary between plantime and runtime.

- **User-facing?** Yes (appears in types).

### State Store

Persists each Resource's state (props, attributes, instance id, status, bindings)
keyed by stack + stage, so the engine can diff future deploys. Local `.alchemy/`
by default; remote stores (e.g. Cloudflare-backed) for teams; pluggable.

- **User-facing?** Yes (configure it).
- **Key operations**: persist, read (references), customize.

### AuthProvider / Profiles

Credential resolution per environment. `alchemy login` configures credentials
under `~/.alchemy/`; providers read them at deploy time (or from env on CI).

- **User-facing?** Indirectly (`alchemy login`).

## Open questions / assumptions

- Assumption: the **plan is an internal step of apply** — computed via providers'
  `read`/`diff` against live/persisted state — not a portable static artifact
  emitted for an external orchestrator. (Inferred; see `viability-assessment.md`.)
- Assumption: the **state store is the source of truth** for "what's
  provisioned", and it is **client-side by default**.
- Open question: can the desired resource graph be **extracted without running
  the apply loop**? This bears directly on whether MakerKit can keep Alchemy's
  definition language while replacing its engine.

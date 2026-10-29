# Example app (anchor)

A fictional e-commerce app, used to keep design discussions concrete. It exercises
every core piece of the model: **Modules** wrapping **Services** and
**Resources**, both connection styles (request/response and stream), a Postgres
shared across Modules and carved by data contracts, private Resources owned
inside a Module, and an external dependency that lives as **Configuration**
rather than a node.

## The app

- A **Storefront** (Next.js) — the public site.
- **Sales & Billing** — an internal HTTP API the storefront calls to record orders.
  It owns a private **invoices** store (object storage) and emails receipts through
  an external provider it doesn't provision.
- **Delivery** — its own HTTP service; reacts to placed orders and pushes live
  status updates, backed by a private **Redis**.
- **Auth** (BetterAuth-style) — owns the auth tables, exposes an auth API.
- One **Postgres**, shared by Sales, Delivery, and Auth — each owning its own slice.

## Topology

```mermaid
flowchart TB
  User((User))

  subgraph Storefront["Module: Storefront"]
    SF["Next.js · Compute Service"]
  end
  subgraph Sales["Module: Sales & Billing"]
    SA["Sales API · Compute Service"]
    INV[("Invoices · object storage")]
    SA --- INV
  end
  subgraph Delivery["Module: Delivery"]
    DE["Delivery · Compute Service"]
    RD[("Updates · Redis")]
    DE --- RD
  end
  subgraph Auth["Module: Auth"]
    AU["Auth API · Compute Service"]
  end
  PG[("Postgres — shared Resource")]
  EMAIL["external email · egress (Configuration — not a node)"]

  User -->|request/response · ingress| SF
  SF -->|request/response| SA
  SF -->|request/response| AU
  SA -->|stream · order-placed| DE
  SA -->|data · sales contract| PG
  DE -->|data · delivery contract| PG
  AU -->|data · auth contract| PG
  SA -.->|email| EMAIL
```

Solid edges are connections in the topology. The dashed email edge is an
**egress** — it leaves the graph, so it's Configuration on the Sales Service, not a
node.

## Decomposition

Each Module is a bounded context wrapping a Service (its code) plus any private
Resources. Storefront and Auth are single-Service Modules; Sales and Delivery each
own a private Resource alongside their Service.

| Module | Services | Private Resources | Depends on | Exposes |
| --- | --- | --- | --- | --- |
| **Storefront** | Next.js | — | `sales` (r/r), `auth` (r/r) | `site` (r/r · **ingress**) |
| **Sales & Billing** | Sales API | Invoices (object storage) | `data` (TCP · *sales* contract); `email` (**egress** → Configuration) | `sales` API (r/r); `order-placed` (stream) |
| **Delivery** | Delivery API | Redis (live updates) | `data` (TCP · *delivery* contract); `order-placed` (stream) | `delivery` API (r/r · internal) |
| **Auth** | Auth API | — | `data` (TCP · *auth* contract) | `auth` API (r/r) |

Plus one shared **Resource**, owned by the outermost Module (not by any of the four):

| Resource | Exposes |
| --- | --- |
| **Postgres** (shared) | `data`, a data interface offering the contract hashes `{sales, delivery, auth}` — the **aggregate contract** |

## What the example demonstrates

- **All the node types.** Four **Modules** (the bounded contexts) wrap **Services**
  (the code) and **Resources** (the shared Postgres, the invoices bucket, the
  Redis). **Configuration** — the email key — is not a node.
- **Both connection styles.** Storefront → Sales and Storefront → Auth are
  **request/response**; Sales → Delivery (*order-placed*) is a **stream**. Not
  everything is a stream.
- **The shared Postgres has one owner — the outermost Module.** It isn't owned by
  Sales, Delivery, or Auth; it's owned by the **outermost Module** (the module
  topology), which wires it to each consumer's data dependency and owns its migration. Sales,
  Delivery, and Auth each declare only the contract slice they need; the owner's
  schema satisfies the **aggregate** (the union), and consumer slices don't overlap.
  Shared instance, single migration owner, every data dependency still a visible edge.
- **Private Resources stay inside.** The invoices bucket and the Redis are owned
  within their Module, so they never become cross-Module edges — only the
  shared Postgres does. Boundaries live at the authoring plane.
- **Configuration leaves the graph.** Sales emails receipts through a provider it
  doesn't provision — an **egress** backed by an API key. That's Configuration on
  the Sales Service, so it's neither a node nor a topology edge; hence the dashed
  arrow, drawn outside every Module.
- **Ingress vs internal.** Only Storefront's exposed `site` interface is public ingress; the
  sales/auth/delivery APIs are internal request/response interfaces that other Modules
  depend on.
- **Encapsulation by convention.** No Module reads another's tables; cross-Module needs go
  through an exposed interface (an API, the *order-placed* stream), never the database. The
  recommended convention, not (yet) an enforced rule.
- **A Module behaves like a Service.** Each is stateless and reprovisionable
  with typed dependencies and exposed interfaces, so if Delivery grew enough to split internally, a nested
  Module would wire exactly like the Service it replaced.

## How it lowers (sketch)

Per `layering.md`: each Service → a Compute service (bundle + manifest, an Alchemy
Platform); the shared Postgres → one Database (Environment:Database is 1:1) owned
and migrated by the outermost Module, its schema satisfying the aggregate contract; the
invoices bucket and the Redis → their
own Alchemy Resources (provider create/update/delete), provisioned per environment;
the `order-placed` stream → a Stream; each request/response edge → an endpoint +
injected typed client; each data dependency → a contract-scoped connection injected at
runtime (no `DATABASE_URL` in user code); the email key → `effect/Config` bound to
the Sales Service's environment. The framework emits the whole graph as the
topology artifact — Configuration and egress ride along as environment binding,
not nodes.

## Open questions / deferred

- Whether Delivery needs to expose a request/response interface at all, or is purely
  stream-driven — depends on the product.
- **Auth: Module or external?** As modelled, Auth is a **Module** that owns its
  tables. If instead you used a hosted BetterAuth you don't provision, it wouldn't be an
  external *node* — it'd be **Configuration** (an API key) as an egress on whatever
  Service calls it, or a thin Auth **Service** wrapping it. Which fits BetterAuth is
  TBD.
- Connection-method richness (pooled, WebSocket) is deferred; the example uses `TCP`
  throughout.

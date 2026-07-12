# Convex → Prisma Compose takeaways (evolving)

This doc is explicitly **not** "research." It records what we currently believe Prisma Compose should emulate/adapt from Convex, and it is expected to change as the framework's design evolves.

Primary reference: [Convex Developer Hub](https://docs.convex.dev)

## The core interaction pattern to base Prisma Compose on

**Write a query → subscribe to it → mutations update data → UI updates automatically**.

That is the foundational shift away from:

- request/response endpoints tailored per view
- "refetch then rerender" as the default correctness strategy

Convex achieves this with a **server-side source of truth** and **push-based reactivity**. TanStack DB achieves it with **client-side collections** and **local query engine**. Prisma Compose's topology may sit between or differ; the interaction pattern (subscribe once, get pushed updates) is what we want to preserve.

## What we want to emulate directly

- **Reactive subscriptions as the default**
  - Queries are subscribable by default; no separate "live" vs "one-off" mode for the common case.
- **Generated API for type safety**
  - End-to-end types from schema + function signatures to client calls.
- **Simple function taxonomy**
  - Query (read, cached, reactive), Mutation (write, transactional), Action (side-effect, external). Clear boundaries.
- **Optimistic updates as an opt-in layer**
  - Not required for correctness; add when UX demands it. Rollback is automatic.

## What we likely need to adapt for Prisma Compose

- **Where the source of truth lives**
  - Convex: server. TanStack DB: client (with sync). Prisma Compose:
    may involve streams, materializers, durable facts — different primitives.
- **Function placement**
  - Convex: all functions in `convex/` directory, deployed as a unit. The Prisma
    App Framework: descriptors, topology, artifacts may imply different
    packaging.
- **Subscription granularity**
  - Convex: per-query, per-args. Prisma Compose: may need
    query-driven sync, progressive loading, or view-based subscriptions — see
    TanStack takeaways.

## Near-term design questions this raises

- How do we expose a "subscribe and get pushed updates" primitive that works with Prisma Compose's stream/materializer model?
- Should we adopt Convex's three-way split (query / mutation / action) or a different taxonomy?
- What is our equivalent of `npx convex dev` — a control-plane command that validates, syncs, and generates artifacts?
- How do optimistic updates map when the source of truth is durable streams rather than a single DB?


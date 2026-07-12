# TanStack DB → Prisma Compose takeaways (evolving)

This doc is explicitly **not** “research.” It records what we currently believe Prisma Compose should emulate/adapt from TanStack DB, and it is expected to change as the framework’s design evolves.

Primary reference: [TanStack DB Overview](https://tanstack.com/db/latest/docs/overview)

## The core interaction pattern to base Prisma Compose on

**Write a query → bind it → keep it live**.

That is the foundational shift away from:

- request/response endpoints tailored per view
- “refetch then rerender” as the default correctness strategy

## What we want to emulate directly

- **Query-driven sync as a first-class contract**
  - Especially for large datasets and interactive UIs.
- **Optimistic-first user experience**
  - “Network off the interaction path” as a design goal.
- **A small, stable ubiquitous language**
  - Users should spend their time in a handful of concepts (collections, live queries, mutations, sync modes).

## What we likely need to adapt for Prisma Compose

- **Collections backed by durable primitives**
  - In Prisma Compose, the “collection” concept probably maps to:
    - durable streams as fact logs
    - materializers maintaining views
    - user-facing “collection” APIs as the ergonomic boundary
- **Live query maintenance location**
  - Decide what belongs in:
    - platform runtime primitives
    - optional higher-level libraries
    - client tooling vs server-side materialization

## Near-term design questions this raises

- What subset of “query language” do we standardize for:
  - predicate → subset-load mapping
  - joins across collections
  - ordering/pagination
- How do we expose sync modes at the platform boundary (manifest/artifacts)?
- How do optimistic transactions map to durable commands/facts in our streams model?


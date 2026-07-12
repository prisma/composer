# TanStack (research library)

This directory captures **stable research notes** about TanStack DB’s domain model and user-facing interaction patterns.

The intent is to keep “how TanStack works” relatively static here, while keeping “what Prisma Compose should do because of it” in a separate takeaways doc that we can revise as our own design evolves.

Primary reference: [TanStack DB Overview](https://tanstack.com/db/latest/docs/overview)

## What to read

- `glossary.md`: domain terms and definitions (with user-facing vs internal notes)
- `domain-map.md`: a conceptual relationship map of the domain
- `operations.md`: common operations on domain concepts (CRUD, sync, subscriptions)
- `user-domain.md`: the user’s mental model and how it maps to internal mechanics
- `execution-flows.md`: common execution flows (especially “live query”)
- `takeaways-for-prisma-compose.md`: what we want to emulate/adapt in Prisma Compose (expected to change)


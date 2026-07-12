# Convex (research library)

This directory captures **stable research notes** about Convex's domain model and developer-facing interaction patterns for its realtime backend.

The intent is to keep "how Convex works" relatively static here, while keeping "what Prisma Compose should do because of it" in a separate takeaways doc that we can revise as our own design evolves.

Primary reference: [Convex Developer Hub](https://docs.convex.dev)

## What to read

- `glossary.md`: domain terms and definitions (with user-facing vs internal notes)
- `domain-map.md`: a conceptual relationship map of the domain
- `operations.md`: common operations on domain concepts (queries, mutations, actions)
- `user-domain.md`: the user's mental model and how it maps to internal mechanics
- `execution-flows.md`: the common loop — define schema/data model, write functions, query/subscribe, update data, see realtime updates
- `takeaways-for-prisma-compose.md`: what we want to emulate/adapt in Prisma Compose (expected to change)

# Cloudflare platform (research library)

This directory captures **stable research notes** about Cloudflare Workers and platform primitives from a domain-modeling perspective: Workers, bindings, control-plane tooling (Wrangler), and the split between author-time and runtime.

The intent is to keep "how Cloudflare works" relatively static here, while keeping "what Prisma Compose should do because of it" in a separate takeaways doc that we can revise as our own design evolves.

Primary references: [Cloudflare Workers Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/), [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)

## What to read

- `glossary.md`: domain terms and definitions (with user-facing vs internal notes)
- `domain-map.md`: a conceptual relationship map of the domain
- `operations.md`: common operations on domain concepts (deploy, bind, route, etc.)
- `user-domain.md`: the user's mental model and how it maps to internal mechanics
- `execution-flows.md`: day-to-day flows (dev, deploy, request handling, binding resources)
- `takeaways-for-prisma-compose.md`: what we want to emulate/adapt in Prisma Compose (expected to change)


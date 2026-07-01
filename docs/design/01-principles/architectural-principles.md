# Architectural Principles

Structural rules that shape MakerKit's architecture and package boundaries.

## No globals — all dependencies are injected

Application code never reads global configuration or looks up a service by name —
no `process.env`, no discovery, no magic. Every resource a Hex uses is handed to it
as a typed dependency.

## Code over configuration

Your topology is *inferred* from your application code — type-checked, and living in
your TypeScript, not a separate manifest you maintain by hand. The structure you
write is the structure that deploys; the two can't silently drift.

## Tree-shakeable by default

Control-plane code (inferring, emitting, provisioning) and execution-plane code
(running your app) live behind separate imports, so build-time machinery never
lands in your application bundle. You ship only what runs.

## The framework has no knowledge of specific deployment targets

The core deals only in the abstract model — Hexes, inputs, outputs, resources — and
never branches on where you're deploying. Everything a given target needs (Prisma
Cloud's resource types, or another's) arrives as an extension pack.

## Data contracts are the interface for data resources

A data contract names exactly what a Hex may read and write; a resource plugs in
only if it satisfies that contract. It's the data-world version of an Alchemy
Layer: the consumer depends on a typed interface (`Context.Service`), and any
implementation that satisfies it can be swapped in.

## Realtime/streaming-first

Streaming and subscription are first-class in the runtime from day one, not bolted
onto a request/response model after the fact. We build for the hard case — async,
durable, ordered delivery — so the synchronous case falls out for free, not the
reverse.

# Guiding Principles

Long-lived product constraints that shape most decisions.

## Compose, don't special-case

Sophisticated behavior is built by composing a few simple, generic primitives —
never by baking special-case types into the core. There is no built-in "Prisma
Postgres" type: a generic **data** resource composed with a **data contract** *is*
a Prisma Postgres resource satisfying that contract. Keep the primitives few and
general; let composition produce the richness.

## Don't reinvent the wheel

Where an established solution exists in the ecosystem — Alchemy for provisioning,
Prisma Next for data contracts, Prisma Cloud for hosting — use it rather than
building our own. MakerKit builds only the composition layer that's genuinely
missing.

## Thin core, fat targets

Keep the core small and stable — the Hex/Input/Output model, the topology, the
lowering machinery. Target specifics (resource types, providers) live in extension
packs and are swappable without touching the core.

## Agnostic of deployment targets

The core knows nothing about any specific deployment target. The framework provides
the affordances — Hex, Inputs/Outputs, Resource, the lowering SPI — and a target's
specifics (Prisma Cloud's resource types, or another cloud's) come *only* from an
extension pack. The framework never branches on target identity.

## Agent-first

A required property, like mobile-first for a website. Agents need deterministic,
machine-readable, statically analyzable surfaces and tight feedback loops, so
MakerKit keeps the topology explicit, inspectable, and queryable. Humans get the
same.

## Realtime/async-first

Design for the hard case — asynchronous, durable, message-driven flow — from day
one (durability, ordering, backpressure, partial failure), so realtime is native
rather than retrofitted. Request/response is the synchronous special case; both
transports are first-class.

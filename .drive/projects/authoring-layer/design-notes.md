# Authoring Layer — Design Notes

The design is settled and recorded in the canonical docs — this file does not restate
it, it points to it and records the build-decision history.

## Canonical design (source of truth)

- [`docs/design/10-domains/core-model.md`](../../../docs/design/10-domains/core-model.md)
  — **the build contract**: all types, the six package entries with dependency
  weights, the target-pack contract, the worked prisma-cloud pack, the five enforced
  invariants, extension points.
- [`core-and-targets.md`](../../../docs/design/03-domain-model/core-and-targets.md) —
  thin core / target-pack split; lowering is routing; runtime is a dumb loop.
- [`authoring-surface.md`](../../../docs/design/03-domain-model/authoring-surface.md)
  — the developer-facing narrative (ports, direction-from-position, Load/Hydrate).
- [`architectural-principles.md`](../../../docs/design/01-principles/architectural-principles.md)
  — no-globals, **runtime-agnostic**, no-target-knowledge, wiring-precedes-execution.

## Decision history (chronological)

1. **Descriptors are pure tagged data; hydration is keyed separately** (first build).
   Survives, refined: nodes carry a `type` routing key; the pack's runtime resolves it.
2. **MakerKit does not bundle** (operator correction). Core's `/build` entry was a
   principle violation; the app owns bundling and the artifact envelope.
3. **Core is target-agnostic; lowering is routing** (operator correction). Core's
   `lower()` importing prisma-alchemy was a principle violation; the vocabulary
   (`compute`, `postgres`) moved to a target pack that carries routing metadata.
   KISS shape set by the operator: the pack provides `postgres()` and `compute()`.
4. **Alchemy stays in core** (`@makerkit/core/lower` imports it): it is the
   target-neutral provisioning engine per layering.md claim 3, not a deployment target.
5. **Runtime-agnostic** (operator principle): no Bun/Node coupling in any shipped
   entry, even type-only. The DB client factory is app-supplied
   (`runtime({ clients })`); `postgres<C>()` lets the app declare its client type.

## Superseded

The first slice-1 build (PR #6 code: core-owned `lower()` → prisma-alchemy, `/build`
bundler, pack-fixed `Bun.SQL` client) — superseded by decisions 2, 3, 5. Its
graph/Load mechanics, no-globals shim boundary, and test discipline (import-split
guard, side-effect-free-import test) carry forward into the rebuild.

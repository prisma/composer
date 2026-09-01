# Compact OrmMigration state — Plan

**Spec:** `projects/compact-orm-migration-state/spec.md`  
**Linear Project:** N/A — operator explicitly waived Linear tracking for this project.

## At a glance

This is a single-slice project. One coherent change moves the deploy-time contract out of persisted `OrmMigration` props, reloads and attests it at reconciliation, proves large contracts no longer enlarge state, and updates the governing design documentation.

## Composition

### Stack (deliver in order)

1. **Slice `compact-migration-resource-state`** — Linear: N/A
   - **Outcome:** `PrismaOrm.Migration` remains a tracked Alchemy Resource while newly persisted state is independent of contract size; reconciliation deterministically loads the config-declared contract, verifies its identity, and runs the unchanged replay-only migration path.
   - **Builds on:** The settled project spec and existing `OrmMigration`, ORM config-loading, and migration-control surfaces.
   - **Hands to:** A deployable, documented Resource shape that supports contracts larger than 100 KB without sending the full contract to Alchemy state.
   - **Focus:** Compact Resource props; deterministic contract loading through `prisma.config.ts`; declared-vs-loaded contract attestation; preservation of target-ref, invariant, extension-pack, local/hosted, and replay-only semantics; focused large-contract persistence coverage; ADR-0022 and affected domain-document updates. Generic transient props, Action conversion, API-limit changes, and proactive legacy-state compaction remain out of scope.

## Dependencies (external)

- [x] Prisma ORM exposes supported config and contract-loading surfaces — available in the pinned ORM toolchain.
- [x] Alchemy persists Resource props and requires no engine change when the full contract is removed from those props.

## Sequencing rationale

No multi-slice sequencing is warranted. The Resource-shape change, provider loading path, attestation, tests, and documentation form one reviewable invariant: the contract remains available to migration execution but never becomes newly persisted Alchemy state. Splitting these would create an intermediate state that either cannot reconcile or can migrate with an unattested contract, violating the project's transitional-shape constraint.

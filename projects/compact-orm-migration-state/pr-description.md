# Compact ORM migration state

## PR body

Allows Prisma ORM contracts larger than the Management API's 100 KB Alchemy-state write limit by keeping the full contract out of persisted migration Resource props.

## Changes

- **Migration state:** Replace persisted `contractJson` with compact current-contract identity, kept distinct from migration target refs.
- **Contract reconciliation:** Load the emitted contract through the artifact path normalized by `prisma.config.ts`, attest it before database access, then enter the existing replay-only migration path.
- **Coverage:** Prove contracts larger than 100 KB do not enlarge persisted migration props, and verify unreadable or mismatched artifacts fail before database work.
- **Documentation:** Align ADR-0022, local-development guidance, the app-building guide, and core-concepts material with the config-loaded-contract/compact-state boundary.

## Why

Alchemy persists every Resource input prop, so carrying the complete contract made deployability depend on contract size. Keeping only compact identity in state removes that coupling while preserving `OrmMigration` as a dependency-aware Resource and retaining target-ref, invariant, extension-pack, marker, retry, and replay-only semantics.

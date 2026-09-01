# Slice: Compact migration resource state

_(Parent project: `projects/compact-orm-migration-state/`. This slice makes ORM contract size independent of newly persisted Alchemy state.)_

## At a glance

Change `PrismaOrm.Migration` so its persisted props carry compact contract identity rather than the complete emitted contract. Reconciliation reloads the config-declared contract, attests it against the database resource's declaration, and then enters the unchanged replay-only migration path.

## Chosen design

`OrmMigrationProps` no longer contains `contractJson`. It carries a compact attestation of the current declared contract alongside the existing target-ref identity, invariants, extension-pack identities, paths, and resolved database URL.

The Postgres descriptor continues to read the declared `dataContract` while lowering. It derives the compact attestation and target ref there, then creates `OrmMigration` without embedding the contract.

During reconciliation, the provider uses Prisma ORM's supported config and contract-loading surfaces to load the contract output identified by `prisma.config.ts`. Before opening or mutating the database, it compares the loaded contract's storage identity with the persisted declaration attestation. A mismatch or unreadable artifact fails the deploy explicitly. A successful check supplies the loaded full contract to the existing `applyOrmMigration` function; migration planning and execution remain unchanged.

The current contract attestation is distinct from `targetHash`: a named target ref may intentionally select an older migration destination while the config still identifies the current emitted contract artifact.

## Coherence rationale

The Resource shape, deterministic reload path, attestation, large-contract proof, and governing documentation are one invariant and one rollback unit: the migration receives the right full contract without persisting it. Splitting them would temporarily leave reconciliation unable to run or able to use an unattested artifact.

## Scope

**In:** `OrmMigration` props and provider reconciliation; ORM config resolution required to load the emitted contract; Postgres descriptor wiring; focused lowering/provider/persistence tests including a contract larger than 100 KB; compatibility with prior persisted props during ordinary convergence; ADR-0022 and directly affected domain documentation.

**Out:** Generic transient Resource props; Alchemy Action conversion; Management API limits; proactive legacy-state compaction; changes to migration graph planning, marker semantics, target refs, invariants, extension-pack execution, retries, or local/hosted provider selection.

## Pre-investigated edge cases

| Edge case | Disposition | Notes |
| --------- | ----------- | ----- |
| Emitted contract exceeds 100 KB | Cover with focused persistence proof | The full value must not appear under any equivalent persisted prop. |
| Named target ref points behind the current contract head | Keep current-contract attestation separate from `targetHash` | Selecting an older authored destination remains valid. |
| Config-loaded contract differs from the declared `dataContract` | Fail before migration or database mutation | Never silently choose either source. |
| Existing state contains legacy `contractJson` props | Tolerate through ordinary convergence | No proactive rewrite or cleanup is required. |

## Slice-specific done conditions

- [ ] A focused persistence test with a contract larger than 100 KB proves newly persisted `PrismaOrm.Migration` state contains no full-contract value.
- [ ] Contract mismatch and unreadable-contract failures occur before migration execution.
- [ ] ADR-0022 and directly affected domain documentation describe the compact-state/config-loaded contract boundary.

## Open Questions

None.

## References

- Parent project: `projects/compact-orm-migration-state/spec.md`
- Linear issue: N/A — operator waived Linear tracking.
- `docs/design/90-decisions/ADR-0022-data-deps-carry-a-prisma-orm-contract.md`
- `docs/design/90-decisions/ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md`
- `docs/design/90-decisions/ADR-0045-deploy-state-lives-behind-the-platform-state-api.md`
- `packages/1-prisma-cloud/1-extensions/target/src/orm-migration-resource.ts`
- `packages/1-prisma-cloud/1-extensions/target/src/descriptors/orm-postgres.ts`
- `packages/1-prisma-cloud/1-extensions/target/src/orm-config.ts`
- `packages/1-prisma-cloud/1-extensions/target/src/orm-migrate.ts`

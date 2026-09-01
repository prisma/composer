# Compact OrmMigration state

## Purpose

Allow Composer to deploy Prisma ORM contracts larger than the Management API's 100 KB Alchemy-state write limit. The size of an application's contract must not determine whether Composer can persist deployment state.

## At a glance

Today `PrismaOrm.Migration` carries the full emitted `contractJson` as an Alchemy Resource prop. Alchemy persists every prop, so a sufficiently large contract makes the state write fail even though the migration result itself is only a compact schema identity.

After this project, the migration remains a tracked Alchemy Resource, but its persisted state contains only compact identity and location data. At reconcile time, Composer deterministically loads the deploy-time contract artifact identified by `prisma.config.ts`, verifies that it matches the contract declared by the database resource, and hands the loaded contract to Prisma ORM's replay-only migration engine. Contract size therefore affects local migration processing, not hosted-state payload size.

## Non-goals

- Raising or changing the Management API's 100 KB state-write limit.
- Introducing a generic Alchemy facility for non-persisted or transient Resource props.
- Converting `OrmMigration` from a Resource to an Alchemy Action.
- Proactively compacting existing `PrismaOrm.Migration` state rows; old rows may remain in their existing shape until ordinary convergence rewrites them.
- Changing migration planning, target-ref, invariant, extension-pack, replay-only, retry, or database-marker semantics.
- Recovering state rows that a platform-side response limit prevents the client from reading.

## Place in the larger world

- `OrmMigration` is a Composer-owned Alchemy Resource in the Prisma Cloud target extension. It remains the tracked, dependency-aware deploy step established by ADR-0022 and shared unchanged by hosted deploy and local development under ADR-0041.
- Alchemy's stock state client persists Resource input props through the Management API route established by ADR-0045. Alchemy has no per-prop opt-out, so the contract must cease to be a Resource prop rather than merely be ignored by provider diffing.
- Prisma ORM remains the contract and migration authority. Composer uses Prisma ORM's stock config and contract-loading surfaces; it does not infer filenames or reconstruct contracts.
- The database resource's declared `dataContract` remains the runtime and wiring contract. The contract output identified by `prisma.config.ts` becomes the deploy-time artifact consumed by migration reconciliation, with an explicit identity check connecting the two.

## Cross-cutting requirements

- No full contract value may appear in the persisted inputs of a newly converged `PrismaOrm.Migration` resource; persisted state size must be independent of contract size.
- Migration reconciliation must load the contract through the path and output semantics declared by `prisma.config.ts`, using Prisma ORM's supported loaders rather than filename or directory guessing.
- The Resource must persist a compact attestation for the declared contract and fail before migration if the loaded deploy-time artifact does not match it. A named migration target may point to an older ref, so the current contract attestation and target-ref hash remain distinct concepts.
- The existing target identity remains complete: target hash, sorted invariants, and sorted extension-pack head hashes must continue to trigger the same migration decisions as before.
- Hosted deployment and local development must continue to use the same `OrmMigration` Resource and provider behavior.
- Deploy remains replay-only: the loaded contract supplies Prisma ORM's destination-contract context but never authorizes Composer to synthesize schema operations.
- The change must preserve the architectural rule that the framework does not bundle, transform, discover, or guess application artifacts.

## Transitional-shape constraints

- Existing persisted rows require no proactive migration. During rollout, Composer must tolerate prior rows containing `contractJson`; normal convergence may replace them with the compact shape.
- Every intermediate state must either use the existing contract prop safely or use the new attested config-loading path; no intermediate state may migrate using an unverified contract artifact.

## Project Definition of Done

- [ ] Team-DoD floor items are inherited from the repository's canonical team-DoD when present.
- [ ] A focused persistence test uses an emitted contract larger than 100 KB and proves newly persisted `PrismaOrm.Migration` state contains no `contractJson` or equivalent full-contract value.
- [ ] `OrmMigration` reconciliation loads the contract identified by `prisma.config.ts` and successfully supplies it to the unchanged Prisma ORM migration path.
- [ ] A mismatch between the database resource's declared contract attestation and the config-loaded contract fails before any migration operation runs.
- [ ] Existing target-ref, invariant, extension-pack, hosted-deploy, and local-development behavior remains covered and passing.
- [ ] ADR-0022 and affected domain documentation distinguish the deliberately carried deploy-time contract from the compact state persisted for the migration Resource.

## Open Questions

None.

## References

- `docs/design/90-decisions/ADR-0022-data-deps-carry-a-prisma-orm-contract.md`
- `docs/design/90-decisions/ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md`
- `docs/design/90-decisions/ADR-0045-deploy-state-lives-behind-the-platform-state-api.md`
- `packages/1-prisma-cloud/1-extensions/target/src/orm-migration-resource.ts`
- `packages/1-prisma-cloud/1-extensions/target/src/descriptors/orm-postgres.ts`
- `packages/1-prisma-cloud/1-extensions/target/src/orm-config.ts`
- `packages/1-prisma-cloud/1-extensions/target/src/orm-migrate.ts`

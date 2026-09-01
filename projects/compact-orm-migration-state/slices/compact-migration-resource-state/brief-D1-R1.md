# Brief: Compact and attest OrmMigration state

## Task

Keep `PrismaOrm.Migration` as a tracked Alchemy Resource while removing the full emitted contract from persisted Resource props. Make reconciliation deterministically load the contract output identified by `prisma.config.ts`, attest it against the contract declared by the database resource before migration begins, then pass it into the unchanged replay-only migration path. Prove newly persisted migration state remains compact for a contract larger than 100 KB and align ADR-0022 plus directly affected domain documentation.

## Scope

**In:** `packages/1-prisma-cloud/1-extensions/target` migration-resource, ORM-config, descriptor, and directly related test surfaces; focused state-shape/persistence proof; ADR-0022 and directly affected domain docs; compatibility with ordinary convergence from prior rows; committing the already-authored `projects/compact-orm-migration-state/` artifacts without modifying their intent.

**Out:** Generic transient Resource props; converting the migration to an Action; Management API changes; proactive legacy-state compaction; migration graph, marker, target-ref, invariant, extension-pack, retry, or local/hosted semantic changes; unrelated cleanup.

## Completed when

- [ ] `OrmMigration` persisted props contain compact contract attestation but no `contractJson` or equivalent full-contract value, with current-contract attestation distinct from `targetHash` for named refs.
- [ ] Reconciliation loads the config-declared emitted contract via Prisma ORM-supported APIs and rejects missing/unreadable or identity-mismatched artifacts before opening or mutating the database.
- [ ] Focused tests include a contract larger than 100 KB and prove the newly persisted migration state is independent of that contract's size while existing migration behavior remains covered.
- [ ] ADR-0022 and directly affected domain documentation distinguish deploy-time contract loading from compact persisted migration state.
- [ ] Canonical targeted tests, target-package typecheck/build checks, and lint for changed files pass; report the exact commands selected from repository conventions.

## Standing instruction

Stay focused on the goal; control scope. Trivial-and-related fixes that obviously serve the goal go in the same dispatch with a one-line note in your wrap-up message. Anything that pulls you off the goal—even if useful—halts and surfaces.

## References

- Slice spec: `projects/compact-orm-migration-state/slices/compact-migration-resource-state/spec.md`
- Slice plan: `projects/compact-orm-migration-state/slices/compact-migration-resource-state/plan.md`
- Project spec: `projects/compact-orm-migration-state/spec.md`
- Project plan: `projects/compact-orm-migration-state/plan.md`
- Code review log: `projects/compact-orm-migration-state/reviews/code-review.md` (read-only)
- Governing principles: `docs/design/01-principles/`
- Governing decisions: ADR-0022, ADR-0041, ADR-0045

## Operational metadata

- **Model tier:** mid — cross-cutting Resource-state and ORM-loader change with tests and design docs.
- **Time-box:** 90 minutes. Overrun means halt and surface.
- **Halt conditions:** Prisma ORM has no supported way to load the config-declared emitted contract; satisfying the task requires filename guessing or an in-memory/global side channel; config and declared contract cannot be attested without changing public authoring semantics; an out-of-scope surface must change; validation cannot be made green in scope.

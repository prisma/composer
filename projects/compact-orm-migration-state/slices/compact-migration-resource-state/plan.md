# Compact migration resource state — Dispatch plan

## Dispatch 1: Compact and attest OrmMigration state

- **Outcome:** Newly converged `PrismaOrm.Migration` resources persist no full contract, while reconciliation deterministically reloads and attests the config-declared contract before invoking the unchanged migration engine; focused tests prove the behavior with a contract larger than 100 KB and documentation records the boundary.
- **Builds on:** The slice spec's chosen design and the existing `OrmMigration`, ORM config-resolution, Postgres descriptor, and replay-only migration surfaces.
- **Hands to:** A reviewed, deployable Composer change whose Alchemy state size is independent of ORM contract size, with mismatch failures occurring before migration and the design documented durably.
- **Focus:** Remove `contractJson` from persisted migration props; add compact current-contract attestation distinct from target ref; use Prisma ORM-supported config/contract loading; preserve existing migration semantics and local/hosted parity; add focused lowering, provider, and persistence coverage; update ADR-0022 and directly affected domain docs. Do not introduce generic transient props, convert to Action, modify the Management API, or proactively compact legacy rows.
- **Validation gate:** Run the directly affected target-extension test files, including the focused large-contract persistence and mismatch tests; run the target package's typecheck/build gate; run repository lint for changed files. The implementer must identify and report the repository's canonical concrete commands during reconnaissance, then run the complete selected gate once at dispatch completion.

# Project plan — Prisma Next data contract

## Summary

Two slices in a stack. Slice 1 lands the ADR and the typed primitive with its
runtime behavior proven against a real local Postgres; slice 2 lands the
deploy-time migration step and proves the whole path live on Prisma Cloud via
an example conversion.

**Spec:** `.drive/projects/prisma-next-data-contract/spec.md`

## Slices

### Slice 1: typed primitive (`typed-primitive`)

**Outcome:** `pnPostgres` (name settled by then) exists in
`@prisma/app-cloud/prisma-next`: resource end takes `{ name, config }` from a
`prisma-next.config.ts` import; dep end resolves to a
`PostgresClient<Contract>` built in hydrate with warn-only marker
verification; compile-time assignability is exact on `storageHash` and
`satisfies()` mirrors it. ADR-0022 ships in this PR.

**Slice DoD:** unit tests for contract assignability/`satisfies`; integration
test against a real local Postgres (existing harness) proving the typed
client round-trips and a mismatched marker warns without throwing; bare
`postgres()` suite untouched; subpath entry verified not to load
`@prisma-next/*` from the index import.

**Builds on:** —
**Hands to:** stable primitive + `Contract` type flow + ADR merged, for the
lowering to target.

**Linear:** [TML-3009](https://linear.app/prisma-company/issue/TML-3009/slice-1-typed-pnpostgres-primitive-adr-0021)

### Slice 2: deploy migrate lowering (`deploy-migrate-lowering`)

**Outcome:** the app-cloud control extension lowers a PN-postgres resource to
DB provisioning plus a migration step: read marker → authored `migrate` to
the contract hash → hard fail on no-path/destructive/runner error, no-op when
hashes match. An example app (storefront-auth converted, or a sibling
example) authors a contract + migration and deploys live; CI E2E covers
deploy, migrated redeploy, and no-op redeploy.

**Slice DoD:** live Prisma Cloud round trip through the typed client;
no-path deploy failure test leaves DB untouched; at least one CI example
still exercises bare `postgres()`.

**Builds on:** Slice 1.
**Hands to:** project DoD; the datahub port consumes the shipped primitive.

**Linear:** _pending green light_

## Sequencing

Stack: 1 → 2. No parallel groups — slice 2 consumes slice 1's primitive.

## Close-out (required)

- [ ] Verify all acceptance criteria in `spec.md`
- [ ] Migrate long-lived docs into `docs/` (ADR-0022 already lands in slice 1;
      migrate the deferred multi-contract design from design-notes into
      docs/design if not already captured in the ADR)
- [ ] Strip repo-wide references to `.drive/projects/prisma-next-data-contract/**`
- [ ] Delete `.drive/projects/prisma-next-data-contract/`

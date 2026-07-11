# Project spec — Prisma Next data contract

## Purpose

Give app authors a typed, migration-verified data boundary: a data dependency
that carries a Prisma Next contract, so the injected client is typed to the
schema and every deploy converges the database to the contract's hash or
fails. This delivers the promise already written into the framework's design
("data contracts are Prisma Next" — README, glossary) that the code has never
implemented.

## At a glance

- A second data primitive (`pnPostgres`, name TBD) alongside bare
  `postgres()`: resource end takes the app's `prisma-next.config.ts` and
  contract; dep end resolves to a Prisma Next client typed by that contract.
- Compile-time exactness via the contract's branded `storageHash`; Load-time
  `satisfies()` mirrors it.
- Deploy lowering gains a migration step: read the DB's marker, `migrate`
  along the authored graph to the target hash, hard-fail if no path.
- Proven live on an example app deployed to Prisma Cloud.

## Non-goals

- **Multi-contract / contract-space slices.** v1 is one contract per
  database; every consumer sees the full contract. The slice/aggregate design
  is recorded in design-notes as the extension path.
- **Least-privilege data access.** Follows from the above; not in v1.
- **Dev-time apply/emulation.** Parked pending `prisma dev` serving the
  management API locally (Alchemy then gets a second target for free).
- **Changing or deprecating bare `postgres()`.** It remains the untyped
  escape hatch, unchanged.
- **State-store adoption of Prisma Next.** ADR-0012's deferral stands.
- **The Prisma Next → Prisma Data rename.** Naming churn is acknowledged, not
  handled here.
- **Folding `@prisma/app-rpc` into app-cloud.** Operator floated it; separate
  mechanical move.

## Place in the larger world

- Fulfils the README/glossary Data Contract promise and amends ADR-0015:
  Prisma Next becomes a framework-blessed protocol (like rpc), so this dep
  kind's binding is a typed client, not `{ url }`.
- Direct consumer: the forcing-function apps stream (datahub port), which
  needs real typed persistence.
- Depends on published `@prisma-next/*` (0.14.0 on npm): `/contract-builder`,
  `/runtime`, `/control`, `/config` entry points.

## Cross-cutting requirements

- **Opt-out is real at runtime.** The primitive ships in `@prisma/app-cloud`
  behind a dedicated subpath entry, never re-exported from the index; a
  service that doesn't import it never loads `@prisma-next/*`/`pg`.
- **Schema checking is build/deploy-time, not runtime.** The runtime binding
  does no schema verification — it just builds the client — so a running
  service can never be crashed by a marker check. The authoritative check is
  the deploy.
- **Consume the contract; locate the config.** The app build imports only the
  emitted contract (`contract.json` + `contract.d.ts`), never
  `prisma-next.config.ts` (which would pull PN's CLI/migration machinery into
  the bundle). The config reaches the deploy lowering as a **path string**.
- **Deploys never synthesize schema changes.** Authored `migrate` only;
  `acceptDataLoss` off; no-path and destructive plans are hard deploy
  failures that leave marker and DB unchanged.
- **No-globals holds.** The framework injects the connection URL at hydrate.

## Transitional-shape constraints

- Additive only: no change to the existing `postgres()` contract, `Contract`
  machinery, or `control.ts` behavior for bare-postgres resources at any
  intermediate state.
- At least one CI example keeps exercising bare `postgres()` end-to-end after
  the example conversion, so the untyped path stays covered.

## Project DoD

- [ ] An example app declaring a Prisma Next contract deploys to Prisma Cloud
      and serves a request that round-trips through the typed client.
- [ ] A contract change with an authored migration deploys and migrates the
      live DB; an unchanged redeploy is a no-op (CI no-op-redeploy check
      extended to cover the marker comparison).
- [ ] A deploy targeting a hash with no authored path fails with a typed
      error and leaves the database untouched (test-verified).
- [ ] A service running against a DB with a mismatched marker logs a warning
      and still serves (test-verified).
- [ ] Bare-`postgres()` examples and tests are untouched and green.
- [ ] ADR-0022 accepted and merged; design-notes' deferred-extension content
      preserved there or in docs/design.

## Open questions

- Factory name (`pnPostgres` placeholder; Prisma Data rename incoming).
- `@prisma-next/*` version pinning strategy given 0.x churn.
- Whether PN's `verifyMarker` option natively supports warn-only, or the
  hydrate wraps it. (Resolve in slice 1 against the real API.)

## References

- `.drive/projects/prisma-next-data-contract/design-notes.md`
- `docs/design/90-decisions/ADR-0022-*.md` (draft)
- `docs/design/90-decisions/ADR-0013…0015`, `docs/design/03-domain-model/glossary.md` §Contracts
- `packages/app-cloud/src/{postgres,control}.ts`

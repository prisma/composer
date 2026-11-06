# U2 — dispatch plan

Prerequisites: platform slice 3 (prisma/pdp-control-plane#5924, merged 2026-11-06) deployed to production; alchemy-run/alchemy#2701 updated for domain ownership statuses and merged; live Prisma credentials for Alchemy's integration tests confirmed.

## D1. Regenerate the Distilled Prisma client

- **Outcome:** `@distilled.cloud/prisma` has the RoutingUrl operations (create, list, read, update, delete, find by Branch and `logicalId`) and the domain ownership `status` and `expiresAt` fields, from the deployed spec.
- **Builds on:** nothing.
- **Hands to:** D2.
- **Validation:** the package's own generate, typecheck and test scripts. Never run `pnpm install` inside the `distilled/` submodule.

## D2. `Prisma.RoutingUrl`

- **Outcome:** the resource and its tests, as [spec.md](spec.md) describes.
- **Builds on:** D1 merged and pinned in Alchemy.
- **Hands to:** release; then P2.
- **Validation** (from the Alchemy repo root):
  - `pnpm test:integration test/Prisma` with fakes, plus the live RoutingUrl test file alone
  - `pnpm exec tsrs -b`
  - `pnpm exec oxfmt --check` and `pnpm exec oxlint` over the touched files
  - `pnpm docs:check-jsdoc` and `pnpm docs:gen`, committing regenerated Prisma pages

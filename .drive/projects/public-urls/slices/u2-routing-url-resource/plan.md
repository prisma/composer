# U2 — dispatch plan

Prerequisites: platform slice 3 (prisma/pdp-control-plane#5924, merged 2026-11-06) deployed to production (done: `/v1/urls/{id}` is in the live spec on 2026-11-06); live Prisma credentials for Alchemy's integration tests confirmed before D3's live test.

Sam Goodwin's alchemy-run/alchemy#2701 and its base #2698 are replaced by D2 (Will, 2026-11-06). Sam is asked to close both once D2's pull request is open.

## D1. Regenerate the Distilled Prisma client

- **Outcome:** `@distilled.cloud/prisma` regenerated from the live spec: the RoutingUrl operations (create, list, read, update, delete, check, find by Branch and `logicalId`) and the domain ownership `status` and `expiresAt` fields. One pull request on alchemy-run/distilled, like alchemy-run/distilled#1007.
- **Builds on:** nothing.
- **Hands to:** D2, D3.
- **Validation:** the package's own generate, typecheck and test scripts. Never run `pnpm install` inside the `distilled/` submodule.

## D2. `Prisma.DomainOwnership` with statuses (replaces #2698 and #2701)

- **Outcome:** the Prisma parts of #2698 and #2701, on a fresh branch from alchemy-run/alchemy main, with one change: proving waits for status `verified` instead of retrying on a rejected create, because create now returns the domain ownership `unverified`. Attributes carry `status` and `expiresAt`; `verifiedAt` is nullable. None of #2701's unrelated Cloudflare, skills or scripts changes.
- **Builds on:** D1 merged and pinned.
- **Hands to:** D3.
- **Validation:** as D3.

## D3. `Prisma.RoutingUrl`

- **Outcome:** the resource and its tests, as [spec.md](spec.md) describes.
- **Builds on:** D2.
- **Hands to:** release; then P2.
- **Validation** (from the Alchemy repo root):
  - `pnpm test:integration test/Prisma` with fakes, plus the live RoutingUrl test file alone
  - `pnpm exec tsrs -b`
  - `pnpm exec oxfmt --check` and `pnpm exec oxlint` over the touched files
  - `pnpm docs:check-jsdoc` and `pnpm docs:gen`, committing regenerated Prisma pages

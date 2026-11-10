# U2 — dispatch plan

U2 produces exactly two upstream pull requests: one on alchemy-run/distilled and one on alchemy-run/alchemy (Will, 2026-11-10: the Alchemy team must not get more). Steps below are build steps, not pull requests.

**Neither pull request is opened until the platform's full API has shipped**, through platform slice 8 (the `prisma.build` endpoint), so the Alchemy team sees one Distilled and one Alchemy pull request for the whole API (Will, 2026-11-10). Until then the branches are built and kept on the bot forks; the Distilled regeneration is redone once, against the final spec, before opening.

Prerequisites: platform slice 3 (prisma/pdp-control-plane#5924) deployed to production (done 2026-11-06); live Prisma credentials for Alchemy's integration tests confirmed before the live tests.

Sam Goodwin's alchemy-run/alchemy#2701 and its base #2698 are replaced by the Alchemy pull request (Will, 2026-11-06). Sam is asked to close both once it is open.

**Platform request before opening:** distinct error codes for the RoutingUrl create and update refusals. Today a duplicate `logicalId` 409 is `client-error`, and an invalid hostname and a service on another Branch are both `validation-error`; only the quota 409 has its own code (`quota-exceeded`). Proposed: `logical-id-taken`, `invalid-hostname`, `service-on-another-branch`. Then the Distilled pull request types the four errors on `/error/code` (as patch 005 does), and Alchemy uses `catchTags` instead of matching message text (U2 review round 3, finding 1).

## Distilled pull request (branch `feat/prisma-routing-urls`)

- **D1.** The REST protocol fills `T.ResponseCode()` members, and `@distilled.cloud/prisma` is regenerated from the live spec: RoutingUrl operations, domain ownership `status` and `expiresAt`, and `httpStatus` on the two creates. One pull request, though Distilled's rules prefer the runtime change on its own; the description says why.
- No typed RoutingUrl errors: D3 matches the generic `Conflict` and `UnprocessableEntity` errors, so U2 needs no second Distilled pull request.

## Alchemy pull request (branch `feat/prisma-domain-ownership-status`)

- **D2.** `Prisma.DomainOwnership` with statuses, replacing #2698 and #2701. Built and reviewed twice.
- **D3.** `Prisma.RoutingUrl`, as [spec.md](spec.md) describes, on the same branch.
- **Validation** (from the Alchemy repo root):
  - `pnpm test:integration` on the relevant Prisma test files only, with fakes, plus the live RoutingUrl test file alone when credentials exist
  - `pnpm exec tsrs -b`
  - `pnpm exec oxfmt --check` and `pnpm exec oxlint` over the touched files
  - `pnpm docs:check-jsdoc` and `pnpm docs:gen`

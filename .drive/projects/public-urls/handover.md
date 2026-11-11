# Public URLs — handover, 2026-11-11

You take over as the **orchestrator** of the public-URLs project. It spans prisma/composer, prisma/pdp-control-plane (the platform) and Alchemy (alchemy-run/alchemy and alchemy-run/distilled). The orchestrator facilitates design with Will, keeps the project documents right, and directs implementer and reviewer agents. It does not write production code itself.

**Previous transcript** (read it for full context; it is long, so search it rather than reading it whole): `/Users/wmadden/.claude/projects/-Users-wmadden-Projects-prisma-composer--claude-worktrees-public-urls-orchestrator-335947/72dd8b44-f895-4659-b6ce-d37a0a7c9710.jsonl`. An earlier transcript was summarized into it.

## Start here

1. Check out branch `docs/public-urls-plan-current` from prisma/composer (pushed through the `bot` remote, `git@github-wmadden-electric:prisma/composer.git`). It holds every project document change since prisma/composer#416. It is not merged and is not a pull request: it rides along in the next real Composer pull request (P2 below), because Will doesn't want a PR for doc-only changes.
2. Read, in this order:
   - `docs/design/01-principles/` and the ADRs the plan names (ADR-0057 node address, ADR-0059 to ADR-0062 public URLs).
   - `.drive/projects/public-urls/spec.md`, `plan.md`, `design-notes.md` (notes 7 and 12 matter most now).
   - `.drive/projects/public-urls/design/` (the platform design copied from pdp-control-plane, and Composer's side).
   - `.drive/projects/public-urls/slices/u2-routing-url-resource/`: `spec.md`, `plan.md`, `reviews/`, `pr-bodies/`.
3. Platform documents (read from `origin/main` of prisma/pdp-control-plane): `docs/compute/RoutingUrls.md`, `docs/architecture/adrs/ADR-015-routing-urls-and-domain-ownership.md`, `projects/routing-urls/plans/plan.md`.

## The goal

`publicUrl({ id, url, target })` in Composer gives a service a hostname per environment. Today a named hostname lowers to Alchemy's `Prisma.CustomDomain`, so the deploy fails until the user has published both the ownership TXT record and the CNAME to Prisma's switchboard. The goal: a deploy that declares a hostname nobody has set up yet succeeds, prints the records to publish, and the hostname starts serving on its own once they exist. A deploy never takes a serving hostname out of service by accident (design note 12).

## The platform model (shipped)

- **RoutingUrl:** a hostname row on a service, `pending` or `active`, with six conditions, the records still to publish, and a `logicalId` a deploy tool finds it by. Routes: `POST/GET /v1/services/{id}/urls`, `GET/PATCH/DELETE /v1/urls/{id}`, `POST /v1/urls/{id}/check`, `GET /v1/projects/{id}/branches/{id}/urls?logicalId=`. Shipped in prisma/pdp-control-plane#5924 (platform slice 3), in production since 2026-11-06.
- **DomainOwnership:** a workspace's claim to a domain (exact or `*.` wildcard), status `unverified`, `verified` or `expiring` (30 days, then `unverified`), nullable `expiresAt`. Create always succeeds and returns the row, `unverified` until DNS lookup finds the TXT record.
- **Settled 2026-11-06 (Will):** RoutingUrl create and update take `createDomainOwnership`, default `true`, and create the exact-hostname domain ownership for any caller, project tokens included. Composer leaves it at `true` and never records or deletes a domain ownership.
- **Agreed with charlemagne-88 on 2026-11-11:** distinct error codes for the RoutingUrl refusals (`logical-id-taken`, `invalid-hostname`, `service-on-another-branch` as a starting point) ship in platform slice 8. Apex hostnames are supported through CNAME flattening, ALIAS or ANAME; `RoutingUrls.md` gets corrected in platform slice 4.
- **Remaining platform slices:** 4 backfill of existing custom domains, emails, daily recheck of `expiring` (next; no PR yet on 2026-11-11), 5 following the live deployment, 6 Console reads RoutingUrls, 7 new Console (Søren), 8 the `prisma.build` endpoint and the error codes, 9 on-call. The platform work is driven by the session **charlemagne-88** (`local_2c83955d-a5d5-4e1d-8887-c0849fdd76a8`). Don't message it unless Will says so.

## Composer increments

- **Done:** C1 and P1 (`publicUrl()` lowering to `Prisma.CustomDomain`, v0.36.0); the rename of `publicUrl()`'s `name` to `id` (prisma/composer#416). The general rename of `name` to `id` on every node is a recorded follow-up in `.drive/deferred.md`.
- **U2, the Alchemy work:** built and reviewed, held unopened (below).
- **P2:** a named hostname lowers to `Prisma.RoutingUrl`; output prints the first unmet condition and every record to publish; switching from `Prisma.CustomDomain` drops the custom domain from Alchemy state without calling its delete. Starts after U2 is released. Not started.
- **P3:** `publicUrl.prismaBuild()` lowers to a RoutingUrl, after platform slice 8.

## U2: where it stands

Two branches on the bot's forks, unopened:

- **Distilled** `wmadden-electric/distilled` branch `feat/prisma-routing-urls` at `6661db7c0`: the REST protocol fills `T.ResponseCode()` members (so Alchemy can tell 201 "created" from 200 "already existed"), and `@distilled.cloud/prisma` regenerated with the RoutingUrl operations, domain ownership statuses and `httpStatus` on two creates. Description: `slices/u2-routing-url-resource/pr-bodies/distilled.md`.
- **Alchemy** `wmadden-electric/alchemy` branch `feat/prisma-domain-ownership-status` at `47fecd7d3`: `Prisma.DomainOwnership` (proved only when `verified`; never deletes on failure; takes over an `unverified` row without `--adopt`, otherwise needs `--adopt`; retries creates only on 429) and `Prisma.RoutingUrl` (found by `logicalId`; adopts a row with no `logicalId` on the same service and hostname; refuses a hostname change on an `active` row unless the new hostname has a verified domain ownership and its CNAME, or flattened apex A/AAAA, points at the switchboard). It replaces Sam Goodwin's alchemy-run/alchemy#2701 and #2698 (still open; Sam paused them at Will's request). Description: `slices/u2-routing-url-resource/pr-bodies/alchemy.md`.
- Three `drive-code-review` rounds; all findings fixed or deliberately deferred (see `reviews/`). 37 Alchemy tests pass. **No live test has run**: no Prisma or Cloudflare test credentials. Don't use `~/.config/prisma-compose/deploy.env` for tests without Will's yes.

**Before opening (after platform slice 8 ships):**
1. Regenerate Distilled against the final spec (`specs:update`, then generate), push.
2. Add a Distilled patch that types the RoutingUrl refusals on `/error/code` (as patch 005 does), and switch Alchemy's `RoutingUrl.ts` from message matching to `catchTags`.
3. Re-pin Alchemy's distilled submodule, run `drive-code-review` on both branches once more (the apex change in `47fecd7d3` hasn't been reviewed), fix.
4. Give Will the two compare links and description files. **The bot token cannot open PRs on alchemy-run repos (403); Will opens them.**
5. Once the Alchemy PR is open, comment on #2701 and #2698 asking Sam to close them (Will approved this).

The local clones used so far (`wip/alchemy`, `wip/distilled`, `wip/pdp-control-plane` in the old worktree) are disposable. Clone fresh into your own worktree's `wip/`.

## Rules Will has set (beyond CLAUDE.md)

- **Exactly one Distilled and one Alchemy pull request for this project, opened only after the full platform API ships.** Never split upstream work into more PRs (see the memory `minimize-upstream-prs`). Will was angry when three were proposed.
- Use Opus for every subagent (`model: "opus"`). Run `drive-code-review` on every slice and again after substantial changes.
- Never open a PR for doc-only changes; never merge without Will's approval; push agent branches only through the `bot` remote; commit with `git commit -s --trailer "Signed-off-by: Will Madden <madden@prisma.io>"`.
- Don't relay or summarize other sessions' notes to Will; don't message other sessions without his say.
- When Will states how something works and a merged doc disagrees, the doc is wrong.
- Brief, plain English. No question UI. No floating task cards.

## Waiting on

Platform slice 4, then slices 5 to 8. Nothing needs Will until slice 8 ships and U2 is ready to open.

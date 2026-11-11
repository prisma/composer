# Handover: Composer install footprint, and the 0.37/0.38 release suite

Written 2026-11-11 by saruman-67 for the next agent. Read this whole file before acting.

## Read first

- My full transcript (very long; search it rather than reading it end to end): `/Users/wmadden/.claude/projects/-Users-wmadden-Projects-prisma-composer--claude-worktrees-alchemy-footprint-composer-707907/7c6a27c2-edd8-42f9-b030-83b56599cf8e.jsonl`
- `.drive/deferred.md`, section "Alchemy footprint — deferred (2026-10-30)".
- The release notes I wrote, which list every breaking change users see: https://github.com/prisma/composer/releases/tag/v0.37.0 and https://github.com/prisma/composer/releases/tag/v0.38.0
- Will's global rules in `~/.claude/CLAUDE.md` and the memory index in `~/.claude/projects/-Users-wmadden-Projects-prisma-composer/memory/MEMORY.md`. Three memories matter most here: "Don't relay side sessions" (never summarise or pass on another session's notes; Will reads them himself), "Version mismatch is unsupported" and "Approved means merge".

## The goal

Make a Composer app install much less. At 0.36.0 a Composer app with `@prisma/composer-prisma-cloud` installed 1.6 GB. The work has three parts:

1. Composer upgrades Alchemy so its providers come in separate packages (done).
2. Remove the 143 MB `@distilled.cloud/aws` that `@alchemy.run/prisma` pulls in only for five S3 bucket operations (upstream, not done).
3. Remove smaller duplications and packaging waste (partly done, rest deferred).

## What is done and released

- **prisma/composer#402** (merged, shipped in 0.37.0): Alchemy 2.0.0-beta.84 and `effect` 4.0.5. A Composer app went from 1.6 GB to 473 MB; `@prisma/composer` plus `@prisma/composer-cli` alone went from 1.4 GB to 112 MB.
- **Composer 0.37.0** released (prisma/composer#422). It also carried the module-input breaking changes (#401, #403, #412, #416, #419), documented in its release notes.
- **0.37.0 broke apps that use a database.** It peered Prisma ORM 8.0.0-rc.20, but the prisma CLI from 8.0.0-rc.30 bundles orm-toolchain rc.22+, which rejects rc.20 contracts. Moving to ORM rc.22 exposed a second problem: ORM rc.22 refused to start when two copies of the ORM are loaded, and Composer's boot wrapper (`main.mjs`, an esbuild bundle of the service module with `@prisma/*` inlined, by design) always loads a second copy. Fixed by:
  - prisma/orm#30961: the `RUNTIME.MULTIPLE_ORM_COPIES` check is removed (Will's decision: drop it for now; restoring a narrower form is Linear TML-3806). Released as ORM 8.0.0-rc.23.
  - prisma/composer#423: Composer moves to ORM rc.23, and adds `pnpm contracts:emit` (`scripts/emit-contracts.mjs`), `pnpm check:contracts-emitted` in CI and `.agents/rules/emitted-contracts.mdc`. This exists because an agent hand-edited an emitted `contract.d.ts`; emitted contracts are never edited by hand.
  - prisma/composer#425: Composer 0.38.0 released. `pnpm bump-minor` now also re-emits contracts (an emitted contract records the auth pack version).
- **Downstream, all released or merged:**
  - prisma CLI 8.0.0-rc.33 (Composer 0.38.0, orm-toolchain rc.23); the prisma CLI now releases itself when ORM or Composer publish (prisma-cli `update-product-versions.yml`).
  - create-prisma 0.14.7 (prisma/create-prisma#140) and 0.14.8 (prisma/create-prisma#141, CI now runs the TanStack Start template under Composer's `prisma dev` on Linux).
  - prisma/web#8769 and #8770: Composer 0.37 docs and ORM rc.23 docs.
  - prisma/pdp-control-plane#5930 (Console setup pins Composer 0.38.0, prisma rc.33, ORM rc.23) and #5932 (Bloom scaffolds with create-prisma 0.14.7).
  - prisma/prisma-examples#8652: the Console's five Compute templates on the new versions, merged into `latest`.
  - prisma/cloud-deploy-action v1.11.0 (#24), and `v1` moved to it: the action passed `--stage`, which prisma rc.30 removed in favour of `--environment`, so every non-default-branch deploy failed. Its CI now runs its exact arguments against real prisma CLIs on every push and every 6 hours.
  - prisma/orm#30987: fixed ORM `main`, which the rc.23 release broke (a detection test), and the rc.21 upgrade recipe wording that invited hand-editing `contract.d.ts`.
- **QA done:** every create-prisma 0.14.7 template run locally under `prisma dev`; the docs' getting-started guide from scratch with and without a database; a fresh create-prisma app deployed to Prisma Cloud; and an app deployed on Composer 0.35.0, upgraded to 0.38.0 and redeployed with its data intact (Alchemy beta 84 reads beta 83's state).

## Current state of Composer `main` (after 0.38.0, unreleased)

`main` is at 0.38.0 plus prisma/composer#404 (Alchemy beta 85 with the programmatic API, `effect` 4.1), #424 and #426 (a breaking change: `prisma deploy` no longer copies secrets from the local environment). The next Composer release must document #426 and the `effect` 4.1 move in its notes, and every downstream pin (prisma CLI, create-prisma, Console setup in pdp-control-plane, prisma-examples templates, cloud-deploy-action tests) must move together. A CLI and an app on different Composer versions is unsupported.

## What is still open

1. **The 143 MB `@distilled.cloud/aws`.** `@alchemy.run/prisma@2.0.0-beta.85` still depends on `@distilled.cloud/aws` 1.0.0-rc.18. The fix was being prepared in a session I started, "Prisma Cloud bucket client for Alchemy" (`local_03dbe085-63ff-4314-aee8-4eb7688a46e6`, deckard-64): alchemy-run/distilled#1036 (a `BucketObjects` client in `@distilled.cloud/prisma`) is **closed without merging** on 2026-11-04, and alchemy-run/alchemy#2942 (drop `@distilled.cloud/aws` from the bucket bindings) is still a **draft**. Find out from that session's transcript or the PR threads why #1036 closed and what the Alchemy maintainers asked for; there was an open question from Mkassabov on #2942. Will's rules for upstream: one Alchemy PR and one Distilled PR per slice (memory "Minimize upstream PRs"); the small hand-written client belongs in Distilled, not a generated full-S3 package. When it ships, bump `alchemy` and `@alchemy.run/prisma` in Composer together (skill `skills-contrib/upgrade-alchemy-effect`); an app should then install about 330 MB.
2. **Two copies of `@prisma/dev` (about 25 MB).** Alchemy beta 85 widens its range to `^0.25.2`, so this should be gone on Composer `main` now that #404 moved to beta 85. Verify with a packed install and update `.drive/deferred.md`.
3. **`@prisma/dev` ships its PGlite files twice (14.5 MB).** A session ("Cut @prisma/dev's footprint in Composer installs", `local_da22b81b-df43-4732-9323-aefd7b919464`, theseus-59) found this and was waiting for Will's choice; it did not finish. `@prisma/dev`'s source is `prisma/team-expansion` at `dev/server/`.
4. **`@prisma/composer-prisma-cloud` packaging (28 MB of source maps, 9 MB `auth/testing` bundle).** Will's view: keep source maps for code users import into their apps; drop them for CLI-only code. `auth/testing` (`startLocalAuthServer`) inlines prettier (about 5 MB) through `@prisma/orm-toolchain`; a lazy `import('prettier')` in orm-toolchain would remove prettier from installs (about 10 MB). Not started.
5. **Smaller items:** `redis` (15 MB) is a required peer of `@effect/platform-node` used only by `NodeRedis` (ask Effect to make it optional); `esbuild` (10 MB) could be replaced by `rolldown`, which Alchemy already installs, for the boot wrapper build in `packages/0-framework/2-authoring/{node,nextjs}/src/control/build.ts` (pin it exactly to Alchemy's rolldown version).
6. **prisma/cloud-deploy-action#25** (end-to-end deploy test, Slack alerts, automatic `v1` move on release) is open and needs Will to add the `PRISMA_SERVICE_TOKEN` secret and `PRISMA_WORKSPACE_ID` variable to that repo. The action's `mode: destroy` still has no CLI command behind it, so branch teardown does not work.
7. **Release-process gaps found on the way:**
   - prisma-cli should run the cloud-deploy-action CLI test on its release PR and notify the action on publish, so a CLI flag change cannot break the action silently again.
   - ORM rc.23: a migration that calls a free `createExtension('btree_gist')` no longer works and no upgrade recipe mentions it (a session, `local_d8f74fff-75aa-47ae-a66e-4fed07a6692c`, was fixing it in prisma/orm).
   - Linear PRS-901: `prisma dev stop` leaves service processes running.
   - pdp-control-plane's own Composer apps are still on Composer 0.30.0 (TD-056 in that repo's `docs/TechDebt.md`).

## How to work here

- Composer repo: `/Users/wmadden/Projects/prisma/composer`. Push agent branches through the `bot` remote; commit with `git commit -s --trailer "Signed-off-by: Will Madden <madden@prisma.io>"`; put `Agent: <your name>` in PR descriptions.
- Releases follow `skills-contrib/publish-npm-version/SKILL.md` and `docs/oss/versioning.md`. Release notes are auto-generated; add a migration section to the GitHub Release by hand.
- Order for a coordinated release: ORM (if needed) → Composer → prisma CLI (automatic once it notices) → create-prisma, pdp-control-plane Console setup, prisma-examples templates, cloud-deploy-action tests, prisma/web docs. Check each published version's dependencies with `npm view` before moving the next.
- Deploys to Prisma Cloud need Will's explicit permission each time; credentials are in `~/.config/prisma-compose/deploy.env` (never print them). Delete QA projects afterwards with `prisma project delete <id> --confirm <id>`.
- Use a recent Bun (Prisma Compute runs Bun 1.4.x); an old local Bun made TanStack Start look broken.
- Run `/drive-code-review` on every slice before calling it done. Never run the full integration suites locally.

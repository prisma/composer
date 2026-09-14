# Release run, 2026-09-12

## Done

- prisma/orm 8.0.0-rc.10 published by the ORM team (their PR 30268).
- prisma/composer PR 291 merged: ORM family rc.8 -> rc.10, `// use prisma-8` headers, every contract re-emitted, snapshot d.ts copies synced. Storage hashes unchanged.
- prisma/composer PR 292 merged: v0.19.0 published to npm under `latest`, GitHub release created. composer-prisma-cloud 0.19.0 peers on orm-postgres 8.0.0-rc.10.

## Waiting on a human approval (branch rules require 1 review; the bot cannot approve or admin-merge)

1. prisma/prisma-cli PR 261: composer-cli/composer 0.19.0, orm-toolchain rc.10. CI green (16 checks), conformance clean. Approve and squash-merge.
2. Then create the rc.14 release PR from the updated main: `pnpm bump-version`, commit `chore(release): bump to 8.0.0-rc.14`, PR, approve, squash-merge. Publishes `prisma@8.0.0-rc.14`. (The first attempt, PR 262, was closed because it was branched before 261 merged.)
3. After rc.14 is on npm: re-run CI on prisma/create-prisma PR 97 (its Windows smoke fails today because `prisma@latest` is rc.13 with the rc.8 toolchain, emitting a contract.d.ts that ORM rc.10 rejects). Approve, squash-merge, then cut create-prisma 0.12.0 via `bun run bump minor` or by hand.
4. prisma/web PR 8262 (43 docs pages). CI green. Approve and merge after rc.14 exists, since the version tables name it.

## Findings that need someone else

- prisma-cli `update-product-versions.yml` has failed daily since 2026-09-10: `DEPLOY_GITHUB_TOKEN` (account `prisma-bot`) gets 403 pushing to prisma/prisma-cli. That is why ORM rc.9 never reached the CLI. Fix the token's repository permission.
- Auto-merge is disabled on prisma/prisma-cli, so the workflow's `gh pr merge --auto` would fail even with a working token.
- composer's publish.yml has no `Notify prisma-cli` dispatch step (release-automation.md asks each product repo for one). Only the daily schedule notices composer releases.
- create-prisma pins the ORM exactly but installs `prisma@latest`; every ORM bump opens a window where scaffolds mix toolchain and runtime versions. Either pin `prisma` or order releases CLI-first.
- Two telemetry config directories: unified CLI engine `~/.config/prisma/`, ORM toolchain rc.10 `~/.config/prisma-8/`. Consent notice can print twice.
- orm-postgres 8.0.0-rc.10 declares a peer on `typanion` that nothing installs (pnpm warning in composer). Harmless so far.
- Composer's `pnpm test` at default turbo concurrency fails on a laptop (packages share one local Postgres). Every package passes alone; CI already serialises local-target.
- Docs left for a maintainer's judgment (listed in the web PR body): Compute default region, the pnpm-workspaces emit-failure claim, telemetry config directory.

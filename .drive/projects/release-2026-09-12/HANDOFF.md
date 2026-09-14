# Handover: the 2026-09-12 release chain (ORM rc.10, Composer 0.19.0, prisma CLI rc.14, create-prisma 0.12.0)

Written 2026-09-14 by the agent that ran the release, for a fresh session in a fresh worktree. Nothing in this brief is uncommitted: every change is on merged pull requests or on a pushed branch named below.

## Read the transcript for full context

The complete session transcript (every command, output, and decision) is at `/Users/wmadden/.claude/projects/-Users-wmadden-Projects-prisma-composer--claude-worktrees-composer-dev-tag-staleness-943d54/75e56524-3097-491c-b312-19e276284bf8.jsonl` (about 2.5 MB of JSONL). Grep it rather than reading it whole; search for a PR number or a package name to find the relevant stretch.

## What is done and published

| Package | Version on npm `latest` | How it got there |
| --- | --- | --- |
| `@prisma/orm-*` | 8.0.0-rc.10 | ORM team merged prisma/orm#30268 |
| `@prisma/composer`, `@prisma/composer-cli`, `@prisma/composer-prisma-cloud` | 0.19.0 | prisma/composer#291 (ORM pins rc.8 to rc.10, `// use prisma-8` headers, re-emitted contracts) then #292 (`chore(release): v0.19.0`) |
| `prisma`, `@prisma/cli` | 8.0.0-rc.14 | prisma/prisma-cli#261 (composer-cli 0.19.0, orm-toolchain rc.10) then #264 (`chore(release): bump to 8.0.0-rc.14`) |
| `create-prisma` | 0.12.0 | prisma/create-prisma#97 (composer 0.19.0, ORM rc.10, `prisma-8.md` primer cleanup for Deno) then #98 (`chore(release): 0.12.0`) |

Docs: prisma/web#8262 merged (43 pages synced to the versions above; CodeRabbit's six findings fixed). prisma/web#8276 is open: one sentence on `compute/limitations.mdx` saying a service without a region takes its project's region, per ignite's build-system page. It needs a human approval.

## Open items, in priority order

1. **Approve and merge prisma/web#8276** (one-line docs fix). Nothing else depends on it.
2. **Enable "Allow auto-merge" on prisma/prisma-cli.** The daily `update-product-versions.yml` job had failed since 2026-09-10 with a 403 because its `DEPLOY_GITHUB_TOKEN` account `prisma-bot` was not a collaborator. Will added the collaborator on 2026-09-12; a manual dispatch then pushed and opened its PR correctly and failed only at `gh pr merge --auto` ("Auto merge is not allowed for this repository"). Its PRs will also need one human approval under the branch rules. The token itself needs Contents read/write, Pull requests read/write, Metadata read, scoped to prisma/prisma-cli, and is stored under the same secret name in prisma-cli, composer, and orm.
3. **composer's `publish.yml` has no "Notify prisma-cli" step.** prisma-cli's `docs/oss/release-automation.md` asks each product repo to send a `repository_dispatch` of type `product-published` after a successful publish. Without it, only the daily schedule notices a composer release. Small workflow change in prisma/composer.
4. **Two telemetry config directories.** The unified CLI engine stores consent in `~/.config/prisma/` (`prisma-cli/packages/cli-engine/src/telemetry/user-config.ts`); the ORM toolchain rc.10 uses `~/.config/prisma-8/` (moved from `prisma-next/`). One user can see the one-time telemetry notice twice. The docs telemetry page deliberately names no directory until this is settled. Product decision for the CLI and ORM teams.
5. **create-prisma's version race.** It pins the ORM exactly but installs `prisma@latest`. Every ORM bump opens a window where scaffolds mix a new ORM runtime with an older toolchain inside the published CLI; the Windows creation smoke check fails in that window (it did on #97 until rc.14 was published). Either pin `prisma` in `src/constants/dependencies.ts` or always release the CLI before create-prisma.
6. **Unverified docs claim.** `guides/deployment/pnpm-workspaces.mdx` says `orm init`'s final emit step fails in a pnpm workspace because pnpm links `@prisma/cli-engine` to a missing directory, and gives a repair command. Nobody has re-tested this on rc.10 / CLI rc.14. Scaffold a pnpm workspace and either delete the repair section or keep it.
7. **Minor:** `@prisma/orm-postgres@8.0.0-rc.10` declares a peer on `typanion` nothing installs (pnpm warning only). Composer's `pnpm test` at default turbo concurrency fails on a laptop because packages share one local Postgres; run packages one at a time (CI already serialises local-target).

## How the mechanics work (learned the hard way)

- **Repos and where to clone them.** Work in the composer worktree and clone the others into `wip/repos/` (gitignored): `git clone --filter=blob:none git@github-wmadden-electric:prisma/<repo>.git`. This session's clones live under `/Users/wmadden/Projects/prisma/composer/.claude/worktrees/composer-dev-tag-staleness-943d54/wip/repos/` (orm, prisma-cli, create-prisma, web, ignite) and can be copied, but a fresh clone is safer.
- **Approvals.** prisma-cli, create-prisma, and web require one approving review; the `wmadden-electric` bot cannot approve its own PRs and cannot admin-merge. composer is approved by the `prisma-gizmo` review bot. Ask Will for approvals up front. Release PRs must contain only the version bump.
- **Composer release.** ORM bump PR first, then `pnpm bump-minor` on a branch off the new main, PR titled `chore(release): v<version>`, merge with a merge commit (repo convention). Merging publishes.
- **Re-emitting composer contracts after an ORM bump.** The ORM toolchain has no bin of its own; use a built prisma-cli clone whose `packages/cli/package.json` pins the target toolchain: `pnpm install && pnpm build:cli` there, then in each contract directory `node <clone>/packages/cli/dist/cli.js contract emit --config prisma.config.ts`. Directories: `examples/orm-demo`, `examples/auth`, `examples/store/modules/{catalog,orders}`, `packages/1-prisma-cloud/2-shared-modules/auth/src/pack`, and the `source/` dirs of the `gadget-contract` and `widget-contract` fixtures under `packages/1-prisma-cloud/1-extensions/target/src/__tests__/fixtures/`. Then `biome format --write` the emitted files and copy each `contract.d.ts` over its `migrations/snapshots/<hash>/contract.d.ts` (the `lint-contract-snapshots` script tells you which). The `empty-app` fixture keeps a legacy `prisma-next.config.ts` and is not re-emitted.
- **prisma-cli release.** Product pins first (the workflow, or by hand in `packages/cli/package.json` and `packages/prisma/package.json` plus `pnpm install`), `pnpm check:conformance` must say "nothing to report", squash-merge, then branch from the new main and run `pnpm bump-version`, PR titled `chore(release): bump to 8.0.0-rc.N`, squash-merge. Do not branch the release PR before the pins merge (that mistake was #262, closed).
- **create-prisma release.** Bump `version` in `package.json`, `bun install`, commit `chore(release): X.Y.Z`, PR, squash-merge. The publish workflow keys on the squash commit title starting with `chore(release):`.
- **Bot identity.** Commit with `git commit -s --trailer "Signed-off-by: Will Madden <madden@prisma.io>"` plus the Claude co-author trailer; push via the `bot` remote in composer and `origin` in the wip clones (both use the `github-wmadden-electric` SSH alias).

## Audit summary that fed the docs PR

- ORM rc.9 (never adopted by composer or the CLI) and rc.10 breaking changes: schema header `// use prisma-8`, env vars lose the `NEXT_` infix, primer renamed `prisma-8.md`, `nullable` on to-one relations in `contract.json`, `Models` namespace and `Scalars`/`Shape`/`ResultType`, `db sign` advances the `db` ref, attribute completion in the language server. Composer code used none of the rc.9-removed APIs; only fixtures and headers changed.
- Composer 0.18.0 changes that were undocumented until #8262: cron `input` binding and the always-on scheduler, project region inheritance, Windows Alchemy shim fix, compact ORM migration state, the `effect` override step no longer needed.
- prisma-cli since rc.13: help rewritten as a manual, `prisma-platform-core-concepts` skill shipped, skills sync removes copies for dropped agents, Windows package-manager shim fix, feedback metadata fix.
- create-prisma since 0.11.7: skills opt-out at scaffold time (#96).

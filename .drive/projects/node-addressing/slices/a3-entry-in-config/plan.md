# A3 — dispatch plan

Spec: [spec.md](spec.md). Branch `drive/deploy-entry-in-config`, cut from `origin/main` `561f5336`. Dispatches run in order. The PR opens after review and QA.

### D1. Design records describe the entry in the config

- **Outcome:** ADR-0003, ADR-0049 and ADR-0050 carry amendment notes and updated text. ADR-0044 lists `CONFIG.ENTRY_MISSING`. `deploy-cli.md`, `local-dev.md` and the glossary show `prisma deploy` and `prisma dev` without a positional entry. The ADR index entries mention the amendments.
- **Builds on:** the spec.
- **Gate:** `pnpm lint`.

### D2. The config's entry, the `--entry` flag, and the operations

- **Outcome:** the section check accepts `entry`. `deploy`/`dev` take `--entry` and no positional. The operations take an optional `entry` that overrides `config.value.entry`. A missing entry fails with `CONFIG.ENTRY_MISSING`. The entry path given to the Alchemy child is absolute. Unit tests cover: the config entry resolved against the config file's directory from another cwd, the override, the missing case, an invalid `entry` value, and a leftover positional.
- **Builds on:** D1.
- **Gate:** `pnpm typecheck`, `pnpm lint`, cli package tests.

### D3. Every caller in the repo uses the config's entry

- **Outcome:** each example's and the website's `prisma.config.ts` has `entry`. Package scripts, `scripts/composer-destroy.ts` (now `--entry`), the deploy-verify-destroy action, `deploy-docs.yml`, the guides, the skill, `gotchas.md`, the READMEs and every test that passes a positional entry use the new form. `git grep` finds no `prisma deploy <file>` or `prisma dev <file>` outside ADR history text.
- **Builds on:** D2.
- **Gate:** `pnpm typecheck`, `pnpm lint`, `pnpm lint:deps`, cli tests, `scripts/*.test.ts`, `test/integration` after `pnpm build`.

### Review

`/drive-code-review` on the branch (no walkthrough). Fix findings in follow-up dispatches.

### D4. QA

- **Outcome:**
  - From an example directory: `prisma deploy` with the config's entry deploys to the real platform.
  - `prisma deploy --entry` from another directory works.
  - With no entry, the error is `CONFIG.ENTRY_MISSING`.
  - `prisma dev` and `prisma dev --detach`/`dev stop` run from the config's entry.

  Every test Project is deleted afterwards.
- **Builds on:** review fixes.
- **Hands to:** evidence for the PR description.

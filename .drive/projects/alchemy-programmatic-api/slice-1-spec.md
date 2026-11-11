# Slice 1: Alchemy preview and effect 4.1

## Goal

Every package in the repo depends on the Alchemy preview build `https://pkg.alchemy.run/alchemy/972f294ae0c7982a8ebcb551fadd07d29c9c0fca` instead of `2.0.0-beta.83`, and the `effect` set (`effect` and every `@effect/*` companion) moves to one 4.1 version that satisfies that build's peers. Alchemy still runs as a child process. No behaviour changes.

## Done when

- `import * as Alchemist from 'alchemy/Alchemist'` resolves from `@prisma/composer-cli`.
- One copy each of `alchemy` and `effect` in the workspace; `check:npm-effect-resolution` and the CLI's effect-resolution check agree with the new pins.
- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test:packages` pass.
- The local-dev integration test files pass locally (run only those files).
- The e2e deploy workflow passes in CI on the PR.
- The `upgrade-alchemy-effect` skill and any docs that name the old versions are updated, including how to pin a preview URL.

## Out of scope

Any use of `alchemy/Alchemist`. That is slice 2.

# A2 — dispatch plan

Spec: [spec.md](spec.md). Branch `drive/deploy-list`, cut from `origin/main` `87d001de`. Dispatches run in order. The PR opens after review and QA.

### D1. The command

- **Outcome:** `deploy list` in composer-cli's family, with `--stage`, `--name`, `--entry`, and human, stdout and JSON output as the spec says. The join and kind mapping are a pure function with unit tests: root, service, both Postgres types, bucket, module, a node with no row, a missing topology. The command test uses a fake Management API client.
- **Gate:** `pnpm typecheck`, `pnpm lint`, `pnpm lint:deps`, composer-cli tests.

### D2. The end-to-end check and the docs

- **Outcome:** the deploy-verify-destroy action runs `deploy list --json` after deploy and checks it against the platform rows. The design records and guides from the spec are updated.
- **Gate:** `pnpm lint`; the e2e workflow on the PR.

### Review

`/drive-code-review` on the branch (no walkthrough). Fix findings in follow-up dispatches.

### D3. prisma-cli mounts the command

- **Outcome:** a prisma/prisma-cli PR adds `"deploy list"` next to `"emulator list"`, once the composer-cli release that has it is out.

### D4. QA

- **Outcome:** deploy an example to a named stage on the real platform, run `deploy list` for it and for production, check every node, then delete the test Project.

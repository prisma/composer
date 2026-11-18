# Slice 3: Dev in-process

Branch `claude/alchemy-dev-in-process`, stacked on #405 (`claude/alchemy-deploy-in-process`).

## Goal

`prisma dev` runs each converge (the first one and every rebuild) through the app's converge (`loadAppConverge` → `convergeInProcess`, from slice 2) in the `prisma` process. No `.prisma-composer/dev/<env>/alchemy.run.ts` is written and no Alchemy child is spawned. Destroy keeps the subprocess path.

## Behaviour

- Each converge is its own `plan` + `apply` in its own scope, so the state-store lease is held only while a converge runs. Rebuilds stay one at a time (today's coalescing), which also satisfies slice 2's one-converge-per-process rule.
- Local providers stay Composer's local target (`localTargetProviders`), not Alchemy's `dev: true`.
- `convergeInProcess` gains whatever dev needs (the local providers, dev state store) without a second converge function.
- Converge events reach the user through the dev operation's own event stream, matching how dev reports today. A failed converge keeps the running app and keeps watching, as today, with a structured message instead of a stack-file path and reproduce command.
- Ctrl-C during a converge interrupts it and releases the lease; Ctrl-C while idle stops dev as today.
- `lower()` gets containers and preflight as values. If nothing else uses `transportedLowerInputs`, `generate-dev-stack.ts`, the dev parts of `run-alchemy.ts` or `family/dev-converge-child.ts`, delete them.
- **Stale app graph.** Today a rebuild re-runs `loadEntry`, a plain `import()` that Node and Bun cache, so the parent's graph does not change after an edit to the app's own definition files; the old child re-imported everything fresh. In-process, the parent's graph is what gets applied. Find out exactly what a rebuild changes today (artifacts vs topology), then make a topology edit either take effect or be reported clearly (for example the way `values-changed` asks for a restart). Do not add a child process or worker to work around it without telling me first. Record the outcome in the ADR.
- Credentials: confirm whether dev needs `PRISMA_SERVICE_TOKEN` at all (local target). Do not add a token requirement dev does not have today.

## Docs

ADR-0064 (or a new ADR if cleaner) extended to dev; `deploy-cli.md` and any dev docs that describe the child or the dev stack file; slice 2's notes saying "dev still spawns".

## Done when

- `prisma dev` writes no `alchemy.run.ts` and spawns no Alchemy child (a test asserts both).
- Unit tests cover first converge, rebuild, failed rebuild keeping the app, interruption, and the stale-graph outcome.
- The local-dev integration test files pass (run one at a time; EADDRINUSE on 43xx ports means another session's emulators, not this change).
- Manual QA: `prisma dev` on an example, edit a service file and see the rebuild, edit the app definition and see the documented outcome, Ctrl-C.

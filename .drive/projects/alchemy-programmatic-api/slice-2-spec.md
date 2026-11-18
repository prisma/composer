# Slice 2: Deploy in-process

Branch `claude/alchemy-deploy-in-process`, stacked on #404 (`claude/alchemy-api-evaluation-5f1d17`).

## Goal

`prisma deploy` (and the programmatic `deploy` operation) lowers the app and calls `Alchemist.plan` / `Alchemist.apply` from `alchemy/Alchemist` in the `prisma` process. No `alchemy.run.ts` is written for deploy and no Alchemy child is spawned. Destroy and dev keep the subprocess path unchanged.

## Behaviour

- `lower()` takes containers, preflight results and the report hook as values. The environment-reading fallback stays only for the stack file that destroy and dev still generate.
- The deployment summary comes back as a value from the same process. No `PRISMA_COMPOSER_DEPLOYMENT_RESULT_FILE` and no `captureEngineFailure` on the deploy path.
- Alchemy's typed events (`Alchemist.onEvent`) become engine step events under the existing `deploy.apply` step, so human and JSON output keep one format. Alchemy's console sink is replaced; nothing writes to stdout outside the engine, so JSON mode stays clean. No `SigilRenderer`.
- Alchemy failures become structured errors with dotted codes, keeping today's codes and Composer advice (`withComposerAdvice`) where they exist.
- Ctrl-C (the engine's abort signal) interrupts the running plan or apply. The scope closes, so the state-store lease is released (ADR-0045). Exit code 130.
- Alchemy and `effect` load only behind the operation's lazy import (`check:family-static-graph`).
- Credentials: when `PRISMA_SERVICE_TOKEN` and `PRISMA_WORKSPACE_ID` are in the environment, deploy works as today. For a `prisma login` session, first look for a public `@prisma/cli-engine` API that gives the handler the active access token (`readActiveAccessToken` is exported but needs a `TokenStorage`). If one exists, set the two variables in `process.env` for the duration of the apply and restore them after. If none exists, fail before planning with a structured error that says to set `PRISMA_SERVICE_TOKEN`, and record the gap in the PR description; the upstream ask is in `upstream-asks.md`. Do not spawn a process to read the token.

## Docs

- A new ADR that supersedes ADR-0007 for deploy, and amends ADR-0038, ADR-0043 and ADR-0044 for deploy. Update the ADR index.
- `docs/design/10-domains/deploy-cli.md`: the pipeline step that runs Alchemy, and the section on the Alchemy child's runtime.
- Rebuild the lowering `scratch-stack` test harness on `alchemy/Alchemist`, or delete it if the in-process deploy path makes it unnecessary (slice 1 review S07).

## Done when

- `prisma deploy` writes no `alchemy.run.ts` and spawns no Alchemy child (a test asserts both).
- Unit tests cover event mapping, error mapping, the summary value and interruption.
- The e2e deploy workflow passes in CI.
- Manual QA: a real deploy from the CLI, then Ctrl-C during a second deploy, then a third deploy that does not wait for the lease to expire.

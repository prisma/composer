# Design notes

## Decisions

- **No generated code.** The operation calls `lower()` and passes the stack value to `Alchemist.plan`. Containers, preflight results and bundles go in as arguments.
- **No child process.** Alchemy runs in the `prisma` process. The Alchemy copy is the one `@prisma/composer-cli` depends on, like every other module the host loads.
- **Output through the engine.** `Alchemist.onEvent` maps Alchemy's typed events (`apply.resource.status` and friends) to engine `step-started` / `step-finished` events under the existing `deploy.apply` step. `SigilRenderer` is not used: it would give `prisma deploy` a second output format and nothing in JSON mode. `Alchemist.layer()`'s console sink is replaced with a logger that sends Alchemy's log lines to stderr.
- **Result without a file.** `apply` returns the stack output. The `report` hook `lower()` already takes is called in the same process, so `DeploymentSummary` comes back as a value. `captureEngineFailure` and the result file go away for deploy and dev.
- **Ctrl-C.** The handler runs the effect with an interrupt on the engine's abort signal. Exit code comes from the operation's result; the ADR-0044 child-status exception no longer applies to deploy and dev.
- **Dev.** Each converge is its own `plan` + `apply` in its own scope, so the lease is held only during a converge. Local providers stay Composer's own local target (`localTargetProviders`), not Alchemy's `dev: true`.

## Credentials

Alchemy's Prisma provider reads `PRISMA_SERVICE_TOKEN` (and Composer's target reads `PRISMA_WORKSPACE_ID`) from config, and `Alchemist` builds config only from `process.env` plus `.env`.

- When the token is already in the environment (CI, the e2e workflow, `deploy.env`), it works unchanged.
- In an interactive `prisma login` session there is no token in the environment, and the engine never gives a handler the credential. Today `needs: { credentials: 'child' }` writes it into the child's environment.

Workaround for this project: set `PRISMA_SERVICE_TOKEN` / `PRISMA_WORKSPACE_ID` in `process.env` for the duration of the apply. That needs the engine to hand the handler the active access token.

Upstream asks:

1. Alchemy: let `plan` take config overrides (a `ConfigProvider` or a record) instead of reading only `process.env`.
2. `@prisma/cli-engine`: a credentials need for in-process use, for example `needs: { credentials: 'process' }`, that gives the handler the active access token (refreshed) and workspace id.

## Alternatives considered

- **Keep a child process running a Composer-owned runner.** Rejected: extra process and IPC for nothing the in-process path lacks.
- **Keep generating `alchemy.run.ts` and load it with `Alchemist.importStack`.** Rejected: the file existed so a failed run could be rerun by hand with the Alchemy CLI; with the API, writing code to import it back is circuitous.
- **`SigilRenderer` for output.** Rejected above.

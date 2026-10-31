# ADR-0064: `deploy` runs Alchemy in the `prisma` process

## Decision

`prisma deploy`, and the `deploy` operation on `@prisma/composer/control`, run Alchemy's plan and apply in the process that runs the deploy, through Alchemy's programmatic API (`alchemy/Alchemist`). Deploy writes no `.prisma-composer/alchemy.run.ts` and starts no Alchemy child.

```ts
const { lower, convergeInProcess } = await import(/* the app's @prisma/composer/internal/converge */);
const stack = lower(root, config, {
  name, environment, configPool, bundles,
  containers,           // each extension's resolved container
  preflight,            // each extension's preflight payload
  report: (result) => { summary = toDeploymentSummary(result); },
});
const plan = yield* Alchemist.plan({ stack, operation: 'deploy', stage, updateStateStore: true });
yield* Alchemist.apply(plan);
```

This supersedes [ADR-0007](ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md) for `deploy`. `destroy` and `prisma dev` keep the generated stack file and the Alchemy child until they move.

- **The app's install runs the converge.** The executor loads `lower` and `convergeInProcess` (together, the app converge) from `@prisma/composer/internal/converge`, resolved from the directory of the app's `prisma.config.ts`, as the old child path resolved Alchemy's bin. The extension descriptors, providers and state store come from that install through `prisma.config.ts`, and the `prisma` host pins its own Composer version ([ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md)). Taking the converge from the host's copy would put two copies of `alchemy` and `effect` in one process whenever the two versions differ; taking it from the app's install keeps one. An app whose `@prisma/composer` is missing or predates the entry fails with `DEPS.CONVERGE_UNRESOLVABLE` before anything is created.
- **Host and app run one Composer version.** The host's operation code calls the app's `lower` and converge and reads back their results, so the two must agree on every shape between them. Composer's packages release in lockstep, so the host compares the app's `@prisma/composer` version with its own and refuses any difference with `DEPS.CONVERGE_VERSION_MISMATCH`, naming both versions. An exact match is simpler than a separate contract number, and lockstep releases make it cheap to meet.
- **Values, not environment variables.** `lower()` takes the resolved containers and the preflight payloads as required values (`LowerOptions.containers`, `LowerOptions.preflight`), and each extension reads its own payload as `LowerContext.preflight`. Only the generated stack files for `destroy` and `prisma dev` read the environment transports, through one core helper, `transportedLowerInputs(config)`. This amends [ADR-0038](ADR-0038-containers-are-an-extension-descriptor.md) for `deploy`: no container crosses a process boundary.
- **The summary is a value.** The report hook runs inside the apply, in the same process, so `deploy` returns the `DeploymentSummary` directly. This amends [ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md): `PRISMA_COMPOSER_DEPLOYMENT_RESULT_FILE` and the failure-cause file are not used by `deploy`.
- **Progress is engine step events.** Alchemy's typed events become steps under `deploy.apply`, one per resource, and its log lines become messages. Alchemy's console sink is replaced and `SigilRenderer` is not used, so human and JSON output keep one format and nothing but the engine writes to stdout.
- **Failures are structured.** The converge returns the errors Alchemy failed with as typed reasons (tag and message), and the deploy maps them to `DEPLOY.ENGINE_FAILED`, with Composer's advice in place of the Alchemy CLI's and secrets removed. A converge that rejects instead of returning an outcome is `DEPLOY.ENGINE_FAILED` too. An interrupted one is `DEPLOY.INTERRUPTED`. Every message event, and an error raised while the stack is built, is redacted the same way. This amends [ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md): the child exit-status passthrough no longer applies to `deploy`; its failures exit 2, and Ctrl-C exits 130.
- **Ctrl-C interrupts the plan or apply.** The engine's abort signal interrupts the running effect. The plan's scope closes, which releases the environment's state lease ([ADR-0045](ADR-0045-deploy-state-lives-behind-the-platform-state-api.md)), so the next deploy does not wait for the lease to expire. The engine exits 130 (143 for SIGTERM) only when a handler ends with its abort, not when it returns an error, so `prisma deploy` reports `DEPLOY.INTERRUPTED` as a message event, which JSON output carries as a frame with the code, and then ends with the engine's abort (`CLI.ABORTED`).
- **The credential is an environment variable.** Alchemy reads its configuration only from `process.env` and `.env`. `deploy` sets `PRISMA_SERVICE_TOKEN`, `PRISMA_WORKSPACE_ID` and each reporter's variables in `process.env` for the length of the plan and apply, and changes to the deploy's working directory when the process is elsewhere, and restores both on every exit path. Only Alchemy's credentials and working directory need process state; the reporter variables ride the same overlay until a reporter can read them as values. `@prisma/cli-engine` 0.9.0 gives a command no way to read a `prisma login` session's token. So the operation checks for a service token before preflight and before any container is ensured, and refuses with `DEPLOY.SERVICE_TOKEN_REQUIRED`. The command passes a token only when the engine's active credential came from the environment, with that same credential's workspace; when the credential names no workspace, `PRISMA_WORKSPACE_ID` is removed for the apply. A token from one credential is never paired with a workspace from another.
- **One converge per process.** Because of that process state, a second converge while one runs is refused with `DEPLOY.CONVERGE_RUNNING`. The flag lives on `globalThis` under a `Symbol.for` key, so it holds across every install of the entry a host loads, such as two apps deployed from one script; and a call from a worker thread whose `cwd` is not the process's working directory, which a worker cannot change, with `DEPLOY.WORKER_THREAD`.
- **Stdout stays the engine's.** Alchemy's log lines and events go to the caller as values, and Alchemy's non-interactive `Interaction` writes to stderr. The `prisma deploy` command, not the operation, sends `console`'s stdout methods to stderr while the operation runs, so a provider's `console.log` cannot corrupt JSON output; a host calling the operation keeps its own `console`, as ADR-0043 requires. A provider that writes to `process.stdout` directly is out of reach.

## Reasoning

ADR-0007 chose a generated file and the Alchemy CLI because Alchemy had no programmatic API, and because a file a user can rerun bisects a framework bug from an Alchemy bug. Alchemy now has one (`alchemy/Alchemist`, from commit `972f294`). With it, the generated file is a detour: Composer wrote TypeScript, found Alchemy's bin, spawned it, and passed containers, preflight payloads and the result through environment variables and files, only for the child to import the config again and rebuild what the parent already held. In process, the parent hands Alchemy the stack value and gets typed results and typed events back.

The bisection argument weakens with the API. A failed deploy now reports Alchemy's own error as a structured cause, and the per-resource step events say which resource failed. The cost of losing the rerunnable file is accepted.

## Consequences

- `deploy` no longer resolves Alchemy's bin or needs Node on PATH under Bun. `DEPLOY.ALCHEMY_BIN_MISSING`, `DEPLOY.NODE_MISSING` and `DEPLOY.STACK_WRITE_FAILED` remain for `destroy` and `prisma dev`.
- New codes: `DEPLOY.INTERRUPTED`, `DEPLOY.SERVICE_TOKEN_REQUIRED` (temporary), `DEPLOY.CONVERGE_RUNNING`, `DEPLOY.WORKER_THREAD`, `DEPS.CONVERGE_UNRESOLVABLE` and `DEPS.CONVERGE_VERSION_MISMATCH`.
- The converge relies on two Alchemy modules outside `alchemy/Alchemist`: `alchemy/Util/LogRecord` (to read log records) and `alchemy/Interaction` (to send interaction output to stderr).
- `prisma deploy` declares `needs: { credentials: true }` and no longer `maySpawn`.
- Setting `process.env` and the working directory for the length of the apply is process-wide state, so one process runs one converge at a time. The upstream asks below remove the need.
- Interactive deploys signed in with `prisma login` need `PRISMA_SERVICE_TOKEN` until `@prisma/cli-engine` gives a command the active access token, or Alchemy lets a caller pass configuration to `plan` instead of reading only the environment.

## Alternatives considered

- **Keep a child process running a Composer-owned runner.** Rejected: an extra process and a protocol for nothing the in-process path lacks.
- **Keep generating `alchemy.run.ts` and load it with `Alchemist.importStack`.** Rejected: the file existed so a failed run could be rerun with the Alchemy CLI; writing code to import it back is circuitous.
- **`SigilRenderer` for output.** Rejected: it would give `prisma deploy` a second output format and print nothing in JSON mode.
- **Read the stored token by spawning a process.** Rejected: it would bring back a child for credentials alone.

## Related

- Amends: [ADR-0007](ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md) (superseded for `deploy`), [ADR-0038](ADR-0038-containers-are-an-extension-descriptor.md), [ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md), [ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md), [ADR-0049](ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md) (its child-process reason narrows to `destroy` and `prisma dev`), [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md) (deploy has no second process).
- [ADR-0045](ADR-0045-deploy-state-lives-behind-the-platform-state-api.md), [ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md)
- [`../05-prisma-cloud/build-reporting.md`](../05-prisma-cloud/build-reporting.md)
- [`../10-domains/deploy-cli.md`](../10-domains/deploy-cli.md) § The pipeline, step 9

# ADR-0068: `destroy` runs Alchemy in the calling process, and nothing starts the Alchemy CLI

## Decision

The `destroy` operation on `@prisma/composer/control` runs Alchemy's plan and apply in the process that calls it, through the app's converge entry, as `deploy` does ([ADR-0066](ADR-0066-deploy-runs-alchemy-in-process.md)). It writes no `.prisma-composer/alchemy.run.ts` and no app configuration file, and starts no Alchemy child.

```ts
const { lower, convergeInProcess } = await import(/* the app's @prisma/composer/internal/converge */);
const containers = /* each extension's container.locate(...) */;
const stack = lower(root, config, {
  name, environment, appConfigurationRead, bundles,
  containers,
  preflightPayloads: new Map(),
  preparedNodeAddresses,
  credentials,
});
await convergeInProcess({ operation: 'destroy', stack, stage, cwd, env: {}, signal, onEvent, output });
// then each extension's teardown, then each container's remove
```

This extends ADR-0066 to `destroy` and supersedes [ADR-0007](ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md) in full. With [ADR-0067](ADR-0067-prisma-dev-converges-in-a-worker-thread.md) for `prisma dev`, no Composer command generates a stack file or starts the Alchemy CLI.

- **One converge path.** `ConvergeRequest.operation` is `'deploy' | 'destroy'`. Destroy loads the app's converge entry first, so a missing or incompatible install fails with `DEPS.CONVERGE_UNRESOLVABLE` or `DEPS.CONVERGE_CONTRACT_MISMATCH` before anything is located. The converge contract number stays 2, because no release has shipped contract 2.
- **Destroy still calls `lower()`, for the providers and the state store.** Alchemy's destroy plan reads the state store and deletes what it lists, through the stack's providers. It never runs the stack program, so on a destroy `lower()`'s own Load and its node address check do not run, and of what destroy passes only the containers are read, by the state store. Destroy still runs the same preparation as deploy before that: it Loads the app, assembles it (`DEPLOY.BUILD_REQUIRED` when the app is not built) and locates each container. The assembly is not needed for the plan; removing it from destroy is a follow-up.
- **Teardown and removal follow an applied converge.** Each extension's `teardown` and then each container's `remove` run only when the converge applied, in the order ADR-0034 requires. An interrupted, failed or refused converge runs neither.
- **Progress is events, and the operation prints nothing.** `DestroyInput.onEvent` receives the step and message events `deploy` emits, without `preflight`, redacted the same way, and the `no-local-deploy-state` notice before them. A caller that wants progress on a terminal prints the events; the repository's `scripts/composer-destroy.ts` prints one line each on stderr.
- **Failures and interruption are deploy's.** `DestroyInput.signal` interrupts the plan or apply, the plan's scope closes and releases the environment's state lease, and the operation fails with `DEPLOY.INTERRUPTED`. Alchemy's errors come back as `DEPLOY.ENGINE_FAILED` with typed reasons. A second converge in the process is refused with `DEPLOY.CONVERGE_RUNNING`, and a worker thread whose `cwd` is not the process's working directory with `DEPLOY.WORKER_THREAD`. The messages say "destroy".
- **Credentials.** Destroy hands the caller's credentials to `lower()` as deploy does. A caller that passes none, which is every caller of the public operation today, gets a client built from `PRISMA_SERVICE_TOKEN`.
- **No check for a secret in a plain value.** That check kept secrets out of the app configuration file. Destroy writes no file and sends no configuration to the platform, so it makes no such check. Load's refusal of a root input field that has the name of a platform secret still applies to every command.
- **The machinery of the child is deleted.** The stack file generator, the Alchemy bin lookup, the child runner, the app configuration file, the deployment result file and the engine failure file are gone, with core's environment transports for containers and preflight payloads. `LowerOptions.containers` and `LowerOptions.preflightPayloads` are required, and core reads nothing from `process.env`.
- **Names say what they hold.** `LowerOptions.firstProcessNodeAddresses` is `preparedNodeAddresses`. `FirstProcessLoadOptions` is `LoadOptionsWithConfiguration`, the Load that reads the app configuration, and `SecondProcessLoadOptions` is `LoadOptionsWithConfigurationRead`, the Load that is given what an earlier Load read.

## Reasoning

ADR-0066 left `destroy` on the child because it was the least used of the three commands. Keeping it there had a cost that grew as the other two moved. The stack file, the bin lookup, the transports and the app configuration file all stayed in the tree for one caller. Core's `lower()` kept a second way to receive its inputs. A stack file written by the host ran against the app's install with no contract check, so the names it imported could not change. And destroy authenticated with a token copied into a child's environment, which cannot refresh, while deploy authenticated through the caller's client.

One path removes all of that. Destroy now fails, reports and authenticates as deploy does, and the code that served only the child is deleted.

## Consequences

- Retired error codes: `DEPLOY.ALCHEMY_BIN_MISSING`, `DEPLOY.NODE_MISSING`, `DEPLOY.STACK_WRITE_FAILED`.
- `DEPLOY.ENGINE_FAILED` no longer carries `meta.diagnostics`, and `executionDiagnostics` and `ExecutionDiagnostics` are removed from `@prisma/composer/control`. A failed destroy is a structured failure; there is no child exit status to pass through. This ends the documented exception in [ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md).
- `DestroyEvent` is wider: it includes deploy's step and message events. `DestroyInput` gains `signal`. `@prisma/composer/control` exports `NoLocalDeployStateEvent`.
- Removed entries: `@prisma/composer/report` and `@prisma/composer/internal/app-configuration-file`.
- Removed from `@prisma/composer/config`: `containerEnv`, `containerEnvVarName`, `deserializeContainers`, `preflightEnv`, `preflightEnvVarName`, `readPreflightPayload`. Removed from `@prisma/composer/deploy`: `transportedLowerInputs`.
- No longer read: `PRISMA_COMPOSER_APP_CONFIGURATION_FILE`, `PRISMA_COMPOSER_DEPLOYMENT_RESULT_FILE`, `PRISMA_COMPOSER_CONTAINER_*`, `PRISMA_COMPOSER_PREFLIGHT_*`.
- A destroy no longer needs Node on PATH under Bun, and Alchemy runs under whatever runtime the calling process runs under.
- A failed run can no longer be rerun by hand with the Alchemy CLI. ADR-0066 accepted that cost for deploy; it now holds for every command.
- A host on this version and an app whose `@prisma/composer` predates the converge entry cannot destroy together: the operation fails with `DEPS.CONVERGE_UNRESOLVABLE`.

## Alternatives considered

- **Leave destroy on the child.** Rejected for the reasons above: a second path through core and the CLI for one rarely used operation, and a token that cannot refresh.
- **Delete destroy and tell users to delete the Project or Branch.** `prisma project delete` removes a whole app, but nothing else removes one environment and its state together, and the repository's end-to-end tests rely on it.
- **Build the providers and the state store for a destroy without `lower()`.** Alchemy's destroy plan needs only those two, and they come from the stack `lower()` returns. A separate construction for destroy would be a second path that could disagree with deploy's.

## Related

- Extends: [ADR-0066](ADR-0066-deploy-runs-alchemy-in-process.md). Supersedes: [ADR-0007](ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md).
- Amends: [ADR-0038](ADR-0038-containers-are-an-extension-descriptor.md) (no container crosses a process boundary in an environment variable), [ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md) (destroy's events, `signal`, no diagnostics, no result file), [ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md) (retired codes, no exit-status passthrough), [ADR-0049](ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md) and [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md) (no second process and no app configuration file), [ADR-0067](ADR-0067-prisma-dev-converges-in-a-worker-thread.md) (`preparedNodeAddresses`).
- [`../10-domains/deploy-cli.md`](../10-domains/deploy-cli.md) § The pipeline, step 10

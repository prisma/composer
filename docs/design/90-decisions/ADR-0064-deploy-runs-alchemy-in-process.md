# ADR-0064: `deploy` runs Alchemy in the `prisma` process

## Decision

`prisma deploy`, and the `deploy` operation on `@prisma/composer/control`, run Alchemy's plan and apply in the process that runs the deploy, through Alchemy's programmatic API (`alchemy/Alchemist`). Deploy writes no `.prisma-composer/alchemy.run.ts` and starts no Alchemy child.

```ts
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

- **Values, not environment variables.** `lower()` takes the resolved containers and the preflight payloads as values (`LowerOptions.containers`, `LowerOptions.preflight`), and each extension reads its own payload as `LowerContext.preflight`. Without them `lower()` reads the environment transports, which the generated stack file still needs. This amends [ADR-0038](ADR-0038-containers-are-an-extension-descriptor.md) for `deploy`: no container crosses a process boundary.
- **The summary is a value.** The report hook runs inside the apply, in the same process, so `deploy` returns the `DeploymentSummary` directly. This amends [ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md): `PRISMA_COMPOSER_DEPLOYMENT_RESULT_FILE` and the failure-cause file are not used by `deploy`.
- **Progress is engine step events.** Alchemy's typed events become steps under `deploy.apply`, one per resource, and its log lines become messages. Alchemy's console sink is replaced and `SigilRenderer` is not used, so human and JSON output keep one format and nothing but the engine writes to stdout.
- **Failures are structured.** A failed plan or apply is `DEPLOY.ENGINE_FAILED`, carrying the errors Alchemy failed with, with Composer's advice in place of the Alchemy CLI's and secrets removed. An interrupted one is `DEPLOY.INTERRUPTED`. This amends [ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md): the child exit-status passthrough no longer applies to `deploy`; its failures exit 2, and Ctrl-C exits 130.
- **Ctrl-C interrupts the plan or apply.** The engine's abort signal interrupts the running effect. The plan's scope closes, which releases the environment's state lease ([ADR-0045](ADR-0045-deploy-state-lives-behind-the-platform-state-api.md)), so the next deploy does not wait for the lease to expire.
- **The credential is an environment variable.** Alchemy reads its configuration only from `process.env` and `.env`. `deploy` sets `PRISMA_SERVICE_TOKEN`, `PRISMA_WORKSPACE_ID` and each reporter's variables in `process.env` for the length of the plan and apply, and changes to the deploy's working directory when the process is elsewhere, and restores both after. `@prisma/cli-engine` 0.9.0 gives a command no way to read a `prisma login` session's token, so `prisma deploy` requires `PRISMA_SERVICE_TOKEN` in the environment and otherwise fails with `DEPLOY.SERVICE_TOKEN_REQUIRED` before anything runs.

## Reasoning

ADR-0007 chose a generated file and the Alchemy CLI because Alchemy had no programmatic API, and because a file a user can rerun bisects a framework bug from an Alchemy bug. Alchemy now has one (`alchemy/Alchemist`, from commit `972f294`). With it, the generated file is a detour: Composer wrote TypeScript, found Alchemy's bin, spawned it, and passed containers, preflight payloads and the result through environment variables and files, only for the child to import the config again and rebuild what the parent already held. In process, the parent hands Alchemy the stack value and gets typed results and typed events back.

The bisection argument weakens with the API. A failed deploy now reports Alchemy's own error as a structured cause, and the per-resource step events say which resource failed. The cost of losing the rerunnable file is accepted.

## Consequences

- `deploy` no longer resolves Alchemy's bin or needs Node on PATH under Bun. `DEPLOY.ALCHEMY_BIN_MISSING`, `DEPLOY.NODE_MISSING` and `DEPLOY.STACK_WRITE_FAILED` remain for `destroy` and `prisma dev`.
- New codes: `DEPLOY.INTERRUPTED` and `DEPLOY.SERVICE_TOKEN_REQUIRED`.
- `prisma deploy` declares `needs: { credentials: true }` and no longer `maySpawn`.
- Setting `process.env` and the working directory for the length of the apply is process-wide state. Two deploys in one process at once would see each other's values. Neither the CLI nor any known host does this; the upstream asks below remove the need.
- Interactive deploys signed in with `prisma login` need `PRISMA_SERVICE_TOKEN` until `@prisma/cli-engine` gives a command the active access token, or Alchemy lets a caller pass configuration to `plan` instead of reading only the environment.

## Alternatives considered

- **Keep a child process running a Composer-owned runner.** Rejected: an extra process and a protocol for nothing the in-process path lacks.
- **Keep generating `alchemy.run.ts` and load it with `Alchemist.importStack`.** Rejected: the file existed so a failed run could be rerun with the Alchemy CLI; writing code to import it back is circuitous.
- **`SigilRenderer` for output.** Rejected: it would give `prisma deploy` a second output format and print nothing in JSON mode.
- **Read the stored token by spawning a process.** Rejected: it would bring back a child for credentials alone.

## Related

- [ADR-0007](ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md), [ADR-0038](ADR-0038-containers-are-an-extension-descriptor.md), [ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md), [ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md), [ADR-0045](ADR-0045-deploy-state-lives-behind-the-platform-state-api.md)
- [`../10-domains/deploy-cli.md`](../10-domains/deploy-cli.md) § The pipeline, step 9

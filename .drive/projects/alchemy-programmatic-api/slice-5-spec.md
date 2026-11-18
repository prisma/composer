# Slice 5: Destroy in process

Branch `claude/alchemy-destroy-in-process`, from `main` after #411.

## Goal

The `destroy` operation (`@prisma/composer/control`) runs Alchemy's plan and apply in its own process, as `deploy` does (ADR-0066). It writes no `.prisma-composer/alchemy.run.ts` and no app configuration file, and starts no Alchemy child. After this slice nothing in Composer starts the Alchemy CLI, and the code that existed only for that is deleted.

## Design

Destroy follows deploy's recorded design. Nothing new is invented.

- **The converge.** Destroy loads the app's converge entry before anything else, as deploy does, so a missing or incompatible install fails first. After it locates the containers it calls the entry's `lower()` with the containers as values, an empty preflight payload map, the caller's credentials and the node addresses of the graph it prepared, then `converge({ operation: 'destroy', … })`. `ConvergeRequest.operation` becomes `'deploy' | 'destroy'`. `CONVERGE_CONTRACT` stays 2: no release has shipped contract 2.
- **Credentials.** `DestroyInput` takes `credentials` as `DeployInput` does. A caller that passes none gets a client built from `PRISMA_SERVICE_TOKEN`, as in deploy.
- **Progress and output.** The operation prints nothing. `DestroyInput.onEvent` receives the same step and message events deploy emits, redacted, in addition to `no-local-deploy-state`. `scripts/composer-destroy.ts` prints them to stderr.
- **Interruption.** `DestroyInput.signal` interrupts the plan or apply. The failure is `DEPLOY.INTERRUPTED` with wording for destroy.
- **Teardown and container removal** run after the converge, unchanged.
- **The secret-in-a-plain-value refusal goes for destroy.** It protected the app configuration file, which destroy no longer writes.

## Deleted with the child

- CLI: `generate-stack.ts`, `run-alchemy.ts`, `alchemy-bin.ts`, the host's writing of the app configuration file and the `@prisma/composer/internal/app-configuration-file` entry, the deployment result file and the engine failure file (`DEPLOYMENT_RESULT_FILE_ENV`, `readEngineFailureCause`, `captureEngineFailure`, `deploymentReport` on `@prisma/composer/report` if nothing else uses it), the `alchemy` test seam, the child diagnostics on `DEPLOY.ENGINE_FAILED` (`stackFilePath`, `reproduceCommand`, `exitCode`).
- Core: the environment transports for containers and preflight payloads (`transportedLowerInputs`, `container-transport.ts`, `preflight-transport.ts`) and `lower()`'s fallback to them. `containers` and `preflightPayloads` become required on `LowerOptions` unless a caller in the tree still needs them optional.
- Error codes retired: `DEPLOY.ALCHEMY_BIN_MISSING`, `DEPLOY.NODE_MISSING`, `DEPLOY.STACK_WRITE_FAILED`.
- Core names that describe two processes are renamed for what they hold: `LowerOptions.firstProcessNodeAddresses` becomes `preparedNodeAddresses`; `FirstProcessLoadOptions` and `SecondProcessLoadOptions` get names that say which Load reads values and which Load is given them.

## Done when

- Unit tests drive destroy through a converge entry double: the request has `operation: 'destroy'`, the located containers and the credentials; teardown and container removal run only after an applied outcome; an interrupted, failed and refused outcome each map to their error.
- No file under `.prisma-composer/` is written by destroy (test).
- `grep` finds no caller of the deleted modules, and `pnpm build`, typecheck, lint and the package tests pass.
- Manual QA: deploy an example to Prisma Cloud, destroy it with `scripts/composer-destroy.ts`, confirm the project is gone and no `alchemy` process ran. Ctrl-C during a destroy, then destroy again.
- The e2e deploy workflow passes (it destroys every example it deploys).
- A decision record extends ADR-0066 to destroy and supersedes ADR-0007 in full; `deploy-cli.md` and the other documents describe one path.

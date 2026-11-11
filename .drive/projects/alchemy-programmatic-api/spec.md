# Alchemy in-process: deploy and dev call `alchemy/Alchemist` directly

## Purpose

Composer drives Alchemy by writing TypeScript (`.prisma-composer/alchemy.run.ts`), finding Alchemy's bin, and spawning it. Data crosses that boundary through environment variables and a result file. Alchemy now has a programmatic API (`alchemy/Alchemist`: `plan`, `apply`, typed events). This project makes `prisma deploy` and `prisma dev` call it in the `prisma` process, so Composer hands Alchemy a stack value and gets typed results back, with no generated code and no child process.

## At a glance

Before:

```ts
writeStackFile(...);                       // generates .prisma-composer/alchemy.run.ts
await ctx.spawn({ command: node, args: [alchemyBin, 'deploy', file, '--yes', '--stage', env], env: { ...containerEnv, ...preflightEnv, PRISMA_COMPOSER_DEPLOYMENT_RESULT_FILE } });
const summary = readDeploymentSummary(resultFile);
```

After:

```ts
const stack = lower(app, config, { name, environment, bundles, containers, preflight });
const output = await Effect.runPromise(
  Effect.gen(function* () {
    const plan = yield* Alchemist.plan({ stack, operation: 'deploy', stage: environment });
    return yield* Alchemist.apply(plan);
  }).pipe(Alchemist.onEvent(toStepEvent), Effect.provide(Alchemist.layer()), Effect.scoped),
);
```

## Non-goals

- `destroy`. It keeps the generated file and the spawned Alchemy CLI. Will: not a useful operation; migrate it later or delete it.
- Plan review or an approval prompt before apply. Deploy applies without asking, as `--yes` does today.
- Drift, nuke, logs or state commands built on `Alchemist`.
- Shipping a Composer release that depends on an unreleased Alchemy.

## Place in the larger world

- Reverses [ADR-0007](../../../docs/design/90-decisions/ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md) for deploy and dev. ADR-0007 was written before Alchemy had a programmatic API.
- Changes the cross-process parts of ADR-0038 (containers as environment variables), ADR-0043 (`PRISMA_COMPOSER_DEPLOYMENT_RESULT_FILE`) and ADR-0044 (child exit-status passthrough) for deploy and dev.
- `deploy-cli.md` § The pipeline step 7 and § The Alchemy child's runtime.
- Alchemy preview packages: `https://pkg.alchemy.run/alchemy/<commit sha>` is immutable. The API landed in `972f294ae0c7982a8ebcb551fadd07d29c9c0fca` (2026-10-30), after `2.0.0-beta.84`. Its `effect` peer is `^4.1.0`; Composer pins `effect` 4.0.3.
- The `prisma` CLI engine (`@prisma/cli-engine` 0.9.0): `needs: { credentials: 'child' }` writes `PRISMA_SERVICE_TOKEN` and `PRISMA_WORKSPACE_ID` into a child's environment. A handler never sees the credential, only `ctx.api`.
- Alchemy's Prisma provider reads `PRISMA_SERVICE_TOKEN` through Effect `Config`, and `Alchemist` builds its config only from `process.env` and `.env`.

## Cross-cutting requirements

- Exactly one copy of `alchemy` and of `effect` loads in the `prisma` process; the existing checks (`check:npm-effect-resolution`, `effect-blame`) stay green.
- The `prisma` bin's static import graph stays free of `alchemy` and `effect` value imports (`scripts/check-family-static-graph.mjs`). Alchemy loads only behind the operation's lazy import.
- Ctrl-C interrupts the running plan or apply, and its cleanup releases the deploy lease (ADR-0045).
- Alchemy's per-resource progress reaches the user through the engine's step events, so human and JSON output keep one format.
- Expected failures stay structured errors with dotted codes (ADR-0044).

## Transitional-shape constraints

- Until destroy moves or is deleted, `generate-stack.ts`, `alchemy-bin.ts` and `run-alchemy.ts` stay for destroy. `lower()` takes containers and preflight results as values and falls back to reading the environment only for the destroy path.
- Until Alchemy publishes a version containing the API, Composer depends on the preview tarball URL and cuts no release.

## Project DoD

- `prisma deploy` and `prisma dev` start no Alchemy child process and write no `alchemy.run.ts`.
- E2E deploy workflow (`.github/workflows/e2e-deploy.yml`) and the local-dev integration tests pass on the branch tip.
- A new ADR supersedes ADR-0007 for deploy and dev; `deploy-cli.md` describes the in-process path.
- Ctrl-C during a real deploy exits 130 and a second deploy to the same environment does not wait for the lease to expire (manual QA).

## Open questions

- Interactive sessions (`prisma login`, no `PRISMA_SERVICE_TOKEN` in the environment): how the credential reaches Alchemy in-process. See design-notes.md § Credentials.

## References

- `wip/alchemy/website/src/content/docs/cli/api.mdx`, `wip/alchemy/packages/alchemy/src/Alchemist/`
- `packages/0-framework/3-tooling/cli/src/{run-alchemy,alchemy-bin,generate-stack,deployment-summary}.ts`, `family/converge.ts`, `operations/execute-deploy-destroy.ts`, `operations/execute-dev.ts`
- `packages/0-framework/1-core/core/src/control/deploy.ts` (`lower()`)

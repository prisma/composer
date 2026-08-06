# ADR-0043: `@prisma/composer/control` is the programmatic deploy surface

## Decision

The deploy pipeline is drivable in-process through a published subpath, **`@prisma/composer/control`**: four typed operations — `deploy`, `destroy`, `dev`, `log` — with structured inputs and results, no argv, no console output, no `process.exit`. The `prisma-composer` CLI (`main.ts`, `run-dev.ts`, `run-log.ts`) is a thin renderer over these operations, so the two surfaces cannot drift. The implementation lives in `@internal/cli`'s `src/operations/`, re-exported per ADR-0035 through `src/exports/control.ts` on `@internal/cli` and on `@prisma/composer` — no new workspace package, because the operations are an extraction of the CLI's own orchestration and only `packages/9-public/` publishes (ADR-0027/ADR-0028).

Two contracts anchor the surface:

1. **The `./control` entry's static import graph stays free of the alchemy-touching tree.** A mismatched `effect` in the consumer's tree crashes that tree *at import time* (TML-3158), so each operation first runs `checkEffectResolution(cwd)` — reported as a `{ kind: 'effect-resolution' }` failure result, not a crash — and only then dynamically imports its executor. Importing the subpath is safe even in a broken tree; `scripts/check-npm-effect-resolution.mjs`'s adversarial shape pins this against a real package-manager install.

2. **`DEPLOYMENT_RESULT_FILE_ENV` (`PRISMA_COMPOSER_DEPLOYMENT_RESULT_FILE`) carries the deploy result across the process boundary.** The `DeploymentResult` only materializes inside the spawned alchemy child (the generated stack file's `report:` hook, ADR-0007/ADR-0033), and `DeployedNode` holds the graph node itself, so it cannot cross processes. When the env var names a file, `deploymentReport` also writes a JSON **`DeploymentSummary`** there — the serializable projection (app + per-node `address`/`entities`). The deploy operation sets the variable on the child, removes any stale file before spawning, and reads the file back after exit 0. The summary is best-effort: an absent or malformed file yields `summary: undefined` on a still-successful deploy, never a failure.

The name `control` is deliberately the plane the CLI sources already occupy in `architecture.config.json`, matching the existing `/control` subpaths (`@prisma/composer/node/control`, `/nextjs/control`, `@prisma/composer-prisma-cloud/control`). It is a different consumer class from an *extension's* `/control` entry (ADR-0017: control-plane descriptors importable only from `prisma-composer.config.ts`); the shim's doc comment records the distinction.

## Reasoning

- `@internal/assemble` was extracted with "the future programmatic deploy API" named as its second consumer (deploy-cli.md § Contracts); this ADR is that consumer landing. A host embedding Composer (the unified `prisma` CLI) needs results it can branch on, not stdout to scrape.
- The CLI consuming the operations is the proof of faithfulness: the extraction moved `main.ts`'s orchestration verbatim, and the CLI's behavior-pinning suite (`run.test.ts`) passes unmodified against the re-pointed commands.
- A file named by an env var is the narrowest cross-process channel that survives `stdio: 'inherit'` (kept — the alchemy child's own output still streams to the host's terminal; capturing it is out of scope here). The file lives under the already-tool-owned `.prisma-composer/` directory (ADR-0004).

## Consequences

- Structured failures are coarse for now: one `pipeline` kind spans everything between config discovery and the alchemy spawn. Finer-grained diagnostics are a follow-up slice; `invalid-input`, `unsupported`, `effect-resolution`, and `execution` (alchemy ran and failed, with exit code and reproduce command) are already distinct.
- `dev` returns a session handle (`endpoints`, `stop()`, `closed`) and **never touches process signal handlers** — signal ownership (including evicting alchemy's import-time listeners) stays with the host, as the CLI adapter demonstrates.
- `log` returns the running services plus an `AsyncIterable` of lines ended by a caller-owned `AbortSignal`; per-stream failures surface as events without ending the other streams.
- Writers of the report hook and readers of the result file share one shape (`DeploymentSummary` in `render-deployment.ts`); changing it is a cross-process protocol change and must stay backward-tolerant (the reader treats anything unrecognizable as absent).

## Alternatives considered

- **A new workspace package for the operations.** Rejected: everything the operations need already lives in `@internal/cli`, and ADR-0027/ADR-0028 make `packages/9-public/` the only publishable location — a new internal package would add a boundary with nothing on the other side.
- **Naming the subpath `./operations` or `./pilot`.** Rejected in favor of the plane name the sources already carry; the collision with extension `/control` entries is a documentation problem, not a naming-precision one.
- **Parsing the summary from the child's stdout.** Rejected: stdout is `inherit` (the user watches alchemy work), and scraping it would couple the protocol to presentation.
- **Failing the deploy when the result file is missing after exit 0.** Rejected: whether alchemy re-runs the report hook on a no-op converge is not guaranteed, and a summary is a convenience — a deploy that converged must not be reported as failed for lacking one.

## Related

- [ADR-0007](ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md) — the spawned child the env var contract crosses into.
- [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md) — the *other* `/control`: extension control-plane entries.
- [ADR-0027](ADR-0027-two-packages-compose-and-compose-prisma-cloud.md) / [ADR-0028](ADR-0028-numbered-domains-and-layers-enforced-by-dependency-cruiser.md) — why no new package, and where publishable code lives.
- [ADR-0033](ADR-0033-lowering-types-are-defined-by-their-readers.md) — the result/render split the summary projection extends across the process boundary.
- [ADR-0035](ADR-0035-public-entrypoints-live-in-src-exports.md) — the `src/exports/` shim pattern both new entries follow.

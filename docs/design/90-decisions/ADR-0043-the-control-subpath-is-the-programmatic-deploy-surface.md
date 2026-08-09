# ADR-0043: `@prisma/composer/control` is the programmatic deploy surface

## Decision

Composer's deploy pipeline is drivable in-process through one published subpath, **`@prisma/composer/control`**. It exposes four typed operations — `deploy`, `destroy`, `dev`, `log` — that take structured inputs and return structured results. They never parse argv and never call `process.exit`; the operations print nothing — the spawned alchemy child streams its own output to the terminal. The `prisma-composer` CLI is a thin renderer over these same operations, so the command-line surface and the programmatic surface cannot drift apart.

A host — another CLI embedding Composer, a CI tool, a test — uses it like this:

```ts
import { deploy } from '@prisma/composer/control';

const result = await deploy({ entry: 'module.ts', stage: 'feat-auth' });

if (result.ok) {
  for (const node of result.value.summary?.nodes ?? []) {
    console.log(node.address, node.entities);
  }
} else {
  switch (result.failure.code) {
    case 'DEPLOY.STAGE_INVALID': // e.g. a stage name git would reject
    case 'ASSEMBLE.BUILD_FAILED': // the app's built output is missing
    case 'DEPLOY.ENGINE_FAILED': // alchemy ran and exited nonzero
      report(result.failure.message);
  }
}
```

Failures are values, not exceptions, on the shared `Result` shape
(`{ ok: true, value } | { ok: false, failure }`): every way a deploy can go
wrong comes back as a `CliStructuredError` — the dotted `code` is the
branching surface (ADR-0044's closed registry), `message`/`why`/`fix` carry
the same guidance the CLI renders, and the original error rides as `cause`. A
non-structured error escaping an operation is by definition a bug and rejects
the returned promise rather than being laundered into a coded failure. An
engine failure additionally carries `meta.diagnostics` (exit code, generated
stack-file path, reproduce command, cwd), read via the exported
`executionDiagnostics()` helper — details of the current execution mechanism,
useful for printing a hint but deliberately outside the durable contract.

## Why a programmatic surface

`@internal/assemble` is deliberately CLI-free — its design names a programmatic deploy API as its second consumer, alongside the CLI ([deploy-cli.md § Contracts](../10-domains/deploy-cli.md)). A program embedding Composer needs results it can branch on, not stdout to scrape: subprocess invocation couples the caller to output formatting, loses error types, and turns every failure into string parsing. `@prisma/composer/control` is that second consumer surface.

Because the CLI's commands are renderers over the same operations, there is exactly one implementation of deploy orchestration. A fix or feature in the operation is a fix or feature in both surfaces; neither can gain behavior the other lacks.

## Importing the subpath executes nothing

The `./control` entry's static import graph is import-light: types, the result definitions, and two small helpers. Each operation lazily `import()`s the executor that reaches the pipeline and alchemy, so importing the subpath executes nothing — consistent with the repo's no-import-side-effects stance — and a host pays for the deploy stack only when it calls an operation. The property is pinned structurally: a test imports the entry in a fresh process with every heavy module poisoned and fails if the static graph ever reaches one.

A dependency tree that cannot load that stack — for example, a mismatched `effect` version that makes alchemy's modules throw at import time — surfaces when an operation runs, as a structured failure whose code names the problem: each executor-loading operation runs the effect-resolution preflight at dispatch, before importing anything heavy, and returns `DEPS.EFFECT_VERSION_CONFLICT` when it recognizes the tree; an executor import that still fails past the preflight comes back as `DEPS.EXECUTOR_UNLOADABLE`. The host stays alive and gets a result it can branch on, never an import-time crash — and the CLI, a renderer over these operations, inherits the same behavior (commands that load no executor, like `--help`, work even in a broken tree).

## The deploy result crosses a process boundary

Deploy execution happens in a **spawned alchemy child process** driving a generated stack file (ADR-0007). The full `DeploymentResult` only materializes inside that child, in the stack file's `report:` hook — and its `DeployedNode` entries hold live references to the graph nodes themselves, which cannot be serialized across processes (ADR-0033 defines the type for in-process readers).

The operation therefore uses the narrowest channel that works:

- `deployment-summary.ts` owns the protocol whole: **`DeploymentSummary`** — the serializable projection of a result (the app name and, per node, its `address` and deployed `entities`) — plus the env var, the writer, and the reader.
- When the environment variable `PRISMA_COMPOSER_DEPLOYMENT_RESULT_FILE` names a file, the report hook writes the summary there as JSON (best-effort — a write failure never fails a converged deploy), in addition to its normal console rendering. The variable is internal to the two halves; it is not exported from `./control`.
- The deploy operation points that variable at a file whose name is unique per run — concurrent deploys sharing a working directory cannot read or delete each other's summary — reads it back after a zero exit, and deletes it.

The child's own stdout/stderr still stream to the host's terminal (`stdio: 'inherit'`) — the user watches alchemy work exactly as they would from the CLI, and the result file rides alongside rather than being scraped out of that stream. The file lives under the tool-owned `.prisma-composer/` directory (ADR-0004).

The summary is **best-effort by contract**: an absent or unparseable file yields `summary: undefined` on a deploy that still reports `outcome: 'deployed'`. A deploy that converged is never reported as failed for lacking a convenience payload. Writer and reader share the one `DeploymentSummary` shape; changing it is a cross-process protocol change and must stay backward-tolerant — the reader treats anything unrecognizable as absent.

## Where the code lives, and the name

The operations live in `@internal/cli` (`src/operations/`), re-exported through `src/exports/control.ts` shims on both `@internal/cli` and `@prisma/composer` (the ADR-0035 entrypoint pattern). There is no new workspace package: the operations orchestrate the same pipeline modules the CLI uses, and only `packages/9-public/` publishes (ADR-0027/ADR-0028), so a separate internal package would add a boundary with nothing on the other side.

The subpath is named `control` because that is the architecture plane these sources occupy in `architecture.config.json`, matching the existing control-plane subpaths (`@prisma/composer/node/control`, `/nextjs/control`, `@prisma/composer-prisma-cloud/control`). Note the distinct consumer classes: an *extension's* `/control` entry is a control-plane descriptor importable only from `prisma-composer.config.ts` (ADR-0017), while `@prisma/composer/control` is for external hosts. The shim's doc comment records the distinction.

## Consequences

- **The failure taxonomy is ADR-0044's closed code registry.** Callers branch on `failure.code`; a coarse "which stage failed" view is derivable from the code's namespace prefix (`CONFIG`/`COMPOSE`/`ASSEMBLE` load the stack, `DEPLOY`/`DEV`/`LOG` execute it, `DEPS` is the installed tree). `meta.diagnostics` carries the engine-failure mechanism details. A `Result` is in-process only (frozen, getter-backed) — it is not JSON-serializable; serialize `failure.toEnvelope()` when a failure must cross a process boundary.
- **`dev` returns a session handle** (`endpoints`, `stop()`, `closed`, an event callback) and **never touches process signal handlers**. Signal ownership — including evicting alchemy's import-time SIGINT/SIGTERM listeners — belongs to the host; the CLI adapter shows the pattern.
- **`log` returns the running services plus an `AsyncIterable` of lines** ended by a caller-owned `AbortSignal`; one stream failing surfaces as an event without ending the others. Zero running services is a valid, non-failure result with an already-finished iterable.
- **The alchemy child's output is not capturable through this API.** The current mechanism streams the deploy engine's output to the host's own stdio; capturing or redirecting it needs a new option on the operations, not a workaround. The mechanism itself (a spawned child, `stdio: 'inherit'`) is how composer deploys today, not a promise the surface makes — which is also why the spawn-shaped failure fields live in the optional `diagnostics` object rather than on the failure itself.
- **`@internal/cli` now contains a surface that is not a CLI.** The package name is narrower than its contents: the operations are control-plane orchestration that the CLI also happens to render. That is the accepted cost of not creating a package with nothing on the other side of its boundary.

## Alternatives considered

- **A new workspace package for the operations.** Everything the operations need already lives in `@internal/cli`, and only `packages/9-public/` publishes — a new internal package would add a boundary with nothing on the other side.
- **Naming the subpath `./operations` or `./pilot`.** The plane name the sources already carry won; the overlap with extension `/control` entries is a documentation concern, not a naming-precision one, and the entry's doc comment resolves it.
- **Parsing the summary from the child's stdout.** Stdout is the user's live view of alchemy working; scraping it would couple the cross-process protocol to presentation strings.
- **Failing the deploy when the result file is missing after exit 0.** Whether the report hook runs on a no-op converge is not guaranteed, and the summary is a convenience — a converged deploy must not be reported as failed for lacking one.

## Related

- [ADR-0007](ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md) — the spawned child the result-file contract crosses into.
- [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md) — the *other* `/control`: extension control-plane entries.
- [ADR-0027](ADR-0027-two-packages-compose-and-compose-prisma-cloud.md) / [ADR-0028](ADR-0028-numbered-domains-and-layers-enforced-by-dependency-cruiser.md) — why no new package, and where publishable code lives.
- [ADR-0033](ADR-0033-lowering-types-are-defined-by-their-readers.md) — the result/render split the summary projection extends across the process boundary.
- [ADR-0035](ADR-0035-public-entrypoints-live-in-src-exports.md) — the `src/exports/` shim pattern both new entries follow.

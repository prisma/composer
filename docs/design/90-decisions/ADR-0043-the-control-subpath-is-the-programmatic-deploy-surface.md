# ADR-0043: `@prisma/composer/control` is the programmatic deploy surface

## Decision

Composer's deploy pipeline is drivable in-process through one published subpath, **`@prisma/composer/control`**. It exposes four typed operations — `deploy`, `destroy`, `dev`, `log` — that take structured inputs and return structured results. They never parse argv, never print to the console, and never call `process.exit`. The `prisma-composer` CLI is a thin renderer over these same operations, so the command-line surface and the programmatic surface cannot drift apart.

A host — another CLI embedding Composer, a CI tool, a test — uses it like this:

```ts
import { deploy } from '@prisma/composer/control';

const result = await deploy({ entry: 'module.ts', stage: 'feat-auth' });

if (result.outcome === 'deployed') {
  for (const node of result.summary?.nodes ?? []) {
    console.log(node.address, node.entities);
  }
} else {
  switch (result.failure.kind) {
    case 'effect-resolution': // the app's dependency tree can't load alchemy safely
    case 'invalid-input':     // e.g. a stage name git would reject
    case 'pipeline':          // config discovery through assembly failed
    case 'execution':         // alchemy ran and exited nonzero
      report(result.failure.message);
  }
}
```

Failures are values, not exceptions: every way a deploy can go wrong comes back as a discriminated `failure` the caller can branch on, carrying the same human-readable message the CLI prints plus, where it exists, machine-usable context (the alchemy exit code, the generated stack-file path, the exact command to reproduce the run).

## Why a programmatic surface

`@internal/assemble` is deliberately CLI-free — its design names a programmatic deploy API as its second consumer, alongside the CLI ([deploy-cli.md § Contracts](../10-domains/deploy-cli.md)). A program embedding Composer needs results it can branch on, not stdout to scrape: subprocess invocation couples the caller to output formatting, loses error types, and turns every failure into string parsing. `@prisma/composer/control` is that second consumer surface.

Because the CLI's commands are renderers over the same operations, there is exactly one implementation of deploy orchestration. A fix or feature in the operation is a fix or feature in both surfaces; neither can gain behavior the other lacks.

## Importing the subpath is always safe

Composer executes deploys through [alchemy](https://alchemy.run), whose module tree depends on `effect`. When the app's `node_modules` resolves a mismatched `effect` version, alchemy's modules **throw at import time** — before any function is called. A naive API module that statically imported the pipeline would therefore crash the host process the moment the host imported it, even if the host never called an operation.

The `./control` entry defends against this structurally:

1. Its **static import graph contains no alchemy-reachable module** — only types, the resolution checker, and the result definitions. Importing the subpath executes nothing dangerous, even inside a broken tree. An adversarial fixture in `scripts/check-npm-effect-resolution.mjs` pins this against a real package-manager install: importing `@prisma/composer/control` from a tree with a seeded `effect` mismatch must succeed.
2. Each operation first runs `checkEffectResolution(cwd)` against the **target app's** directory (not the host's own), and reports a mismatch as a `{ kind: 'effect-resolution' }` failure result. Only after the check passes does it dynamically `import()` the executor that reaches the pipeline and alchemy.

So a broken app tree yields a structured failure from a live, functioning host — never an import-time crash.

## The deploy result crosses a process boundary

Deploy execution happens in a **spawned alchemy child process** driving a generated stack file (ADR-0007). The full `DeploymentResult` only materializes inside that child, in the stack file's `report:` hook — and its `DeployedNode` entries hold live references to the graph nodes themselves, which cannot be serialized across processes (ADR-0033 defines the type for in-process readers).

The operation therefore uses the narrowest channel that works:

- `render-deployment.ts` defines **`DeploymentSummary`** — the serializable projection of a result: the app name and, per node, its `address` and deployed `entities`.
- When the environment variable **`PRISMA_COMPOSER_DEPLOYMENT_RESULT_FILE`** names a file, the report hook writes the summary there as JSON, in addition to its normal console rendering.
- The deploy operation sets that variable on the child, removes any stale file before spawning, and reads the file back after a zero exit.

The child's own stdout/stderr still stream to the host's terminal (`stdio: 'inherit'`) — the user watches alchemy work exactly as they would from the CLI, and the result file rides alongside rather than being scraped out of that stream. The file lives under the tool-owned `.prisma-composer/` directory (ADR-0004).

The summary is **best-effort by contract**: an absent or unparseable file yields `summary: undefined` on a deploy that still reports `outcome: 'deployed'`. A deploy that converged is never reported as failed for lacking a convenience payload. Writer and reader share the one `DeploymentSummary` shape; changing it is a cross-process protocol change and must stay backward-tolerant — the reader treats anything unrecognizable as absent.

## Where the code lives, and the name

The operations live in `@internal/cli` (`src/operations/`), re-exported through `src/exports/control.ts` shims on both `@internal/cli` and `@prisma/composer` (the ADR-0035 entrypoint pattern). There is no new workspace package: the operations orchestrate the same pipeline modules the CLI uses, and only `packages/9-public/` publishes (ADR-0027/ADR-0028), so a separate internal package would add a boundary with nothing on the other side.

The subpath is named `control` because that is the architecture plane these sources occupy in `architecture.config.json`, matching the existing control-plane subpaths (`@prisma/composer/node/control`, `/nextjs/control`, `@prisma/composer-prisma-cloud/control`). Note the distinct consumer classes: an *extension's* `/control` entry is a control-plane descriptor importable only from `prisma-composer.config.ts` (ADR-0017), while `@prisma/composer/control` is for external hosts. The shim's doc comment records the distinction.

## Consequences

- **The failure taxonomy is deliberately coarse at the pipeline stage.** One `pipeline` kind spans everything from config discovery through assembly and container preparation; `effect-resolution`, `invalid-input`, `unsupported`, and `execution` are distinct. Callers needing to distinguish pipeline sub-failures must parse messages until a finer taxonomy exists.
- **`dev` returns a session handle** (`endpoints`, `stop()`, `closed`, an event callback) and **never touches process signal handlers**. Signal ownership — including evicting alchemy's import-time SIGINT/SIGTERM listeners — belongs to the host; the CLI adapter shows the pattern.
- **`log` returns the running services plus an `AsyncIterable` of lines** ended by a caller-owned `AbortSignal`; one stream failing surfaces as an event without ending the others. Zero running services is a valid, non-failure result with an already-finished iterable.
- **The alchemy child's output is not capturable through this API** — `stdio: 'inherit'` is part of the surface's contract. A host that must capture or redirect execution output needs a new option on the operations, not a workaround.

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

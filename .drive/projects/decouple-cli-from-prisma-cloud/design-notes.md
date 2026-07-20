# Design — Decouple CLI from Prisma Cloud

**Tracker:** https://linear.app/prisma-company/project/prisma-composer-decouple-cli-from-prisma-cloud-bf4f2b4b51f3
**Status:** settled with the operator 2026-07-20. Binding on implementers: no
interface, file placement, name, ordering, or error text below is open for
reinterpretation. If reality contradicts this document, stop and escalate.

## The problem

The framework domain (`packages/0-framework`) is defined as importing nothing
(`architecture.config.json`: `mayImportFrom: []`), but the deploy CLI knows
Prisma Cloud by name in four places, held together by one recorded exception
(`crossDomainExceptions`, `cli → lowering`, ~line 613):

1. `cli/src/ensure-containers.ts` imports `@internal/lowering` (a Prisma
   Cloud package) to resolve the app's Project and stage Branch before
   Alchemy runs, and to delete them after destroy.
2. `core/src/exports/app-config.ts` — the extension hook inputs (`PreflightInput`,
   `TeardownInput`) carry literal `projectId`/`branchId` fields.
3. `cli/src/run-alchemy.ts` sets `PRISMA_PROJECT_ID`/`PRISMA_BRANCH_ID` on
   the alchemy child process.
4. `cli/src/main.ts` orchestrates all of the above.

The project deletes that exception with `pnpm lint:deps` still passing, by
moving each behavior behind the extension interface. PR #113 already did
this once for state-database deletion (the `teardown` hook); this design
completes the pattern.

## Background you need (two facts)

**The two processes.** A deploy is two processes. The **CLI parent**
(`prisma-composer deploy <entry>`) loads `prisma-composer.config.ts`, builds
the graph, assembles bundles, and writes a generated stack file. It then
spawns the **alchemy child** (`alchemy deploy .prisma-composer/alchemy.run.ts`),
which *re-imports the config from scratch* and evaluates core's
`lower(app, config, opts)` to drive provisioning. Nothing crosses from
parent to child except argv and env. Today the parent resolves the
Project/Branch ids and passes them to the child as `PRISMA_PROJECT_ID`/
`PRISMA_BRANCH_ID`; the child's extension code and state layer read those
vars from `process.env`.

**Containers.** "Container" is the framework's word (deploy-cli.md § Stages
and containers) for the platform-side spaces an app deploys *into*, which
must exist before Alchemy runs and which Alchemy itself never creates or
destroys. For Prisma Cloud these are the app's **Project** and, for a named
stage, that stage's **Branch**. Containers must precede Alchemy because
Alchemy's own deploy state lives inside them (the state database on the
stage's Branch — ADR-0034).

## The design

Container lifecycle becomes an extension-supplied descriptor. The framework
orchestrates it blind: it calls the descriptor's operations, holds the
resolved product as an opaque value, hands the value back to the same
extension's other hooks, and carries it across the process boundary using
the extension's own serialization. Concretely, four moves:

1. `ExtensionDescriptor` gains an optional `container: ContainerDescriptor`
   — the container lifecycle (`ensure` / `locate` / `remove` /
   `deserialize`) as data + behavior the CLI looks up per extension, the
   same way it already looks up `preflight` and `teardown` (ADR-0017).
2. The product of resolution is a `ContainerInstance` the framework treats
   as opaque: core's type claims only `input` and `serialize()`; the owning
   extension narrows to its concrete type wherever it reads the instance
   back (the `ctx.application` idiom — ADR-0033, values are typed by their
   readers).
3. The parent→child transport is framework-owned but content-blind: the CLI
   writes each instance's `serialize()` output into one env var per
   extension (name derived from the extension id); in the child, core reads
   the var back and calls the same descriptor's `deserialize`. Extension
   code never touches `process.env` and never knows a process boundary
   exists — it receives its instance as a parameter everywhere.
4. The state store declaration names its owning extension
   (`StateDescriptor`), so core can inject that extension's container into
   state-layer creation — the last place that read the old env vars.

`PRISMA_PROJECT_ID` and `PRISMA_BRANCH_ID` cease to exist. The requirements
this satisfies, by number, are listed after the walkthroughs.

### The SPI

All four types are exported from
`packages/0-framework/1-core/core/src/exports/app-config.ts` beside
`ExtensionDescriptor`. (Amendment, D1: `ContainerDescriptor`,
`ContainerInstance`, and `LocateContainerInput` are *defined* in
`container-transport.ts` and re-exported through `app-config.ts` —
ADR-0028's plane rules forbid the shared-plane transport module from
importing control-plane types, which `pnpm lint:deps` enforces. The public
surface is unchanged.) The doc comments below are the deliverable comments
(edit for voice, not content):

```ts
export interface ExtensionDescriptor {
  // ... existing fields unchanged ...
  /**
   * The extension's container lifecycle, when its platform has containers.
   * The CLI resolves containers after assembly and before any stack file
   * or Alchemy run (deploy ensures, destroy locates); the product crosses
   * to the alchemy child via its own serialize/deserialize.
   */
  readonly container?: ContainerDescriptor;
}

/**
 * The platform containers an app deploys into, as one lifecycle. `I` is
 * the extension's own instance type — the same descriptor produces and
 * consumes it, so the generic is compiler-checked within the extension
 * (ADR-0033). METHOD SYNTAX REQUIRED on all four members: the erased
 * assignment into ExtensionDescriptor relies on method bivariance, exactly
 * as ServiceLowering<P, S> does.
 */
export interface ContainerDescriptor<I extends ContainerInstance = ContainerInstance> {
  /** Resolve the container for (appName, stage), creating anything absent. Called by `deploy`. */
  ensure(input: LocateContainerInput): Promise<I>;
  /** Find the container for (appName, stage); `undefined` when nothing exists. Called by `destroy` — never creates. */
  locate(input: LocateContainerInput): Promise<I | undefined>;
  /** Remove the container after a successful destroy, after every extension's `teardown` has run. Failure policy is the extension's. */
  remove(instance: I): Promise<void>;
  /** Reconstruct an instance from its own `serialize()` output — the far end of the framework's parent→child transport. */
  deserialize(serialized: string): I;
}

/** What the framework knows about the deploy target — the container lookup key. */
export interface LocateContainerInput {
  /** The application name (root node's name, or `--name`). */
  readonly appName: string;
  /** The named stage, or `undefined` for the default (production) stage. */
  readonly stage: string | undefined;
}

/**
 * One resolved container. Core's claim is minimal; the owning extension
 * narrows to its concrete type where it reads the instance back (ADR-0033).
 */
export interface ContainerInstance {
  readonly input: LocateContainerInput;
  /** Serialize to a non-empty string for the parent→child transport. The format is the extension's own; only its `deserialize` reads it. */
  serialize(): string;
}

/**
 * The deploy's one state store, naming its owning extension so core can
 * inject that extension's resolved container (amends ADR-0011/0017).
 */
export interface StateDescriptor {
  /** The owning extension's id — matched against `ExtensionDescriptor.id`. */
  readonly extension: string;
  /** Build the state layer. `container` is the owning extension's resolved instance; `undefined` when it declared no container descriptor. */
  create(container: ContainerInstance | undefined): AlchemyStateLayer;
}
```

`PrismaAppConfig.state` changes from `() => AlchemyStateLayer` to
`StateDescriptor`. `PreflightInput` and `TeardownInput` drop
`projectId`/`branchId` and gain the opaque instance:

```ts
export interface PreflightInput {
  readonly graph: Graph;
  /** The calling extension's own resolved container; `undefined` when it declares no container descriptor. Narrow with the extension's guard. */
  readonly container: ContainerInstance | undefined;
  readonly stage: string | undefined;
}

export interface TeardownInput {
  readonly container: ContainerInstance | undefined;
  readonly stage: string | undefined;
}
```

No other `ExtensionDescriptor` member changes.

### Deploy, start to finish

Parent (`cli/src/main.ts`), replacing today's step 7:

1. After `effectiveStage()` and before config loading:
   `if (stage !== undefined) validateStageName(stage)`. Stage-name
   validation (a valid git ref, via `git check-ref-format`) is the
   framework's own documented contract and stays in the CLI — it is
   platform-free and uniform across extensions.
2. Step 7 — for each `config.extensions` entry with a `container`
   descriptor, call `ensure({ appName: name, stage })` and hold the result
   in `Map<extensionId, ContainerInstance>`. Runs after assembly succeeds,
   so a deploy that cannot assemble never creates anything on any platform.
   Any throw aborts the command, wrapped in `CliError` exactly as the
   existing hook loops wrap.
3. Step 7.5 preflight — unchanged loop; each extension's input carries
   `container: containers.get(extension.id)`.
4. Step 9 — `runAlchemy` receives `containerEnv: containerEnv(containers)`
   (below) and merges it over the base env of the spawned child.

Transport (`packages/0-framework/1-core/core/src/container-transport.ts`,
new file, exported through the `@internal/core/config` barrel — both the CLI
and core's `lower()` import it):

```ts
/**
 * 'PRISMA_COMPOSER_CONTAINER_' + extensionId.toUpperCase()
 *   .replace(/[^A-Z0-9]+/g, '_') with leading/trailing '_' trimmed
 *   from the mangled id.
 * '@prisma/composer-prisma-cloud' →
 * 'PRISMA_COMPOSER_CONTAINER_PRISMA_COMPOSER_PRISMA_CLOUD'
 */
export function containerEnvVarName(extensionId: string): string;

/**
 * { [containerEnvVarName(id)]: instance.serialize() } for every resolved
 * instance. Throws Error naming BOTH extension ids when two ids mangle to
 * one var name; throws Error naming the extension id when serialize()
 * returns ''.
 */
export function containerEnv(
  instances: ReadonlyMap<string, ContainerInstance>,
): Record<string, string>;

/**
 * Child side: for each config extension with a container descriptor whose
 * var is present in `env`, call its deserialize. Absent var → no entry.
 */
export function deserializeContainers(
  extensions: readonly { id: string; container?: ContainerDescriptor }[],
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, ContainerInstance>;
// Amendment, D1: takes the extension list (structurally), not PrismaAppConfig —
// the transport module may not import the control-plane config type
// (ADR-0028 planes). Call sites pass `config.extensions`.
```

Both ends of the pipe are core code; the var naming is internal, never API.

Child (`packages/0-framework/1-core/core/src/exports/deploy.ts`):

1. `lower()` computes
   `const containers = deserializeContainers(config, process.env)` once.
2. `LowerContext` gains, beside `application`:
   `readonly container: ContainerInstance | undefined` — "the owning
   extension's resolved container, deserialized from the framework
   transport; core never reads it; the extension narrows it." Threaded
   into the application-hook context (`deploy.ts:561-573`) and every
   node's context (`deploy.ts:645` area) as
   `containers.get(<that extension's id>)`.
3. `resolveStateLayer(opts, config)` becomes
   `resolveStateLayer(opts, config, containers)`:
   `opts.state ?? config.state.create(containers.get(config.state.extension))`.
   `LowerOptions.state` (the explicit test override) keeps its current type
   and precedence.

### Destroy, start to finish

Same parent pipeline with three differences:

1. Step 7 calls `locate` instead of `ensure`. `undefined` means nothing to
   destroy; the CLI throws its own platform-free
   `CliError('Nothing deployed for <name>[/<stage>] — deploy it first.')`
   (today's phrasing, moved up from `ensure-containers.ts:71`).
2. After the alchemy child exits 0 and after the whole teardown loop, a new
   remove loop: for each extension with both a descriptor and a resolved
   instance, `await extension.container.remove(instance)`, throw-wrapped in
   `CliError` like every hook loop. The CLI's two-loop order — all
   teardowns, then all removes — is what structurally preserves ADR-0034's
   guarantee that a stage's state database is deleted before its Branch
   (a Branch with an attached database refuses deletion).
3. Removal policy lives in the extension: named stage → Branch deletion
   failures throw; production → Project removal stays best-effort
   (warn, never fail the command). Same policy as today, relocated.

Find-only destroy, never-deleted production Branch, and container-before-
Alchemy ordering (ADR-0024) are all unchanged behavior.

### The Prisma Cloud implementation

New file `packages/1-prisma-cloud/1-extensions/target/src/container.ts`
(control plane; imported only by `control.ts` and the hook modules). All
Management-API logic transplants from the deleted `ensure-containers.ts` —
same Effect wiring, same error texts (table below):

```ts
export class PrismaCloudContainer implements ContainerInstance {
  constructor(
    readonly input: LocateContainerInput,
    readonly projectId: string,
    readonly branchId: string | undefined,
  ) {}
  serialize(): string {
    return JSON.stringify({
      input: this.input,
      projectId: this.projectId,
      ...(this.branchId !== undefined ? { branchId: this.branchId } : {}),
    });
  }
}

export function isPrismaCloudContainer(value: unknown): value is PrismaCloudContainer;
// instanceof check — parent-side instances and child-side deserialized
// instances are both constructed by this module.

/**
 * Narrow-or-throw for hook inputs. Error text: "the Prisma Cloud container
 * was not resolved — the extension's container descriptor did not run."
 */
export function prismaCloudContainerOf(value: ContainerInstance | undefined): PrismaCloudContainer;

export function containerDescriptor(
  deps?: { readonly client?: ManagementApiClient },
): ContainerDescriptor<PrismaCloudContainer>;
```

`containerDescriptor` behavior:

- `ensure(input)` — require `PRISMA_WORKSPACE_ID` and (when no injected
  client) `PRISMA_SERVICE_TOKEN`; run
  `resolveContainer({ workspaceId, appName, stage?, ensure: true })`;
  return `new PrismaCloudContainer(input, projectId, branchId)`.
- `locate(input)` — same env checks, `ensure: false`;
  `ContainerNotFoundError` → `undefined` (the CLI owns the user-facing
  error); `PrismaApiError` → the resolving-containers message.
- `remove(instance)` — `instance.input.stage !== undefined` → the
  `deleteStageBranch` path verbatim (throws on failure); default stage →
  the `deleteAppProject` path verbatim (best-effort console outcomes,
  never throws). Texts identical to `ensure-containers.ts:130-162`.
- `deserialize(str)` — `JSON.parse`; validate the shape with real narrowing
  (object; `input.appName` string; `input.stage` string-or-absent;
  `projectId` string; `branchId` string-or-absent) — invalid payloads throw
  an `Error` naming the extension and "container transport payload";
  return a `PrismaCloudContainer`. No casts.

Errors here are plain `Error`s; `CliError` is a CLI concept the extension
must not import.

Rewiring in `target/src/`:

- `control.ts` — `resolveOptions` deletes the `PRISMA_PROJECT_ID`/
  `PRISMA_BRANCH_ID` reads; `ResolvedCloudOptions` loses
  `projectId`/`branchId`; the returned descriptor gains
  `container: containerDescriptor()`; `application.provision` reads
  `const { projectId, branchId } = prismaCloudContainerOf(ctx.container)`
  and returns `{ projectId, branchId } satisfies CloudApplication`.
  Introduce one shared const for the extension-id string; use it for both
  `id:` and `prismaState`.
- `preflight.ts` / `teardown.ts` — destructure
  `prismaCloudContainerOf(input.container)` at the top; everything
  downstream unchanged.
- `lowering/src/state/layer.ts` — `prismaState` renamed `prismaStateLayer`,
  taking `(ids: { readonly projectId: string; readonly branchId?: string })`;
  its env reads and "PRISMA_PROJECT_ID is required" throw are deleted.
  `control.ts` exports the user-facing descriptor:

```ts
export const prismaState = (): StateDescriptor => ({
  extension: PRISMA_CLOUD_EXTENSION_ID,
  create: (container) => {
    const { projectId, branchId } = prismaCloudContainerOf(container);
    return prismaStateLayer(branchId !== undefined ? { projectId, branchId } : { projectId });
  },
});
```

### Requirements satisfied

| Requirement | Satisfied by |
| --- | --- |
| No `@internal/lowering` import, no Prisma Cloud vocabulary in `0-framework` (exit criterion) | `ensure-containers.ts` deleted; hook inputs opaque; transport vars in the framework's own `PRISMA_COMPOSER_*` namespace |
| Core never types another domain's values (ADR-0033) | `ContainerInstance` claims only `input` + `serialize`; generic `I` stays inside the extension; guards at every cross-party read |
| No globals; dependencies injected (architectural principles) | instance arrives as a parameter everywhere: hook inputs, `ctx.container`, `StateDescriptor.create`; zero extension-side env reads for deploy identity |
| Behavior preservation | same operations, same ordering, same error texts (table below), relocated not rewritten |
| ADR-0024 ordering (containers before Alchemy; nothing created if assembly fails) | step-7 position unchanged |
| ADR-0034 ordering (state DB before Branch) | CLI's teardown-loop-then-remove-loop sequence |
| Successor pinned/no-create mode expressible later | lives entirely inside the extension's `ensure`/`locate`; no interface change needed |
| No privileged platform (ADR-0017) | per-extension descriptor + per-extension context; any extension may supply one |

## Change inventory

### Slice 1 — prep, prisma-cloud-internal, behavior-invariant

Goal: exactly one extension site reads deploy identity, so slice 2 swaps
one site to `ctx.container`.

- `descriptors/shared.ts`: `CloudApplication` becomes
  `{ readonly projectId: string; readonly branchId: string | undefined }`;
  `isCloudApplication` accepts the new field; add
  `cloudApplicationOf(application: unknown): CloudApplication` (guard +
  named error, same style as `projectIdOf`); `projectIdOf` delegates to it.
- `control.ts` `application.provision` returns
  `{ projectId, branchId: o.branchId } satisfies CloudApplication`.
- Replace every descriptor read of `o.branchId` with
  `cloudApplicationOf(ctx.application).branchId`: `postgres.ts:25`,
  `compute.ts:60,72,73`, `prisma-next.ts:29`. Afterward
  `grep -rn "o\.projectId\|o\.branchId" …/target/src/descriptors/` must be
  empty.
- `ResolvedCloudOptions` keeps its id fields in this slice (still env-fed).
- Tests updated only where they construct `CloudApplication` values.

### Slice 2 — the boundary move (one PR, with the ADR)

**Core** (`packages/0-framework/1-core/core/src/`):
- `app-config.ts`: the SPI above; `PreflightInput`/`TeardownInput` change;
  `PrismaAppConfig.state: StateDescriptor`.
- `container-transport.ts`: new, as specified.
- `deploy.ts`: `deserializeContainers` at `lower()` entry; `ctx.container`;
  `resolveStateLayer` third parameter.

**CLI** (`packages/0-framework/3-tooling/cli/src/`):
- Delete `ensure-containers.ts` and its test (logic moves per above; tests
  move per below).
- New `validate-stage.ts`: `validateStageName` verbatim
  (`ensure-containers.ts:22-36`), same `CliError` texts.
- `main.ts`: `RunDeps` drops `ensureContainers`/`deleteBranch`/
  `deleteProject` (tests stub via `deps.config` extensions); drop the
  `ResolvedContainer` import; stage validation call; step-7 ensure/locate
  loop; hook inputs; remove loop; `containerEnv` to `runAlchemy`.
- `run-alchemy.ts`: `RunAlchemyInput` drops `projectId`/`branchId`, gains
  `containerEnv: Readonly<Record<string, string>>`; spawn env
  `{ ...(input.env ?? process.env), ...input.containerEnv }`; the stale
  `fromEnv()` comment goes (verified false — `client.ts` never reads the
  id vars).
- `load-config.ts`: `state` validation becomes object-with-`extension`-and-
  `create`; error text `must be a state descriptor (e.g. prismaState())`.
- CLI `package.json`: remove the `@internal/lowering` dependency.

**Prisma Cloud** (`packages/1-prisma-cloud/`): as specified above
(`target/src/container.ts` new; `control.ts`, `preflight.ts`,
`teardown.ts`, `descriptors/shared.ts` comment, `lowering/src/state/layer.ts`).

**Config surface** — `state: () => prismaState()` → `state: prismaState()`
at all nine call sites (verified complete list; an earlier count of ten was
wrong):
`examples/{cron,env-param,pn-widgets,storage,store,storefront-auth,streams}/prisma-composer.config.ts`,
`website/prisma-composer.config.ts`,
`test/integration/prisma-composer.config.ts`, plus doc snippets (below).
Follow `.agents/rules/user-facing-surface-changes.mdc`.

**Lint config** — delete the `crossDomainExceptions` entry.

**Inherited debt** — delete `.drive/projects/state-under-branch/` (content
already migrated to `docs/` and Linear).

## Error surface (preserved verbatim)

| Failure | Text | Thrown by (after) |
| --- | --- | --- |
| Missing workspace id | `environment variable PRISMA_WORKSPACE_ID is required.` | extension `ensure`/`locate` |
| Missing token | `environment variable PRISMA_SERVICE_TOKEN is required.` | extension `ensure`/`locate` |
| Nothing to destroy | `Nothing deployed for <app>[/<stage>] — deploy it first.` | CLI, on `locate` → `undefined` |
| Management API failure | `Prisma Management API error resolving containers: <msg>.` | extension |
| Branch delete failure | `Failed to delete the stage Branch: <msg>.` | extension `remove` |
| Project removal outcomes | `Removed the Project…` / `Kept the Project…` / skip-warn | extension `remove` (console, never throws) |
| Invalid stage name | unchanged `validateStageName` texts | CLI |
| Container missing at read | `the Prisma Cloud container was not resolved — the extension's container descriptor did not run.` | extension guards |

## Tests

- **core** — `container-transport`: var-name mangling (including the exact
  `@prisma/composer-prisma-cloud` expectation), collision error,
  empty-serialize error, round trip through a stub instance. `deploy`:
  stub extension observes `ctx.container` as the deserialized instance;
  the state descriptor receives its own extension's instance; an extension
  without a descriptor sees `undefined`.
- **cli** — `main`/`run`: stub extensions assert ensure-on-deploy /
  locate-on-destroy with `{appName, stage}`; the not-found `CliError`
  text; hook-error wrapping; remove runs only on destroy, only after
  teardown, only on child exit 0; `containerEnv` reaches `runAlchemy`.
  `run-alchemy`: containerEnv merged over base env. `validate-stage`:
  moved cases unchanged.
- **target** — `container.test.ts`: ensure/locate/remove/deserialize
  against a fake `ManagementApiClient` (the moved `ensure-containers`
  cases + deserialize round trip + invalid-payload error). Preflight/
  teardown tests construct `PrismaCloudContainer` inputs.
  `control-lowering`/`invariants` tests stop stubbing id env vars and
  hand containers through context.
- **integration/e2e** — `test/integration` config updated. The e2e
  workflow needs no change: it sets only workspace id + token; the id
  vars were always CLI-internal (verified — no reader outside the changed
  packages).

Test names in plain English describing observable behavior.

## Docs shipped in the slice-2 PR (never separately)

- **New ADR** (claim the number at PR time — expect ~0035, check main):
  "Containers are an extension descriptor." Decision covers: the SPI, the
  opacity rule, the serialize/deserialize transport with core-owned var
  naming, `StateDescriptor` naming its owner, stage-name validation
  staying in the CLI, and the method-bivariance soundness note (the loop,
  not the compiler, guarantees `remove` receives what `ensure`/`locate`/
  `deserialize` produced — record it as ADR-0033 does). Alternatives:
  the section below, condensed. Update the ADR index README.
- `docs/design/10-domains/deploy-cli.md`: pipeline steps 6-7 and § Stages
  and containers rewritten so the framework side speaks only of the
  descriptor and the opaque transport; Prisma Cloud's Project/Branch
  mechanics become a short passage referencing ADR-0023/0024/0034;
  the § Id threading bullet and the env-var sentence under § CLI behavior
  notes go.
- `docs/design/10-domains/core-model.md:448` — state field shape.
- ADR-0017's config example — `state: prismaState()`.
- `docs/guides/getting-started.md:236`, `docs/guides/deploying.md:41`.
- Sweep: after the change,
  `git grep -n "PRISMA_PROJECT_ID\|PRISMA_BRANCH_ID\|ensure-containers\|ensureContainers\|() => prismaState" docs website examples README.md AGENTS.md gotchas.md`
  must return nothing.

## Lint/CI/process mechanics

- New files (`container-transport.ts`, `validate-stage.ts`,
  `target/src/container.ts`) must pass
  `scripts/lint-architecture-coverage.mjs`; they sit inside already-covered
  package globs — verify with `pnpm lint:deps`, don't assume. No new
  workspace subpaths → no `tsconfig.depcruise.json` edits expected; verify.
- Cast ratchet: no new bare `as`; `deserialize` uses real narrowing.
- Commits: bot identity, `-s` +
  `--trailer "Signed-off-by: Will Madden <madden@prisma.io>"`; push via the
  bot remote.
- Live proof before the slice-2 PR opens:
  `cp /Users/will/Projects/prisma/makerkit/.env .env`, `pnpm run deploy`
  (never bare `pnpm deploy`), then destroy; zero residue expected. A
  "Failed to identify your database" bootstrap error is an account-level
  restriction, not your bug — never delete a `prisma-composer-state`
  database. Clean up stranded Project/Branch after failed runs.

## Out of scope

- The pinned/no-create container mode for the successor GitHub App project
  — must remain expressible (it is: extension-internal), not built.
- Any change to `--name`/`--stage`/`--production` semantics.
- The in-flight fixes elsewhere (`postgres/Database.ts` stray-database
  window; `ci-cleanup-utils.ts` comment).

## Alternatives considered (rejected — do not resurrect)

- **One `resolve(command)` / `resolve(ensure)` operation** instead of
  `ensure`/`locate`. Rejected: "resolve a destroy command" reads as
  resolving commands; two named operations state the create-if-absent vs
  find-only split directly, and `locate → undefined` lets the CLI own a
  platform-free not-found error.
- **Env map as part of the resolution product** (`{ container, env }`).
  Rejected: env vars are not a property of a container — they were an
  accident of today's transport. Taxonomy stays clean: extension owns
  payload, framework owns the pipe.
- **Framework JSON-serializes the opaque value** instead of
  `serialize()`/`deserialize()` on the extension's types. Rejected: the
  extension owns its wire format (ADR-0019 precedent — the target owns
  config serialization), and core shouldn't introspect a value it's
  contracted to treat as opaque.
- **A child-side pull function** (`containerFor(extensionId)`) instead of
  injection. Rejected: it's a global lookup (banned by the architectural
  principles), and it would preserve import-time identity reads in the
  extension factory — deploy-cli.md already documents "ids at lowering
  time, not construction"; injection makes that structural.
- **One keyed env var for all extensions.** Rejected in favor of one var
  per extension (operator preference; simpler to inspect). The keyed map
  survives only as core's in-process bookkeeping.
- **Folding container removal into `teardown`.** Rejected: teardown
  (PR #113) stays as-is; ensure/locate/remove is one lifecycle on one
  descriptor, and the CLI's two-loop order enforces state-before-Branch
  deletion structurally instead of per-extension convention.
- **Extension-supplied stage-name validation.** Rejected: git-ref validity
  is the framework's own stage contract, platform-free, and uniform;
  per-extension validation would fragment the error surface.

## Amendments log (I12)

- **D1/1 — type placement + transport signature** (recorded inline above):
  plane rules moved the three container types into `container-transport.ts`
  (re-exported via `app-config.ts`); `deserializeContainers` takes the
  extension list structurally. Trigger: `pnpm lint:deps` plane violation.
- **D1/2 — core env invariant names one exception.**
  `core/src/__tests__/invariants.test.ts` asserted `process.env` appears
  nowhere in core's shipped source; the design's child-side
  `deserializeContainers(config.extensions, process.env)` in
  `exports/deploy.ts` requires it. The invariant now allows exactly that
  file, reading only the framework's own `PRISMA_COMPOSER_CONTAINER_*`
  transport vars. The ADR (D2) must state this.
- **D1/3 — nine config call sites, not ten** (corrected inline above).

# The deploy CLI (`prisma-composer`)

Prisma Composer's own deploy entrypoint: what the `prisma-composer`
command does, the contracts it introduces, and what stays out of its scope.
The decisions it
rests on are recorded in
[ADR-0003](../90-decisions/ADR-0003-deploy-derives-everything-from-the-root-node.md)
(the application derived from the root node),
[ADR-0004](../90-decisions/ADR-0004-paths-resolve-relative-to-the-authoring-file.md)
(every path is relative to the file that writes it),
[ADR-0005](../90-decisions/ADR-0005-users-build-the-framework-assembles.md)
(users build, the framework assembles),
[ADR-0006](../90-decisions/ADR-0006-every-node-is-named.md) (node names; the
root's name names the application),
[ADR-0007](../90-decisions/ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md)
(the generated stack file), and
[ADR-0008](../90-decisions/ADR-0008-wrapper-inlines-everything-except-runtime-builtins.md)
(wrapper inlining), and
[ADR-0017](../90-decisions/ADR-0017-control-plane-loads-through-the-app-config.md)
(control plane loads through `prisma-composer.config.ts`).

## Scope

Two commands:

- **`prisma-composer deploy <entry>`** — deploy the application whose root node is
  `entry`'s default export, to a stage (default: production).
- **`prisma-composer destroy <entry>`** — tear a stage down (same derivation,
  Alchemy destroy); the target stage is always explicit (see § Stages and
  containers).

Flags: `--name` (override the root's name — per-run ephemeral deploys in
shared workspaces), `--stage <name>` (target a named, isolated environment
instead of production), `--production` (destroy-only — explicitly target the
production environment). Nothing else. `prisma-composer build`, `prisma-composer
dev`, and topology emission are out of scope (see § Out of scope).

**Runtime.** The bin is runtime-agnostic — no bun-only APIs anywhere in the
CLI or assembly code — so it runs under both bun and node (≥ 22.18, where
type stripping imports the user's `.ts` entry natively). One inherent caveat:
an app whose service module imports bun APIs can only deploy under bun, since
loading the graph imports that module — the app's choice, not a CLI limit.

## The pipeline

`prisma-composer deploy` is one pass from a module path to a driven Alchemy stack:

1. **Import the entry module.** Its default export must be a node (service or
   Module). No marked root exists in the model — whatever you point the CLI at
   *is* the application, and the graph reachable from it is what deploys.
2. **Load.** Core's `Load` walks the graph. A service with an unwired
   dependency slot (one an enclosing Module normally wires to a provisioned
   producer) fails here, with an error naming the input and pointing at the
   composing Module. The deploy root must be a Module — a bare service is not
   independently deployable; the CLI errors naming the fix (wrap it:
   `module('name', ({ provision }) => { provision(...); })`).
3. **Load the config + validate coverage.** `prisma-composer.config.ts` — found by
   walking up from the deploy entry, loaded with c12, never imported by app
   code — supplies the extension registries and the deploy's one state store
   (ADR-0017). Every node's and build descriptor's `(extension, type)` must
   have a registry entry; a gap errors naming the extension to add to the
   config. Extension factories validate their own environment during config
   evaluation, erroring with the exact variable name — before any slow work.
4. **Resolve the name.** The root node's name (every node is named — ADR-0006),
   unless `--name` overrides it — CI's per-run ephemeral deploys use this so a
   name never collides with a standing demo.
5. **Assemble each service.** Look up the service's build descriptor in the
   registries — `extensions[build.extension].nodes[build.type].assemble` — and
   run it. The assembler resolves its `entry` (and any other path field)
   relative to `dirname(build.module)` — the authoring module the descriptor
   carries (ADR-0004) — no directory discovery of any kind. Assembly validates
   the user's built output exists (missing → "run your build" error; staleness
   is not detected) and produces a normalized bundle `{ dir, entry }`.
6. **Resolve the app's containers.** Resolved after assembly succeeds and
   before the stack is generated, so a deploy that cannot assemble never
   creates anything in Prisma Cloud. The CLI resolves two Prisma Cloud
   containers via the Management API: the app's **Project** — found by app
   name, oldest match adopted, created if none exist — and, for a named
   stage, that stage's **Branch** — found by `gitName` (the stage name),
   created if absent. The stage name must pass `git check-ref-format`; an
   invalid name fails outright, never silently normalized. The default stage
   (no `--stage`) resolves the Project only — no Branch, zero change to
   production. `destroy` resolves **find-only**: an absent Project or Branch
   fails with "nothing deployed for `<app>`[`/<stage>`]" rather than creating
   one. See § Stages and containers.
7. **Lower and drive.** Write the pipeline's results as a runnable stack
   module at `.prisma-composer/alchemy.run.ts` and drive the `alchemy` CLI against
   it (ADR-0007), setting `PRISMA_PROJECT_ID` (always) and `PRISMA_BRANCH_ID`
   (named stages only) on the `alchemy` child process — for both `deploy` and
   `destroy`, since `alchemy destroy` re-imports and re-evaluates the same
   stack, so its target reconstruction needs the same ids. The generated file
   and Alchemy's state live in the process's working directory — tool state
   lives where you run the tool, like any other CLI (ADR-0004).

The pass that assembles a service is the same pass that lowers it, so the
correlation between services and their built bundles never exists as
user-facing configuration — it is computed, written into the generated stack
file, and consumed in one motion.

## Stages and containers

An app deploys to a named **stage** — a deploy-time environment, never
authored in the topology (ADR-0024). `prisma-composer deploy` with no `--stage`
targets **production**, at the Project level; `--stage <name>` targets a
**named stage**, resolved to a Branch of the app's Project (ADR-0023).

- **Containers.** The app's **Project** and the stage's **Branch** are
  resolved before Alchemy runs (pipeline step 6) — Alchemy provisions only
  the resources *within* them; it never creates or destroys a container.
- **Id threading.** The resolved `projectId` (and, for a named stage,
  `branchId`) are set as `PRISMA_PROJECT_ID`/`PRISMA_BRANCH_ID` on the
  `alchemy` child process, for both `deploy` and `destroy`.
- **Targets read the ids at lowering time, not construction.** An extension is
  constructed twice: once when the CLI loads `prisma-composer.config.ts` in the
  parent — *before* the ids exist — and again in the alchemy child, where they
  are set. So an extension's constructor must tolerate the ids being absent;
  only its lowering hooks (which run in the child) may require them.
- **State rides the Branch.** Each stage's deploy state lives in a
  framework-owned `prisma-composer-state` database attached to the stage's
  Branch — production's on the Project's implicit default Branch
  ([ADR-0034](../90-decisions/ADR-0034-deploy-state-lives-in-the-stage-branch.md)).
  The state layer bootstraps it from the threaded ids; the default Branch is
  resolved read-only (`isDefault`), never created.
- **Destroy is explicit.** `prisma-composer destroy` requires `--stage <name>` or
  `--production`; a bare `destroy` is an error, so an omitted or mistyped
  stage can never silently tear down production. `destroy` resolves
  find-only (no container is ever created); after `alchemy destroy` removes
  a named stage's resources, the CLI removes the stage's state database
  (ownership-verified, never by name alone) and then soft-deletes its Branch.
  The production Branch is never deleted; destroying production removes the
  production state database before the best-effort Project removal. State is
  deleted **last among the stage's members and before its container**: destroy
  reads state, and the platform refuses to delete a Branch with live members.

See [ADR-0023](../90-decisions/ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md)
(App = one Project, Stage = Branch) and
[ADR-0024](../90-decisions/ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)
(stage resolution mechanics).

## Build ownership

Per ADR-0005, the CLI initiates no user builds. The contract is that built
output exists first — `turbo run build && prisma-composer deploy`, or whatever the
user's tooling does. Assembly *consumes* that output and applies the
framework's envelope:

- **The wrapper** (all kinds): the service module bundled to `main.mjs` with a
  fixed, internal bundler invocation — the framework's boot protocol, never
  exposed to users, never part of their build.
- **Framework normalization** (per kind): e.g. making a Next standalone tree
  self-contained (hoisted `node_modules`, static assets, `public/`, the
  runtime-autoinstall guard). Deterministic file-shuffling, not compilation.

The extension's `package()` descriptor SPI then wraps the assembled dir in its
platform envelope (bootstrap, manifest, deterministic tar), unchanged from the
current model.

## Contracts this introduces

One seam, uniform for every node kind — the **extension seam** (ADR-0017):
the app's `prisma-composer.config.ts` statically imports each extension's control
descriptor, and deploy tooling looks up control-plane behavior by the data
every node already carries:

- **Nodes are pure data.** A node carries `extension` (the extension's package
  name) and `type` (its node ID within it); a build *descriptor* carries the
  same pair plus its path fields (`{ extension, type, module, entry }` —
  where the user's build puts its output, never how to produce it; `entry`
  and any kind-specific path resolve relative to `dirname(module)`).
- **Registries route everything.** Services, resources, and build descriptors
  all resolve the same way: `extensions[x.extension].nodes[x.type]`. A
  community extension works with zero changes anywhere — the app imports its
  descriptor in the config. Heavy control-plane code lives only in `/control`
  entries, which nothing reachable from app code imports. The assemble entry's
  contract
  is `assemble({ build: descriptor }) → { dir, entry }`
  (`@prisma/composer/deploy`'s `AssembleInput`/`Bundle` — defined once there,
  imported by every adapter and by `@internal/assemble` itself).
- **`@internal/assemble`** owns the orchestration this seam drives: routing
  every service node in the loaded graph to its registry's assemble entry
  (one bundle per full address — the root is always a Module). The CLI is
  its first consumer; the future
  programmatic deploy API is its second — so its public surface carries no CLI
  concepts (no `CliError`, no argv/usage anything). It throws its own
  `AssembleError`; the CLI's `main.ts` maps it (the existing destroy-path
  wrapping already does, since `AssembleError extends Error`).

## Error surface

The CLI's quality lives in its errors; each failure names its fix:

| Failure | Error tells the user |
| --- | --- |
| Default export isn't a node | what the entry module must export |
| Deploy root isn't a Module | to wrap the service in a Module |
| Unwired dependency slot | which input, and to deploy the composing Module |
| Missing `prisma-composer.config.ts` | the expected filename, where the walk-up looked, and what it must export |
| Node `(extension, type)` not covered | the extension to add to `prisma-composer.config.ts` |
| Missing extension env | the exact variable(s) the extension factory needed |
| Built output missing | the expected path, and "run your build" |

## Out of scope (designed around)

- **`prisma-composer build`** — and with it any build-command convention or override.
- **`prisma-composer dev`** — the local loop.
- **Topology emission** — the serialized-topology artifact for agents/tooling;
  when it lands it must strip the machine-specific `build.module` (ADR-0004).
- **Config-file escape hatch** — a `prisma-composer.config.ts` may exist one day as
  the *optional* override for multi-target or heavily parameterized setups;
  never the standard path.
- **Freshness checks** — detecting stale (not just missing) built output.
- **Entry discovery** — the entry path is required; bare invocation errors
  with usage. A discovery convention (e.g. a `package.json` field) would be
  additive.

## CLI behavior notes

- `destroy` warns when `<cwd>/.alchemy` is missing or empty before invoking
  alchemy — the likely causes (wrong directory, nothing ever deployed) mean
  "nothing to do here", not an error; the warning makes the wrong-directory
  case visible instead of silently succeeding (see ADR-0004's state rule).
- `--stage` passes through to the `alchemy` invocation, which owns Alchemy's
  own stage/state semantics, alongside the resolved container ids
  (`PRISMA_PROJECT_ID`/`PRISMA_BRANCH_ID`, § Stages and containers); the
  generated stack file carries neither (ADR-0007).

## Known limitations

- **`destroy` requires built artifacts.** `prisma-composer destroy` evaluates the
  same stack program as deploy, and the pack's `package()` reads the
  assembled bundle — so the app must build before it can be torn down. The
  destroy-path error says exactly that. Whether Alchemy's destroy can run
  against placeholder bundles (skipping assembly) is an open follow-up; it
  needs a live-credential experiment.
- **Native addons don't survive wrapper inlining.** A service module
  importing a package with native bindings (`.node` files — better-sqlite3,
  sharp, …) gets its JS inlined but not the binary, failing at boot rather
  than at assemble. Detecting addon-bearing deps and failing loudly at
  assemble is a follow-up; until then, keep client factories to pure-JS
  drivers (or bun built-ins, which stay external).

## Related

- [`core-model.md`](core-model.md) — the lowering machinery the CLI drives;
  its Extension points section names this doc.
- [`../03-domain-model/core-and-targets.md`](../03-domain-model/core-and-targets.md)
  — the core/pack split the pack CLI seam extends.
- [`../90-decisions/`](../90-decisions/) — ADR-0003 … ADR-0006.
- [ADR-0023](../90-decisions/ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md)
  / [ADR-0024](../90-decisions/ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)
  — stage, Project, and Branch semantics (§ Stages and containers).

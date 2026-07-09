# The deploy CLI (`makerkit`)

The MakerKit-owned deploy entrypoint: what the `makerkit` command does, the
contracts it introduces, and what stays out of its scope. The decisions it
rests on are recorded in
[ADR-0003](../90-decisions/ADR-0003-deploy-derives-everything-from-the-root-node.md)
(no config file, everything derived from the root node),
[ADR-0004](../90-decisions/ADR-0004-paths-resolve-relative-to-the-authoring-file.md)
(every path is relative to the file that writes it),
[ADR-0005](../90-decisions/ADR-0005-users-build-makerkit-assembles.md) (users
build, MakerKit assembles),
[ADR-0006](../90-decisions/ADR-0006-every-node-is-named.md) (node names; the
root's name names the application),
[ADR-0007](../90-decisions/ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md)
(the generated stack file), and
[ADR-0008](../90-decisions/ADR-0008-wrapper-inlines-everything-except-runtime-builtins.md)
(wrapper inlining).

## Scope

Two commands:

- **`makerkit deploy <entry>`** — deploy the application whose root node is
  `entry`'s default export.
- **`makerkit destroy <entry>`** — tear it down (same derivation, Alchemy
  destroy).

Flags: `--name` (override the root's name — per-run ephemeral deploys in
shared workspaces), `--stage`. Nothing else. `makerkit build`, `makerkit dev`,
and topology emission are out of scope (see § Out of scope).

**Runtime.** The bin is runtime-agnostic — no bun-only APIs anywhere in the
CLI or assembly code — so it runs under both bun and node (≥ 22.18, where
type stripping imports the user's `.ts` entry natively). One inherent caveat:
an app whose service module imports bun APIs can only deploy under bun, since
loading the graph imports that module — the app's choice, not a CLI limit.

## The pipeline

`makerkit deploy` is one pass from a module path to a driven Alchemy stack:

1. **Import the entry module.** Its default export must be a node (service or
   hex). No marked root exists in the model — whatever you point the CLI at
   *is* the application, and the graph reachable from it is what deploys.
2. **Load.** Core's `Load` walks the graph. A service with an unwired
   connection input (one normally wired by an enclosing hex) fails here, with
   an error naming the input and pointing at the composing hex. The deploy
   root must be a hex — a bare service is not independently deployable; the
   CLI errors naming the fix (wrap it: `hex('name', (h) => h.provision(...))`).
3. **Infer the target.** Collect the pack package name each node carries.
   Exactly one pack must appear (mixed packs → error). Dynamically import that
   package's `/target` entry — resolved from the entry module's own file path,
   the same way node's own resolver would (no discovery of any kind) — and
   call its `fromEnv()` export, which reads its own environment variables and
   errors naming any missing one. Inference can't silently pick wrong:
   `lower()` routes every node type through the target's tables, and a
   mismatch is a `LowerError` naming the unknown type.
4. **Resolve the name.** The root node's name (every node is named — ADR-0006),
   unless `--name` overrides it — CI's per-run ephemeral deploys use this so a
   name never collides with a standing demo.
5. **Assemble each service.** Route by the build adapter's `kind` to that
   kind's assembly (see below); the adapter resolves its own `entry` (and any
   other path field) relative to `dirname(build.module)` — the authoring
   module the descriptor itself carries (ADR-0004) — no directory discovery of
   any kind. Assembly validates the user's built output exists (missing →
   "run your build" error; staleness is not detected) and produces a
   normalized bundle `{ dir, entry }`.
6. **Lower and drive.** Write the pipeline's results as a runnable stack
   module at `.makerkit/alchemy.run.ts` and drive the `alchemy` CLI against
   it (ADR-0007). The generated file and Alchemy's state live in the
   process's working directory — tool state lives where you run the tool,
   like any other CLI (ADR-0004).

The pass that assembles a service is the same pass that lowers it, so the
correlation between services and their built bundles never exists as
user-facing configuration — it is computed, written into the generated stack
file, and consumed in one motion.

## Build ownership

Per ADR-0005, the CLI initiates no user builds. The contract is that built
output exists first — `turbo run build && makerkit deploy`, or whatever the
user's tooling does. Assembly *consumes* that output and applies MakerKit's
envelope:

- **The wrapper** (all kinds): the service module bundled to `main.mjs` with a
  fixed, internal bundler invocation — MakerKit's boot protocol, never exposed
  to users, never part of their build.
- **Framework normalization** (per kind): e.g. making a Next standalone tree
  self-contained (hoisted `node_modules`, static assets, `public/`, the
  runtime-autoinstall guard). Deterministic file-shuffling, not compilation.

The target pack's `package()` then wraps the assembled dir in the target
envelope (bootstrap, manifest, deterministic tar), unchanged from the current
model.

## Contracts this introduces

Two new seams, both symmetric — both resolve a heavy, deploy-only module from
a package name the node/descriptor carries, entry-anchored, with zero CLI
changes for a new pack or adapter:

- **Pack CLI seam.** Every node carries its pack's package name, and the
  pack's `/target` entry exports `fromEnv(): Target`. This is how a community
  pack becomes deployable with zero CLI changes.
- **Assembler seam.** The build adapter *descriptor* stays pure data on the
  node (`{ kind, pack, module, entry }` — where the user's build puts its
  output, never how to produce it; `entry` and any kind-specific path resolve
  relative to `dirname(module)`). `pack` is the adapter's own package name,
  baked in by its factory (`node()` → `"@makerkit/node"`, `nextjs()` →
  `"@makerkit/nextjs"`) — the same uniform rule as a node's own `pack`
  (ADR-0003): a thing's `pack` names the package that gives it meaning.
  `@makerkit/assemble` resolves `${build.pack}/assemble` through the same
  entry-anchored resolver the pack seam uses (no hardcoded kind→package map),
  so a community build adapter works with zero changes anywhere. `kind` stays
  the descriptor's own discriminant; the resolved `/assemble` module validates
  it matches. The heavy assembly module never ships in a bundle. Its contract
  is `assemble({ build: descriptor }) → { dir, entry }`
  (`@makerkit/core/deploy`'s `AssembleInput`/`Bundle` — defined once there,
  imported by every adapter and by `@makerkit/assemble` itself).
- **`@makerkit/assemble`** owns the orchestration this seam drives: routing
  every service node in the loaded graph to its adapter's `/assemble` entry
  (one bundle per provision id — the root is always a hex) and the
  wrapper-inlining policy. The CLI is its first consumer; the future
  programmatic deploy API is its second — so its public surface carries no CLI
  concepts (no `CliError`, no argv/usage anything). It throws its own
  `AssembleError`; the CLI's `main.ts` maps it (the existing destroy-path
  wrapping already does, since `AssembleError extends Error`).

## Error surface

The CLI's quality lives in its errors; each failure names its fix:

| Failure | Error tells the user |
| --- | --- |
| Default export isn't a node | what the entry module must export |
| Deploy root isn't a hex | to wrap the service in a hex |
| Unwired connection input | which input, and to deploy the composing hex |
| Mixed packs in one graph | the packs found; one target per application |
| Missing target env | the exact variable(s) `fromEnv()` needed |
| Built output missing | the expected path, and "run your build" |
| Unresolvable pack/adapter subpath | the pack, the subpath, and to add/check the dependency (same resolver, pack or assembler seam) |

## Out of scope (designed around)

- **`makerkit build`** — and with it any build-command convention or override.
- **`makerkit dev`** — the local loop.
- **Topology emission** — the serialized-topology artifact for agents/tooling;
  when it lands it must strip the machine-specific `build.module` (ADR-0004).
- **Config-file escape hatch** — a `makerkit.config.ts` may exist one day as
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
- `--stage` passes through to the `alchemy` invocation, which owns stage
  semantics; the generated stack file carries no stage (ADR-0007).

## Known limitations

- **`destroy` requires built artifacts.** `makerkit destroy` evaluates the
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

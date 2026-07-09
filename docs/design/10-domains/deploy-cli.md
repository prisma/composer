# The deploy CLI (`makerkit`)

The MakerKit-owned deploy entrypoint: what the `makerkit` command does, the
contracts it introduces, and what stays out of its scope. This is the design
for the CLI MVP; the decisions it rests on are recorded in
[ADR-0003](../90-decisions/ADR-0003-deploy-derives-everything-from-the-root-node.md)
(no config file, everything derived from the root node),
[ADR-0004](../90-decisions/ADR-0004-service-nodes-carry-their-authoring-url.md)
(every path is relative to the file that writes it; the build adapter carries
the authoring module),
[ADR-0005](../90-decisions/ADR-0005-users-build-makerkit-assembles.md) (users
build, MakerKit assembles), and
[ADR-0006](../90-decisions/ADR-0006-every-node-is-named.md) (node names; the
root's name names the application).

## Scope

The MVP is two commands:

- **`makerkit deploy [entry]`** — deploy the application whose root node is
  `entry`'s default export.
- **`makerkit destroy [entry]`** — tear it down (same derivation, Alchemy
  destroy).

Flags: `--name` (override the root's name — CI's per-run ephemeral deploys),
`--stage`. Nothing else. `makerkit build`, `makerkit dev`, and topology
emission are explicitly out of scope (see § Deferred).

Acceptance for the MVP (met): both examples lost their `alchemy.run.ts` and
hand-rolled deploy scripts, replaced by `makerkit deploy` / `makerkit destroy`,
with the CI e2e green.

## The pipeline

`makerkit deploy` is one pass from a module path to a driven Alchemy stack:

1. **Import the entry module.** Its default export must be a node (service or
   hex). No marked root exists in the model — whatever you point the CLI at
   *is* the application, and the graph reachable from it is what deploys.
2. **Load.** Core's `Load` walks the graph. A service with an unwired
   connection input (one normally wired by an enclosing hex) fails here, with
   an error naming the input and pointing at the composing hex.
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
6. **Lower and drive.** Hand the root, the target, and the per-service
   assembled bundles to `lower()`; execute the resulting Alchemy stack
   (deploy or destroy) with state and stage options. `.makerkit/` and any
   Alchemy state are written in the process's own working directory — tool
   state lives where you run the tool, like any other CLI.

Step 5 is what made the interim `alchemy.run.ts` unnecessary: the pass that
runs assembly for a service is the same pass that lowers it, so the
hand-maintained `bundle`/`bundles` correlation map has nothing left to say.

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
  (one bundle for a service root, one per provision id for a hex root) and the
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
| Unwired connection input | which input, and to deploy the composing hex |
| Mixed packs in one graph | the packs found; one target per application |
| Missing target env | the exact variable(s) `fromEnv()` needed |
| Built output missing | the expected path, and "run your build" |
| Unresolvable pack/adapter subpath | the pack, the subpath, and to add/check the dependency (same resolver, pack or assembler seam) |

## Deferred (designed around, not built)

- **`makerkit build`** — and with it any build-command convention or override.
- **`makerkit dev`** — the local loop.
- **Topology emission** — the serialized-topology artifact for agents/tooling;
  when it lands it must strip the machine-specific `build.module` (ADR-0004).
- **Config-file escape hatch** — a `makerkit.config.ts` may return as the
  *optional* override for multi-target or heavily parameterized setups; never
  the standard path.
- **Freshness checks** — detecting stale (not just missing) built output.

## Implementation decisions

- **Runtime of the CLI binary: node + bun.** The bin is runtime-agnostic —
  no bun-only APIs in CLI or assembly code — so `npx makerkit` and
  `bunx makerkit` both work. Importing the user's `.ts` entry requires
  Node ≥ 22.18 (type stripping on by default); older Node users run under
  bun. An app whose *service module* imports bun APIs can only deploy under
  bun (Load imports that module) — the app's choice, not a CLI limit.
- **Driving Alchemy: generate a runnable stack file.** The CLI writes its
  computed correlation (assembled bundle dirs, name, stage) as a small,
  human-readable stack module at `.makerkit/alchemy.run.ts` (gitignored,
  regenerated every run), then shells to `alchemy deploy` / `alchemy destroy`
  against it. The file is the CLI's work product made inspectable: if a
  deploy misbehaves, running `alchemy deploy` on it directly bisects whose
  bug it is. Error output prints the file's path. This also avoids depending
  on the engine's programmatic entry at the pinned beta.
- **No default `entry`.** The path is required; bare invocation errors with
  usage. A discovery convention (e.g. a `package.json` field) can be added
  later without breaking anyone.
- **Argument parsing: clipanion.** Replaces a handrolled `parseArgs` — the
  same CLI framework prisma-next's own tooling CLI uses (see
  `migration-cli.ts`). `deploy`/`destroy` are clipanion `Command` classes with
  a required `<entry>` positional and `--name`/`--stage` options; clipanion's
  own arity checking rejects a trailing `--name`/`--stage` with no value and
  unknown flags as usage errors (closing a bug where the handrolled parser
  silently accepted them). `run()` still drives the pipeline itself against
  the parsed args — rather than clipanion's own `cli.run()` — so thrown errors
  reach `bin.ts` (and the `RunDeps` test seams) unchanged.
- **`destroy` warns on no local deploy state.** If `<cwd>/.alchemy` is missing
  or empty, `destroy` prints a warning before assembling or invoking alchemy —
  it does not fail, since the likely causes (wrong directory, nothing ever
  deployed) both mean "there is nothing to do here," not an error. CI's
  destroy-guard script already skips the CLI entirely when `.alchemy` is
  absent; this covers direct invocation and the "exists but empty" case the
  script doesn't check.
- **Wrapper inlining: everything except runtime built-ins.** The CLI has no
  config file, so per-app bundling knobs can't exist. The wrapper build
  inlines every import of the service module except `bun`, `bun:*`, and
  `node:*` (which the hosting runtime provides). Verified empirically: the
  assembler's explicit `external` wins over the catch-all `noExternal`, so
  runtime built-ins stay external even under the match-all rule; pure-JS deps
  (workspace packages, contract libraries like arktype) inline cleanly.
- **The `--stage` flag is alchemy's.** The generated stack file carries no
  stage; the CLI passes `--stage` through to the `alchemy` invocation, which
  owns stage semantics.

## Known limitations (MVP)

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

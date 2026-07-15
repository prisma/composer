# ADR-0005: Users build their app; the framework assembles deploy artifacts from built output

## Decision

The framework never initiates or configures a user's build. The contract is:
built output exists before `prisma-compose deploy` runs, produced by the user's
own tooling. Downstream of that boundary, the deploy artifact is the
framework's to manufacture however it likes: per-adapter-kind **assembly**
locates and validates the built output, applies the framework's envelope —
including bundling the internal boot wrapper — and hands a normalized bundle
to lowering.

Take a Next.js storefront. The author builds it the way every Next app is
built:

```sh
next build   # output: "standalone" → .next/standalone/…
```

Assembly does only **documented, deterministic** steps, never heuristics. Three
disciplines bound it — each was violated in the first real out-of-repo deploy:

- **No guessing.** No path arithmetic, no monorepo-depth inference, no absolute
  deploy-machine path baked into an artifact. When the framework needs the app's
  (possibly deep) location in a standalone tree, it **reads the build tool's own
  manifest** (`nextjs()` reads `.next/required-server-files.json`'s
  `relativeAppDir`) — it neither walks the tree nor computes the location from an
  assumed depth.
- **No laundering.** `node_modules` ships exactly as the build produced it. A
  symlinked (non-hoisted) `node_modules` is a **hard error** at package time,
  never dereferenced — the user's to fix (a hoisted linker: npm, or pnpm/bun
  `node-linker=hoisted`), because that same non-flat install also crashes a Next
  standalone server at boot.
- **Code boundary, not runtime.** A plain `node()` service relies on the Compute
  runtime's `bun` auto-install for the dynamic requires its bundler missed (e.g.
  `pg/lib/*`); a `nextjs()` artifact *disables* auto-install (its `sharp` /
  `@next/swc` optional deps would otherwise fetch linux binaries at boot and fill
  the disk). That opposite need is why the `bunfig.toml` toggle lives in the
  `nextjs()` adapter, not as a packager default.

Everything lands in a deploy-owned working dir keyed by the node's **graph
address** (`.prisma-compose/artifacts/<address>/`), never inside `node_modules`
or the user's build output: the user's tree under `bundle/`, the wrapper at the
root.

## Reasoning

The framework plays no part in that build step — not the bundler options, not the
framework version, not whether it ran via a package script or a monorepo
tool's task graph. What the framework does happens *after*: given the
standalone tree the build produced, assembly copies in the pieces Next leaves
out of it (static assets, `public/`, the hoisted `node_modules`), adds the
framework's own boot wrapper beside the server, and hands the
now-self-contained directory to the target pack for packaging. The author's
build and the framework's assembly touch the same files but never each other.

That line — user builds, the framework assembles — is the decision, and it is
drawn where it is because the two sides fail differently when entangled. On
the user's side sits a build system the framework could never own well: every
bundler option it mediated would become a support surface, every framework
upgrade a compatibility matrix, and monorepo tools already own build ordering
and caching better than a deploy tool ever will. The idiomatic monorepo flow
is a deploy task that depends on build tasks; without a monorepo tool it is
"run your build, then `prisma-compose deploy`". Either way the framework
consumes outputs; it does not produce them.

On the framework's side sits the deploy artifact, and holding that side
firmly is what keeps the user's side clean. The **boot wrapper** is the case
in point: the service module bundled to `main.mjs`, whose `run()` executes
before the app's entry — it resolves the service's serialized config from the
environment, stashes it, then imports the entry. The wrapper is essential to
the boot protocol and deliberately invisible: no app's build should be
complicated by it. Producing it does mean the framework runs a bundler
invocation of its own over the service module, but that is not entanglement
with the user's build system — the invocation is fixed, internal, and runs after the
user's own bundling is already done. The same holds for the framework
normalizations: copying files to make a standalone tree self-contained is
deterministic file-shuffling that belongs to the artifact, not to any
user-visible build step.

The discipline is not "do nothing to the tree" but "do only the documented,
deterministic thing, read the build tool's own record instead of guessing, and
reject anything that isn't a plain file." Guessing and laundering are the hazards
it rules out: inferring a monorepo depth breaks on the next layout, and
walking-and-dereferencing trees inherits every package manager's pathology and,
worse, opens a security hole —
a symlink escaping the repo (a compromised postinstall, or accident) would
silently package deploy-machine files (`~/.aws`, ssh keys) into the artifact,
and an absolute path baked into an artifact encodes the build machine's
filesystem into what ships.

Assembly's other job is validation. Built output missing at the descriptor's
declared location fails loudly — an error naming the resolved path and saying
"run your build" — before anything is provisioned.

## Consequences

- `prisma-compose deploy` has no build invocation: no build-command convention, no
  skip flags, no build-script discovery. That machinery only becomes a
  question if a separate build command ever exists.
- Missing outputs are detected; *stale* ones are not. Deploying a forgotten
  old build is possible; freshness checking would be an additive layer on the
  same contract.
- The build adapter descriptor declares *where* the user's build puts its
  output, never *how* to produce it.
- Any monorepo layout deploys — the app's deep location is found, not assumed;
  a non-hoisted (symlinked) `node_modules` fails fast with an actionable error.
- Deploy never writes into `node_modules` or the user's build output; staging is
  deploy-owned, keyed by graph address.
- The wrapper bundle resolves the user's own dependencies (the service module
  imports their client factories), so assembly's bundler invocation resolves
  from the authoring module's directory — an internal burden accepted to keep
  the wrapper out of userland.

## Alternatives considered

- **The framework invokes the user's build** (e.g. running the package's
  `build` script by convention, with an override) — rejected: consuming
  outputs is strictly simpler, and monorepo tools already own orchestration,
  ordering, and caching. Nothing in the contract prevents adding an opt-in
  invocation later; the boundary would not move.
- **The framework does *no* tree completion; the user's build produces a fully
  flat bundle and the adapter only wraps it** (a mid-design over-correction) —
  rejected: it pushes Next's documented `cp` into every app as a hand-maintained
  build script, worse ergonomics for zero safety gain. The real rule is no
  *guessing*, not no *copying*.
- **Infer the bundle location** (fixed monorepo depth, or glob-and-hope) —
  rejected: inference is the root cause of the deploy failures; read the app's
  location from the build tool's own manifest (Next's `relativeAppDir`) instead.
- **Walk the standalone tree for `server.js`** (a first cut) — rejected: it's a
  heuristic (shallowest non-dependency `server.js`) where an authoritative record
  exists. Next writes `relativeAppDir`; read it.
- **A packager-wide `bunfig` disabling auto-install** — rejected: node and Next
  services have opposite auto-install needs; the toggle is adapter-specific.
- **The user's build produces the wrapper too** — honest about who bundles
  what, but it leaks the boot protocol into every app's build config, and
  framework-built apps (Next) would need a second build step bolted on.
- **Eliminating the wrapper** (a generic, pack-owned bootstrap doing the
  env-to-stash step without the service module) — rejected: `run`/`load`
  live on the node, and booting requires the node; the wrapper is the boot
  protocol, not an artifact of packaging.

## Related

- [`ADR-0004`](ADR-0004-paths-resolve-relative-to-the-authoring-file.md) —
  how assembly resolves the descriptor's authoring-relative paths.
- [`../01-principles/architectural-principles.md`](../01-principles/architectural-principles.md)
  — "We don't bundle the app's code — and we don't guess" as a guiding principle.
- [`../10-domains/core-model.md`](../10-domains/core-model.md) — the
  wrapper's role in boot (`run`/`load`).
- [`../10-domains/deploy-cli.md`](../10-domains/deploy-cli.md) — assembly's
  place in the pipeline.

# ADR-0005: Users build their app; the framework assembles deploy artifacts from built output

## Decision

The framework never initiates or configures a user's build. The contract is:
built output exists before `prisma-compose deploy` runs, produced by the user's
own tooling. Downstream of that boundary, the deploy artifact is the
framework's to manufacture however it likes: per-adapter-kind **assembly**
locates and validates the built output, applies the framework's envelope —
including bundling the internal boot wrapper — and hands a normalized bundle
to lowering.

## Reasoning

Take a Next.js storefront. The author builds it the way every Next app is
built:

```sh
next build   # output: "standalone" → .next/standalone/…
```

The framework plays no part in that step — not the bundler options, not the
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
- **The user's build produces the wrapper too** — honest about who bundles
  what, but it leaks the boot protocol into every app's build config, and
  framework-built apps (Next) would need a second build step bolted on.
- **Eliminating the wrapper** (a generic, pack-owned bootstrap doing the
  env-to-stash step without the service module) — rejected: `run`/`load`
  live on the node, and booting requires the node; the wrapper is the boot
  protocol, not an artifact of packaging.

## Related

- [`ADR-0004`](ADR-0004-paths-resolve-relative-to-the-authoring-file.md) —
  how assembly resolves the descriptor's paths.
- [`../10-domains/core-model.md`](../10-domains/core-model.md) — the
  wrapper's role in boot (`run`/`load`).
- [`../10-domains/deploy-cli.md`](../10-domains/deploy-cli.md) — assembly's
  place in the pipeline.

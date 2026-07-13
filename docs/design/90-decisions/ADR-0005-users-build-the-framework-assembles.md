# ADR-0005: Users build a flat bundle; the framework only wraps it

## Status

Accepted

## Decision

The framework never bundles, transforms, discovers, or repairs application
code. The contract is: **the user's own build produces a finished, flat,
self-contained bundle before `prisma-compose deploy` runs.** Assembly does
exactly two things on top of it — no more:

1. **Validate** the built output exists at the descriptor's declared location;
   fail loudly (naming the resolved path, "run your build") if not.
2. **Add the framework's own boot wrapper** — the service module bundled to
   `main.mjs`, whose `run()` executes before the app's entry. This is the
   framework's code, not the user's app; wrapping it is the one thing assembly
   contributes.

Then it hands the bundle to lowering, which packages a **flat tree**. Binding
corollaries, because every one of these was violated in the first real deploy:

- **No path-string arithmetic, no filesystem-derived identity.** The framework
  never guesses an output filename (the wrapper's name is *dictated* —
  `main.mjs` — not discovered) and never encodes an absolute deploy-machine
  path into an artifact. Where uniqueness is needed (wrapper staging), the key
  is the node's **graph address**, collision-free by construction (provision
  ids reject `_` and `.` inside segments). Staging lives in a deploy-owned
  directory (`.prisma-compose/artifacts/<address>/`), never inside
  `node_modules` and never inside the user's build output.
- **No layout inference.** Where the bundle lives is the user's input, not the
  framework's deduction. The nextjs adapter takes the standalone app directory
  as supplied (relative resolves against `dirname(module)` per
  [ADR-0004](ADR-0004-paths-resolve-relative-to-the-authoring-file.md), absolute
  passes through) — it never computes a monorepo root at a guessed depth.
- **A symlink in a bundle is a hard error**, naming the path and the fix
  ("materialize links in your build, e.g. `cp -RL`"). The framework does not
  dereference, represent, or route around it. Producing a flat tree — copying
  in static assets, `public/`, a flattened `node_modules` — is the job of
  whoever chose the layout: the user's build.

## Reasoning

Take a Next.js storefront. The author builds it the way every Next app is
built, and their build is responsible for producing the *complete, flat*
deploy tree:

```sh
next build   # output: "standalone" → .next/standalone/…
# then the app's own build flattens it: copy static/ and public/ in,
# materialize the symlinked node_modules (cp -RL)
```

The framework plays no part in that — not the bundler options, not the
framework version, not the tree-flattening. What it does happens *after*:
given the finished flat directory the build produced, assembly validates it,
drops the framework's boot wrapper beside the server, and hands the directory
to the target pack for packaging. The author's build and the framework's
assembly touch the same directory but never each other's concerns.

The boundary is drawn where it is because the two sides fail differently when
entangled. A build system the framework mediated would make every bundler
option a support surface and every framework upgrade a compatibility matrix;
monorepo tools already own build ordering and caching better than a deploy
tool ever will. And a framework that *launders* trees — walks them, copies
`node_modules`, dereferences symlinks, guesses roots — inherits every layout
pathology of every package manager, forever. Worse, it is a security hazard:
a symlink escaping the repo (a compromised postinstall, or plain accident)
would, under "helpful" dereferencing, silently package arbitrary
deploy-machine files — `~/.aws`, ssh keys — into the artifact, and an absolute
path in an artifact encodes the deploy machine's filesystem into what ships.
A thin contract eliminates the whole class: the framework touches only what
the user explicitly handed it, errors loudly on anything that is not a plain
flat tree, and adds exactly one thing of its own — the wrapper.

The **wrapper** is the one thing that stays on the framework's side. It
resolves the service's serialized config from the environment, stashes it,
then imports the entry — essential to the boot protocol and deliberately
invisible, so no app's build is complicated by it. Producing it means the
framework runs a fixed, internal bundler invocation over the *service module*
(the framework's own code), which is not entanglement with the user's build.
The wrapper is bundled to `main.mjs`; the app's entry may not share that
basename.

## Consequences

- `prisma-compose deploy` has no build invocation: no build-command
  convention, no skip flags, no build-script discovery.
- Missing outputs are detected; *stale* ones are not. Freshness checking would
  be an additive layer on the same contract.
- The build adapter descriptor declares *where* the user's build puts its flat
  output, never *how* to produce it.
- Any monorepo layout deploys, because the user states where the bundle is.
- A bun/pnpm-built Next standalone tree (symlinked `node_modules`) **fails fast**
  with an actionable error; those apps add a flatten step to their own build.
- The deterministic tar writer stays trivial: regular files only.
- Deploy never writes into `node_modules` or the user's build output; wrapper
  staging is deploy-owned, keyed by graph address.

## Alternatives considered

- **The framework invokes the user's build** — rejected: consuming outputs is
  strictly simpler, and monorepo tools already own orchestration.
- **The framework normalizes the tree** (copies in static assets, `public/`,
  the hoisted `node_modules`, dereferences symlinks to self-containerize) — the
  earlier form of this decision. Rejected: it makes the framework a
  tree-laundering machine owning every package manager's layout pathologies,
  and it is a security hazard (symlink escape, absolute paths in artifacts).
  Self-containerizing is the user's build's job.
- **Infer the bundle location** (fixed monorepo depth, or glob for the entry)
  — rejected: inference is the root cause of the deploy failures, not the cure;
  the user supplies the path.
- **The user's build produces the wrapper too** — rejected: it leaks the boot
  protocol into every app's build config.
- **Eliminating the wrapper** — rejected: `run`/`load` live on the node, and
  booting requires the node; the wrapper is the boot protocol, not packaging.

## Related

- [`ADR-0004`](ADR-0004-paths-resolve-relative-to-the-authoring-file.md) —
  how assembly resolves the user-supplied bundle path.
- [`../01-principles/architectural-principles.md`](../01-principles/architectural-principles.md)
  — "We don't bundle" as a top-level guiding principle.
- [`../10-domains/core-model.md`](../10-domains/core-model.md) — the
  wrapper's role in boot (`run`/`load`).
- [`../10-domains/deploy-cli.md`](../10-domains/deploy-cli.md) — assembly's
  place in the pipeline.

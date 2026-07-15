# ADR-0005: Users build the app; the framework assembles the deploy artifact

## Status

Accepted

## Decision

The framework never bundles or transforms the **application's code**. The user's
own build (`next build`, `tsdown`, …) produces the runnable before
`prisma-compose deploy` runs. Downstream of that boundary the deploy artifact is
the framework's to manufacture — but only by **documented, deterministic**
steps, never by heuristics. Per build adapter, assembly:

- **Validates** the built output exists where the descriptor says; fails loudly
  ("run your build") otherwise.
- **Adds the boot wrapper** — the service module bundled to `main.mjs`, whose
  `run()` executes before the app's entry. This is the framework's own code, the
  one thing it contributes to the tree. Its name is *dictated* (`main.mjs`, via a
  tsdown object entry), never discovered.
- **Performs that app-type's documented deploy step.** `node()` copies the built
  entry under `bundle/`. `nextjs()` does the Next-documented standalone deploy:
  ship `.next/standalone` and copy in the client assets Next omits (`.next/static`,
  `public/`) — the exact `cp` from the Next docs.

Everything lands in a deploy-owned working dir keyed by the node's **graph
address** (`.prisma-compose/artifacts/<address>/`), never inside `node_modules`
or the user's build output; the user's tree goes under `bundle/`, our wrapper at
the root. Three disciplines bound what "assembly" may do — each was violated in
the first real out-of-repo deploy:

- **No guessing.** No path-string arithmetic, no monorepo-depth inference, no
  filename discovery, no absolute deploy-machine path baked into an artifact.
  When the framework needs the app's (possibly deep) location in a standalone
  tree, it **finds** it — locating `server.js` — it does not *compute* it from an
  assumed depth. Uniqueness comes from the graph address, collision-free by
  construction.
- **No laundering.** The framework ships `node_modules` exactly as the user's
  build produced it. A symlinked (non-hoisted) `node_modules` is a **hard error**
  at package time, never dereferenced — and it is the user's to fix, because that
  same non-flat install also crashes a Next standalone server at boot (use a
  hoisted linker: npm, or pnpm/bun `node-linker=hoisted`).
- **The framework owns the app's *code* boundary, not its *runtime*.** A plain
  `node()` service relies on the Compute runtime's `bun` auto-install to resolve
  dynamic requires its bundler missed (e.g. `pg/lib/*`); a `nextjs()` artifact
  *disables* auto-install (its `sharp`/`@next/swc` optional deps would otherwise
  fetch linux binaries at boot and fill the disk). That opposite need is why the
  `bunfig.toml` toggle lives in the `nextjs()` adapter, not as a packager default.

## Reasoning

The boundary is drawn at the app's **code** because that is where the two sides
fail differently when entangled. A build system the framework mediated would make
every bundler option a support surface and every framework upgrade a
compatibility matrix; monorepo tools already own build ordering and caching
better than a deploy tool ever will. So the framework consumes the built output;
it never produces it.

But "assemble the artifact from that output" legitimately includes the
app-type's *documented* deploy step — for Next, copying the client assets its
standalone output deliberately omits. That is not the hazard. The hazard is
**guessing and laundering**: a framework that infers a monorepo depth breaks on
the next layout; one that walks and dereferences trees inherits every package
manager's pathology and, worse, becomes a security hole — a symlink escaping the
repo (a compromised postinstall, or accident) would silently package
deploy-machine files (`~/.aws`, ssh keys) into the artifact, and an absolute path
in an artifact encodes the build machine's filesystem into what ships. The
discipline is therefore not "do nothing to the tree" — it is "do only the
documented, deterministic thing, find don't compute, and reject anything that
isn't a plain file."

The **wrapper** stays on the framework's side unconditionally: it resolves the
service's serialized config from the environment, stashes it, then imports the
entry — the boot protocol, deliberately invisible so no app's build carries it.
Producing it is a fixed internal bundler invocation over the framework's own
service module, not entanglement with the user's build.

## Consequences

- `prisma-compose deploy` has no build invocation: no build-command convention,
  no skip flags, no build-script discovery.
- Missing outputs are detected; *stale* ones are not (an additive layer later).
- The build adapter declares *where* the user's build puts its output, never
  *how* to produce it; a Next app's whole build is `next build`.
- Any monorepo layout deploys — the app's deep location is found, not assumed.
- A non-hoisted (symlinked) `node_modules` fails fast with an actionable error.
- Deploy never writes into `node_modules` or the user's build output; staging is
  deploy-owned, keyed by graph address.

## Alternatives considered

- **The framework invokes the user's build** — rejected: consuming outputs is
  simpler, and monorepo tools already own orchestration.
- **The framework does *no* tree completion; the user's build produces a fully
  flat bundle and the adapter only wraps it** (a mid-design over-correction) —
  rejected: it pushes Next's documented `cp` into every app as a hand-maintained
  build script (or a bolted-on CLI verb), which is worse ergonomics for zero
  safety gain. The documented copy is deterministic; doing it in the adapter is
  right. The real rule is no *guessing*, not no *copying*.
- **Infer the bundle location** (fixed monorepo depth, or glob-and-hope) —
  rejected: inference is the root cause of the deploy failures; find `server.js`
  deterministically instead.
- **A packager-wide `bunfig` disabling auto-install** — rejected: node and Next
  services have opposite auto-install needs; the toggle is adapter-specific.
- **Eliminating the wrapper** — rejected: `run`/`load` live on the node; the
  wrapper is the boot protocol, not packaging.

## Related

- [`ADR-0004`](ADR-0004-paths-resolve-relative-to-the-authoring-file.md) —
  how assembly resolves the descriptor's authoring-relative paths.
- [`../01-principles/architectural-principles.md`](../01-principles/architectural-principles.md)
  — "We don't bundle the app's code — and we don't guess" as a guiding principle.
- [`../10-domains/core-model.md`](../10-domains/core-model.md) — the wrapper's
  role in boot (`run`/`load`).
- [`../10-domains/deploy-cli.md`](../10-domains/deploy-cli.md) — assembly's place
  in the pipeline.

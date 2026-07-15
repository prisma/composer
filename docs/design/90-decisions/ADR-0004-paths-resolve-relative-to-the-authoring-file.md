# ADR-0004: Paths resolve relative to the file that writes them

## Decision

Every path a build descriptor carries resolves relative to the module that
authored it. The descriptor captures that module explicitly —
`node({ module: import.meta.url, entry: "../dist/server.js" })`,
`nextjs({ module: import.meta.url, appDir: "..", entry: "server.js" })` — and
`entry`, `appDir`, and any other kind-specific path field resolve against
`dirname(module)`, exactly like a relative import specifier. There is no
directory discovery anywhere in the module: no walk to a nearest
`package.json`, no inferred "service directory".

The same rule holds one layer up, in the deploy tooling. Resolving a pack's
`/target` or `/assemble` module happens by seeding `createRequire` with the
entry module's own file path, letting the platform's resolver walk
`node_modules` upward the way it would for a plain `import` in that file. And
tool state — the generated `.prisma-compose/alchemy.run.ts`, Alchemy's `.alchemy`
state directory — lives in the process's working directory, like any other
CLI's state: where you run the tool, not somewhere the tool infers.

## Reasoning

Ground it in the file an author actually edits:

```ts
// src/service.ts
export default compute({
  name: "hello",
  deps: { db },
  build: node({ module: import.meta.url, entry: "../dist/server.js" }),
});
```

`entry` points at the app's built runnable. The author writing that line is
sitting in `src/service.ts` and knows exactly where their build puts its
output: one directory up, in `dist/`. `"../dist/server.js"` means precisely
what `import "../dist/server.js"` would mean in the same file. That is the
whole convention — the one every import statement in the codebase already
follows — and it needs no second rule beside it.

The reason the descriptor must capture `module` at all: the descriptor is
plain data, and deploy-time code meets it far from where it was authored. A
JavaScript value carries no record of which file created it, so a relative
path on a bare object would be relative to nothing. `import.meta.url`,
evaluated in the authoring module, pins the anchor at the one moment it is
knowable — and only the build descriptor needs it, because only the build
cares where files live. A service composes resources and connections, none of
which have a filesystem location; giving the *service node* an anchor would
attach a concern to the wrong concept.

`module` is the one sanctioned bend of the model's "no machine paths on
nodes" rule, and it is safe for a specific mechanical reason: nodes ride into
the deployed artifact (the service module is bundled), but bundlers preserve
`import.meta.url` as an *expression*, not a literal. Inside the artifact it
re-evaluates to an artifact-internal path that nothing reads; no dev-machine
path is ever baked into the output, so artifacts stay byte-deterministic. A
build that produces no output at `dirname(module)/entry` fails at assembly
with an error naming the resolved path and telling the author to run their
build.

The deploy tooling's resolution follows the same logic. To load
`@prisma/compose-prisma-cloud/target` on behalf of an app, the tool seeds
`createRequire` with the entry module's file path.
`createRequire(file).resolve(...)` walks `node_modules` upward from
`dirname(file)` — that is Node's own module-resolution algorithm, identical to
what a plain `import` in the entry file would do. Discovering a directory
ourselves and building a synthetic anchor from it would be reimplementing a
piece of the platform's resolver.

Tool state completes the picture: `.prisma-compose/` and Alchemy's state land in the
working directory. That matches every CLI a developer already uses, and it
means running `deploy` and `destroy` from an app's directory keeps that app's
state with it. The corollary is that destroy must run where deploy ran; the
CLI warns when a destroy finds no local state, since silently "destroying"
nothing while real infrastructure keeps running is the one dangerous miss.

## Consequences

- The authoring shape is `module: import.meta.url` beside `entry` at the same
  call site — the anchor and the paths it anchors are written together, so
  they cannot drift apart.
- The "no machine paths on nodes" rule keeps exactly one sanctioned
  exception, documented on `BuildAdapter` itself.
- There is no "anchor not found" failure mode, because there is no anchor
  discovery; the only path failure is missing built output, and that error
  names the resolved path.
- A future serialized-topology artifact must strip or relativize
  `build.module` — it is machine-specific and doesn't belong in a shareable
  artifact.
- State follows the working directory. Scripts and CI that run the CLI from
  the app's directory get per-app state for free; a destroy run from the
  wrong directory is caught by the no-local-state warning.

## Alternatives considered

- **An anchor discovered by walking to the nearest `package.json`** (from an
  authoring-URL field on the service node) — rejected: it introduces a second
  resolution convention beside the platform's, an extra error class ("no
  package.json above the module"), and an indirection between where a path is
  written and what it means. `dirname` of the authoring module is exactly as
  flexible an anchor and states what it anchors explicitly. It also put the
  anchor on the service node, attaching a build concern to a concept that has
  no filesystem location.
- **Inferring the authoring file** (loader hooks, stack-trace capture in the
  factory) — zero boilerplate, but runtime-dependent magic for something that
  must never mislocate a deploy.
- **An explicit directory parameter at assembly** (`serviceDir` passed
  alongside the descriptor) — the same information `dirname(module)` already
  determines, stated twice; asking authors for both invites drift.

## Related

- [`ADR-0003`](ADR-0003-deploy-derives-everything-from-the-root-node.md) —
  the entry-module-driven deploy this resolution rule serves.
- [`ADR-0005`](ADR-0005-users-build-the-framework-assembles.md) — what assembly
  does with the resolved paths.
- [`../10-domains/deploy-cli.md`](../10-domains/deploy-cli.md)

# ADR-0017: Control-plane code loads through the app's config file

## Decision

An application root carries a `prisma-compose.config.ts`. The config statically
imports **extension** descriptors — the control-plane face of each extension
package the app deploys with — and declares the deploy's one state store:

```ts
// prisma-compose.config.ts — loaded by the CLI, never imported by app code
import { defineConfig } from "@prisma/compose/config";
import { prismaCloud, prismaState } from "@prisma/compose-prisma-cloud/control";
import { nodeBuild } from "@prisma/compose/node/control";

export default defineConfig({
  extensions: [prismaCloud(), nodeBuild()],
  state: () => prismaState(),
});
```

Deploy tooling loads the config (found by walking up from the deploy entry,
loaded with c12 — the same mechanism Prisma Next uses for
`prisma-next.config.ts`), then looks up each node's control-plane behavior in
the registries the descriptors provide, keyed by **(extension ID, node ID)**:
a node's `extension` field (`"@prisma/compose-prisma-cloud"`) and its `type`
(`"compute"`). Nodes are pure data; the framework never constructs a module
specifier, never resolves a path, and never dynamically imports by a computed
name.

## Reasoning

Two facts collide. Deploy needs heavy control-plane code — provisioning
engines, bundlers — that only each extension package can supply. And a node's
authoring module rides into the production artifact: the wrapper build bundles
the service module and inlines its imports, so anything reachable from an
authoring entry ships to runtime. Control-plane code must therefore be
reachable from deploy tooling but *unreachable from anything the app's own
code imports*.

The config file is that boundary, and it is a file boundary rather than a
compiler trick. App code — service modules, the module entry — imports
authoring factories, which are pure data. Only the CLI loads
`prisma-compose.config.ts`, and only the config imports the `/control` entries
where the heavy code lives. A bundler walking the app's import graph never
encounters the config, so no discipline about *how* imports are written is
needed: the firewall holds by construction. (Each extension still carries a
guard test asserting nothing reachable from its authoring entry imports its
`/control` entry, plus a real build of the authoring surface asserting no
control-plane tokens — the end-proof.)

The config also answers *where module resolution happens*: at the app root,
via ordinary static `import` statements, resolved by whatever package manager
is running — hoisted or isolated node_modules, Yarn PnP, Deno. The app root is
the one place guaranteed to see the app's declared dependencies. That matters
because the resolution question has no other good answer: resolving from
inside the framework's own packages fails (the framework deliberately depends
on no extension, so extension packages are not reachable from its
`node_modules` position), and anchoring resolution at a chosen file means
hand-building paths — machinery the platform already owns and that layouts
without a `node_modules` tree don't support at all.

With loading settled, correlation becomes plain data. Every pack-authored node
already names its origin: `extension` is the extension's package name, `type`
is the node's ID within it. An extension descriptor carries a registry of
node descriptors under those same IDs, so the deploy walk is a map lookup —
`extensions[node.extension].nodes[node.type]` — for services, resources, and
build descriptors alike. One mechanism, no special cases.

That uniformity deliberately kills the "target" as a privileged concept.
There is no one blessed platform per application: each node's descriptor entry
knows how to provision, serialize, package, and deploy *that node*, **Alchemy**
— the infrastructure-provisioning engine the framework's deploy lowers onto —
composes the used extensions' provider layers into one stack, and nodes on
different platforms coexist in one graph. What remains singular is the
**state store** — one deploy writes one ledger. The store's *contract* is
platform-agnostic (it records resource state regardless of which provider made
it), so the config declares it once, explicitly; the concrete provider is not.
`prismaState` is a Prisma Cloud store — a hosted Postgres in the workspace,
provisioned by the same Management API as `prismaCloud()` — so it ships from
`@prisma/compose-prisma-cloud/control` alongside `prismaCloud()`, not from the private
`@internal/lowering` package the extension is built on. Another platform would
supply its own state provider through its own extension.

Environment validation keeps its fail-fast shape without a framework
contract: an extension factory (`prismaCloud()`) reads and validates its own
environment when the config is evaluated, erroring with the exact variable
name before any slow work happens.

One consequence is worth stating plainly: the app's config must list every
extension its graph uses — including extensions used internally by a module
installed from a package. A published module documents its extensions and can
re-export them as a config fragment (`extensions: [...authModuleExtensions,
prismaCloud()]`), keeping the cost to one line. This is the standard plugin
registration model, and it trades implicit resolution — which is exactly what
kept failing — for an explicit, deterministic list.

## Consequences

- Nodes are frozen data: `extension` + `type` (+ each kind's own fields).
  No deploy-loading methods, no module-specifier fields, no behavior beyond
  the sanctioned `hydrate`/`run` slots.
- The CLI pipeline gains one step: load the config, then validate that every
  node's and build descriptor's `(extension, type)` has a registry entry —
  the error names the missing extension and the config fix.
- The generated stack file imports the user's config by relative path and
  drives lowering with its registries and state — the config is the single
  control-plane entry for both the CLI and the generated artifact.
- Mixed platforms in one application are legal and intended. There is no
  mixed-target error; coverage validation replaces it.
- A listed extension runs its `application` hook and providers whether or not
  any node uses it — the list is the whole registration, with no
  used-extensions-only filtering. Listing an unused platform extension
  therefore provisions its app-level infrastructure (e.g. an empty Project), so
  list only the extensions the app actually deploys with. (A future check could
  require the extension owning `state` to appear in the list.)
- Extensions ship two entries: the authoring entry (pure data factories) and
  `/control` (registries; the only place heavy deploy code lives).
- The framework's own packages remain extension-agnostic: nothing in core or
  the CLI names, resolves, or depends on any extension package.

## Alternatives considered

- **Nodes own their deploy-module loads** — each node carries a full module
  specifier as data (`targetModule`, `assembler`) and a method performs
  `import(this.specifier)`. Firewall-safe (the variable argument is opaque to
  bundlers), but resolution runs from the framework's own install location,
  which by design depends on no extension — so real workspace layouts fail to
  resolve, and only artificially flattened installs work. Rejected on that
  empirical failure.
- **Framework-constructed specifiers resolved to paths** — build
  `${pkg}/target` from a field and resolve it via `createRequire` anchored at
  a chosen file. Works where the anchor happens to see the package, but it is
  hand-rolled path resolution: anchor-file plumbing through the pipeline, and
  a dead end on layouts with no `node_modules` to walk (Yarn PnP, Deno).
- **A loader thunk with a literal import on the node**
  (`loadAssembler: () => import("@prisma/compose/node/assemble")`) — the literal
  lives in factory code that ships inside the wrapper bundle, so the bundler
  follows it and drags the control plane into the runtime artifact. The exact
  failure the firewall exists to prevent.
- **Registries resolved by convention without a config** (scan installed
  packages, or infer the extension list from the graph and dynamically import
  each) — reintroduces dynamic resolution with all of the above problems,
  plus magic the user cannot see or override. The config is one small,
  inspectable file.

## Related

- [`ADR-0003`](ADR-0003-deploy-derives-everything-from-the-root-node.md) —
  what stays derived from the root node; the config carries only what is not
  derivable (the extension list and the state store).
- [`ADR-0008`](ADR-0008-wrapper-inlines-everything-except-runtime-builtins.md)
  — the wrapper inlining that makes the firewall necessary.
- [`ADR-0016`](ADR-0016-a-module-has-the-same-boundary-as-a-service.md) — the
  module boundary; a published module's extensions enter the app's config as
  a documented fragment.
- [`ADR-0009`](ADR-0009-deploy-state-is-hosted-in-the-workspace.md) …
  [`ADR-0012`](ADR-0012-the-state-store-speaks-sql-directly.md) — the state
  store the config's `state:` supplies; one ledger per deploy, any number of
  platforms.
- [`../10-domains/deploy-cli.md`](../10-domains/deploy-cli.md) — the pipeline
  this reshapes.

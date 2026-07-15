# ADR-0016: A module has the same boundary as a service

## Decision

A module declares the same boundary a service does: a `Deps` map of typed
inputs and an `Expose` map of contract outputs. Its body receives the declared
inputs alongside `provision()` and returns a ref-port for each declared output.
`provision()` accepts a module wherever it accepts a service, handing back the
same `ProvisionedRef` of exposed ports — so modules nest, and a consumer cannot
tell a provisioned module from a provisioned service. The two differ only in
opacity: a service's body is a black box; a module's body is topology the
framework can see.

## Reasoning

Ground it in what this exists to make possible — installing a whole bounded
context from a package:

```ts
// the app's topology
import authModule from "@acme/auth-module";          // installed from npm
import storefront from "./storefront/service";

export default module("shop", { expose: { web: storeContract } }, ({ provision }) => {
  const auth = provision("auth", authModule);      // a module, provisioned like a service
  const store = provision("storefront", storefront, { auth: auth.verify });
  return { web: store.web };
});
```

`@acme/auth-module` deploys its own compute and owns its own data inside the
app's topology, and everything reaches it through one typed port
(`auth.verify`). The app never learns how many services it contains or what its
schema looks like. That is a reusable module: not a SaaS you call, not a library
you embed in your process — a deployable component with a typed boundary.

For that to work a module needs a boundary, and the model already owns the right
one. A service declares `Deps` in and `Expose` out; `provision()` already
returns a `ProvisionedRef` carrying one typed ref-port per exposed contract; the
wiring machinery already checks a ref-port against the input it fills. Reusing
that boundary for modules is the whole decision. It keeps the port mechanic
uniform at every level of the tree — not for elegance, but because that
uniformity is what makes composition *compose*: an enclosing scope wires "a
thing with typed inputs and outputs" without a case split on what kind of thing
it is.

Forwarding then needs no mechanism of its own. The body is a function: its
declared inputs arrive as arguments, and it hands them into the `provision()`
calls that need them — an input flows *down* by being passed. Its declared
outputs are its return value — an output flows *up* by being returned. Both
directions are ordinary data flow through an ordinary function, checked by the
same contract-assignability the flat wiring already uses.

The boundary is also what makes a module *fakeable*. A consumer depends on a
contract, never on the module: the storefront above requires something
satisfying `auth.verify`'s contract, and the wiring site decides what that is.
Swap `provision("auth", authModule)` for a one-service fake exposing the same
contract and the storefront does not change a line — dependency inversion at the
level of the architecture, where a test topology is just a different wiring
file.

Distribution then falls out of decisions already made. A module package ships
its service modules with their built runnables; descriptor paths resolve
relative to the authoring module (ADR-0004), so assembly finds output inside
`node_modules/@acme/auth-module/` exactly as it would in the app's own tree, and
"built output exists before deploy" (ADR-0005) holds at publish time. The
wrapper inlines each service's imports from that package's own dependency tree
(ADR-0008). Version compatibility is the package manager's job: a module
declares `@prisma/compose*` as peer dependencies, and its declared range asserts
that the reader code frozen into its published runnables understands the config
the app's deploy-time serializer writes.

One requirement lands on the deploy tooling: a module's internal choice of build
adapter must stay internal — a consuming app must not have to declare
`@prisma/compose/nextjs` because some installed module happens to use Next inside.
How the tooling loads adapter and target modules is a separate decision
(ADR-0017); this ADR only pins the requirement. The target itself stays the
application's own declaration — one target per application (ADR-0003).

## Consequences

- The authoring surface is `module(name, { deps?, expose? }, body)`: the body
  takes its inputs and `provision`, and returns a port for each declared output.
  An empty boundary (`module(name, {}, body)`) is the closed, deploy-root form —
  the same shape with nothing wired across it.
- Load enforces four boundary rules, each a Load-time error that names its fix:
  a declared input never forwarded, a declared output not returned (the runtime
  backstop of the compile-time check), a non-empty boundary deployed as a root,
  and a cycle through forwarding.
- Deploy addresses are hierarchical — a child's address is its parent's plus its
  provision id — and assembled-bundle correlation keys carry the full path.
- The serialized-config/stash encoding is versioned public surface: a module
  published against a pack freezes reader code at publish time, so a format
  change is a semver-major of the pack.
- Reusable modules are pack-specific: a module authored in `@prisma/compose-prisma-cloud`'s
  vocabulary deploys only to that target. A target-neutral authoring vocabulary
  would lift that, and is deliberately out of scope here.
- Nothing about a module exists at runtime. Modules are topology; Load flattens
  them, and services remain the only things that boot.

## Alternatives considered

- **Modules stay root-only wiring scripts** (a module with no boundary) —
  forecloses reuse: a module that cannot be wired cannot be installed, faked, or
  nested, so every application must inline the topology of everything it uses.
- **A distinct "package/component" concept beside the module** — a second
  boundary mechanic to learn, wire, and validate, duplicating what services
  already have. Rejected for the same reason the port mechanic is uniform
  everywhere else.
- **Forwarding as declared port-mappings** — a data table naming input-to-child
  and child-to-output links instead of body data flow. More statically
  inspectable, but it introduces a wiring language where a function already
  suffices, and the body still has to exist for `provision()`.

## Related

- [`ADR-0003`](ADR-0003-deploy-derives-everything-from-the-root-node.md) —
  target inference; one target per application.
- [`ADR-0013`](ADR-0013-resources-are-provisioned-by-modules-deps-are-declarations.md)
  — the unified dependency model a boundary input rides: a resource reaches a
  slot as the same contract-carrying ref a service port does, so forwarding
  handles both without a case split.
- [`ADR-0004`](ADR-0004-paths-resolve-relative-to-the-authoring-file.md) — the
  path semantics that make installed modules assemble.
- [`ADR-0005`](ADR-0005-users-build-the-framework-assembles.md) /
  [`ADR-0008`](ADR-0008-wrapper-inlines-everything-except-runtime-builtins.md)
  — why published built output and wrapper bundling work for a module package.
- [`../10-domains/module-composition.md`](../10-domains/module-composition.md) — the
  full design this decision anchors.
- [`../03-domain-model/authoring-surface.md`](../03-domain-model/authoring-surface.md)
  — the uniform port mechanic this realizes.

# ADR-0014: A hex has the same boundary as a service

## Status

Accepted

## Decision

A hex declares the same boundary a service does: a `Deps` map of typed inputs
and an `Expose` map of contract outputs. Its body receives the declared inputs
as wiring values alongside `provision()`, and returns ref-ports for every
declared output — forwarding is arguments in, return values out, with no new
primitive. `provision()` accepts a hex wherever it accepts a service, returning
the same `ProvisionedRef` of the exposed ports, so composition nests. A
consumer cannot tell a provisioned hex from a provisioned service; the two
differ only in opacity (a service's body is a black box, a hex's body is
topology the framework can see).

## Reasoning

Ground it in the thing this exists to make possible — installing a whole
bounded context from a package:

```ts
// the app's topology
import authHex from "@acme/auth-hex";          // installed from npm
import storefront from "./storefront/service";

export default hex("shop", { expose: { web: storeContract } }, ({ provision }) => {
  const auth = provision("auth", authHex);      // a hex, provisioned like a service
  const store = provision("storefront", storefront, { auth: auth.verify });
  return { web: store.web };
});
```

`@acme/auth-hex` deploys its own compute and owns its own data, inside the
app's topology, and everything reaches it through one typed contract port
(`auth.verify`). The app never learns how many services it contains or what
its schema looks like. That is a reusable hex: not a SaaS you call, not a
library you embed in your process — a deployable component with a typed
boundary.

For that to work, a hex needs a boundary — and the model already owns the
right one. A service declares `Deps` in and `Expose` out; `provision()`
already returns a `ProvisionedRef` carrying one typed ref-port per exposed
contract; the wiring machinery already checks a ref-port against the input it
fills. Reusing that boundary for hexes is the whole decision. It keeps the
port mechanic uniform at every level of the tree — which is not an aesthetic
preference but the property that makes composition *compose*: an enclosing
scope wires "a thing with typed inputs and outputs" without a case split on
what kind of thing it is.

Forwarding then needs no mechanism of its own. The hex's body is a function;
its declared inputs arrive as arguments, and it hands them into the
`provision()` calls of the children that need them — an input flows *down* by
being passed. Its declared outputs are its return value, and it returns the
ref-ports of the children that provide them — an output flows *up* by being
returned. Both directions are ordinary data flow through an ordinary function,
checked by the same contract-assignability the flat wiring already uses.

The boundary is also what makes a hex *fakeable*. Consumers depend on
contracts, never on the hex: the storefront above requires something
satisfying `auth.verify`'s contract, and the wiring site decides what that is.
Swap `provision("auth", authHex)` for a one-service fake exposing the same
contract and the storefront does not change a line. Dependency inversion
arrives at the architecture level, and a test topology is just a different
wiring file.

Distribution falls out of decisions already made, rather than needing new
ones. A hex package ships its service modules with their built runnables;
descriptor paths resolve relative to the authoring module (ADR-0004), so
assembly finds output inside `node_modules/@acme/auth-hex/` exactly as it
would in the app's own tree, and "built output exists before deploy"
(ADR-0005) is satisfied at publish time. The wrapper's catch-all inlining
(ADR-0008) resolves the hex's imports from the hex package's own dependency
tree. Version compatibility is the package manager's job, used as designed:
the hex declares `@prisma/app*` as peer dependencies, and its range is the
author's assertion that the reader code frozen into its published runnables
understands the config the app's deploy-time serializer writes. That
assertion only means something if the serialized-config and stash encoding
are treated as public protocol under semver — a breaking format change is a
major version of the pack.

One requirement follows for the deploy tooling: a hex's internal choice of
build adapter stays internal — the consuming app must not have to declare
`@prisma/app-nextjs` because some installed hex happens to use Next inside. How
deploy tooling loads adapter and target modules is its own decision, recorded
separately; this ADR only pins the requirement. The target itself remains the
application's own declaration — one target per application (ADR-0003).

## Consequences

- `hex(name, body)` becomes `hex(name, { deps?, expose? }, body)`, and the
  body changes shape: inputs and `provision` in, outputs returned. This is a
  breaking change to hex authoring.
- Load gains boundary validation: a declared input never forwarded, a declared
  output not returned (backstopping the compile-time check), a hex deployed as
  root with unwired inputs (the composing-scope error services already have),
  and cycles created by forwarding are all Load-time errors.
- Deploy addresses become hierarchical, extending the existing dot-separated
  scheme; assembled-bundle correlation keys follow the full address path.
- The serialized-config/stash encoding becomes versioned public surface: hexes
  published against a pack freeze reader code at publish time, so format
  changes are semver-major for the pack.
- Reusable hexes are pack-specific: a hex authored with
  `@prisma/app-cloud`'s vocabulary deploys only to that target. A
  target-neutral authoring vocabulary would lift that, and is deliberately not
  part of this decision.
- Nothing about a hex exists at runtime. Hexes are topology; Load flattens
  them, services remain the only things that boot.

## Alternatives considered

- **Hexes stay root-only wiring scripts** (the minimal form) — forecloses
  reuse entirely: a hex that cannot be wired cannot be installed, faked, or
  nested; every application must inline the topology of everything it uses.
- **A distinct "package/component" concept beside the hex** — a second
  boundary mechanic to learn, wire, and validate, duplicating what services
  already have; rejected for the same reason the port mechanic is uniform
  everywhere else.
- **Forwarding as declared port-mappings** (a data table naming
  input-to-child and child-to-output links, instead of body data flow) — more
  statically inspectable, but it introduces a wiring language where a function
  already suffices, and the body still exists for `provision()` anyway.

## Related

- [`ADR-0003`](ADR-0003-deploy-derives-everything-from-the-root-node.md) —
  target inference; one target per application.
- [`ADR-0013`](ADR-0013-resources-are-provisioned-by-hexes-deps-are-declarations.md)
  — the unified dependency model a boundary input rides: a resource reaches a
  slot as the same contract-carrying ref a service port does, so forwarding
  handles both without a case split.
- [`ADR-0004`](ADR-0004-paths-resolve-relative-to-the-authoring-file.md) — the
  path semantics that make installed hexes assemble.
- [`ADR-0005`](ADR-0005-users-build-makerkit-assembles.md) /
  [`ADR-0008`](ADR-0008-wrapper-inlines-everything-except-runtime-builtins.md)
  — why published built output and wrapper bundling work for a hex package.
- [`../10-domains/hex-composition.md`](../10-domains/hex-composition.md) — the
  full design this decision anchors.
- [`../03-domain-model/authoring-surface.md`](../03-domain-model/authoring-surface.md)
  — the uniform port mechanic this realizes.

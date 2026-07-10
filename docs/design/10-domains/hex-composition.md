# Hex composition

How a hex declares a boundary, forwards through it, nests, and is consumed
from another module. The decision this design rests on is
[ADR-0014](../90-decisions/ADR-0014-a-hex-has-the-same-boundary-as-a-service.md)
(a hex has the same boundary as a service); the uniform-port principle it
realizes is described in
[`../03-domain-model/authoring-surface.md`](../03-domain-model/authoring-surface.md).

## The authoring surface

```ts
export function hex<D extends Deps, E extends Expose>(
  name: string,
  boundary: { deps?: D; expose?: E },
  body: (ctx: HexContext<D>) => HexOutputs<E>,
): HexNode<D, E>;

interface HexContext<D extends Deps> {
  /** The hex's declared inputs as wiring values — pass them into provision(). */
  readonly inputs: { [K in keyof D]: InputRef<D[K]> };
  /** Registers an owned child (service or hex) under a stable id. */
  readonly provision: HexBuilder["provision"];
}

/** One ref-port per declared expose key, contract-assignable to it. */
type HexOutputs<E extends Expose> = { [P in keyof E]: RefPort<E[P]> };
```

- `deps` and `expose` are the *same types services declare* — `Deps` and
  `Expose` — so a `HexNode<D, E>` is wireable exactly where a
  `ServiceNode<D, _, E>` is. That interchangeability is the composition
  property: an enclosing scope wires "a thing with typed inputs and outputs"
  without knowing which kind of thing it is.
- The body receives `inputs` (the declared deps as forwardable wiring values)
  and `provision`, and must return one ref-port per `expose` key. TypeScript
  checks the return against `E` (each returned `RefPort`'s contract must be
  assignable to the declared output contract); Load re-checks via
  `satisfies()` — the same two-layer check all wiring uses.
- A hex with an empty boundary — `hex(name, {}, body)` — is the closed,
  deploy-root form; it is the degenerate case of one shape, not a separate
  shape.

## Forwarding

Forwarding is data flow through the body — no primitive of its own:

```ts
export default hex("auth", { deps: { db }, expose: { verify: authContract } },
  ({ inputs, provision }) => {
    const svc = provision("api", authService, { db: inputs.db }); // input flows DOWN
    return { verify: svc.verify };                                 // output flows UP
  });
```

- **Down**: an entry of `ctx.inputs` is valid anywhere a `provision()` wiring
  value is — it stands for "whatever the enclosing scope wires here". Type
  checking is the existing `Wiring<D>` contract-assignability. A boundary
  input is a `DependencyEnd` carrying a required contract; forwarding treats
  every producer the enclosing scope might wire — a sibling service's exposed
  port or a hex-provisioned resource — identically, because both reach the
  slot as the same contract-carrying ref.
- At Load, a forwarded ref dereferences to the concrete producer it
  ultimately names — wiring edges always point at real provisioned
  addresses, so producer-kind checks and downstream config resolution never
  see a boundary.
- **Up**: the value returned for an expose key is any `RefPort` whose contract
  satisfies the declared one — a child service's exposed port, a nested
  hex's own output port, or one of the hex's own boundary inputs returned
  directly (a pass-through: the hex re-offers what it was wired, and a
  consumer of that output still resolves to the original producer).
- An untyped input (e.g. `http()`) carries no contract, so forwarding it has
  no compile-time check — it defers wholly to Load's `satisfies()` backstop
  at whatever consumer slot it reaches.
- A hex that re-exports one child's whole face is both moves at once — a
  wrapper hex is a few lines.

## `provision()` accepts hexes

A hex overload mirrors the service forms:

```ts
provision<D extends Deps, E extends Expose>(
  id: string,
  child: HexNode<D, E>,
  wiring: Wiring<D>,        // omitted when D is empty
): ProvisionedRef<E>;
```

The returned ref is indistinguishable from a provisioned service's. Whether an
id names a service or a sub-hex is invisible to sibling wiring, so topologies
nest to any depth.

## Load: flattening, addresses, validation

Load remains the single walk that turns authoring into the flat graph
everything downstream consumes:

- **Recursive flattening.** A provisioned hex's body executes during Load
  (exactly once, pure), its children joining the same graph. Services remain
  the only leaves; lowering, target packs, and assembly never learn that
  nesting exists.
- **Hierarchical addresses.** A child's deploy address is its parent's address
  plus its provision id, joined with `.` — the separator the address scheme
  and the serializer's config-key derivation already use. Deploy-time bundle
  correlation keys carry the full address, since provision ids are unique only
  within their scope.
- **Boundary validation** — Load errors, each naming its fix:
  - a declared `deps` entry never forwarded into any provision nor returned
    as an output — a boundary that promises an input it ignores lies to its
    consumers (re-offering an input as an expose port is using it);
  - a declared `expose` key missing from the body's return, or whose returned
    port fails `satisfies()` — the runtime backstop of the compile-time check;
  - a hex with non-empty `deps` deployed as root — the same "wire this from a
    composing scope" error a service with unwired dependency inputs gets;
  - a cycle through forwarding edges — expressible only once boundaries
    exist, so composition brings the check with it.

The boundary is a wiring-time contract, checked at compile time and re-checked
at Load. It is not enforced against a body that captures a sibling scope's ref
through a closure and wires it directly: such a ref still resolves to a real
provisioned address, so Load accepts it silently rather than routing it through
the declared input. Per-scope provenance tracking would close that, and is a
later refinement — the shared address table that makes legitimate
ancestor-forwarding resolve is the same mechanism that lets closure capture
through.

## Runtime: nothing

A hex does not exist at runtime. No process boots "a hex"; there is no
hex-level `run` or `load`. The boundary is a Load-time construct that
disappears into graph edges.

## Consuming a hex from another module

A hex is an exported value. Importing one — from a file in the same repo, a
workspace package, or a published package — is ordinary importing, and wiring
it is the same `provision()` call regardless of where it came from. Nothing
about consumption is specific to packaging.

What deploy requires is also provenance-independent, and already follows from
the path and build rules:

- **Built runnables must exist** at each service descriptor's
  `dirname(module)`-relative `entry` when `makerkit deploy` runs (ADR-0005).
  Who built them is the consumer's arrangement with the hex: an app importing
  hex source builds it like the rest of its code; a prebuilt package ships its
  runnables and satisfies the requirement at publish time (ADR-0004 makes the
  paths resolve correctly either way, including from inside `node_modules`).
- **Each service's build adapter travels with the service** — a hex's
  internal adapter choice never becomes the consuming app's dependency. The
  loading mechanism is the deploy tooling's own decision, recorded separately;
  this design only pins the requirement.
- **For prebuilt distribution, versioning is the package manager's job, used
  as designed**: the hex declares `@prisma/app*` and its target pack as peer
  dependencies, and the declared range asserts that the reader code frozen
  into its published runnables understands what the consumer's deploy-time
  serializer writes. The serialized-config and stash encodings are public
  protocol under semver: a breaking format change is a major version of the
  pack.

Consumers depend on a hex's *contracts*, never on the hex itself — the wiring
site decides what fills a slot. Any node exposing the same contract
substitutes without the consumer changing:

```ts
const auth = provision("auth", fakeAuthService);   // same contract, no database
```

## Extension points (designed for, not yet built)

- **Target-neutral hexes** — a hex is authored in one pack's vocabulary and
  deploys to that target; a target-neutral authoring vocabulary would make a
  hex portable across targets.
- **Shared resources** — one resource provisioned once and wired into several
  consumers turns the topology from a tree into a DAG (single provisioning,
  per-consumer config), and pairs with data contracts to bound what each
  consumer may touch.
- **Hex-level params** — configuration declarations on the hex boundary
  itself, beyond what its deps carry.

## Related

- [`ADR-0014`](../90-decisions/ADR-0014-a-hex-has-the-same-boundary-as-a-service.md)
- [`core-model.md`](core-model.md) — the node types and wiring machinery this
  extends (`Expose`, `ProvisionedRef`, `Wiring`).
- [`deploy-cli.md`](deploy-cli.md) — the pipeline that consumes the flattened
  graph.

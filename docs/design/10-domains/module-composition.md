# Module composition

> Amended by [ADR-0061](../90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md): a module declares one `input` schema, as a compute service does, and a root may declare one too. A module's input fields are values (`Value<T>`), and its binding is validated during Load's second pass; see [§ Input](#input).

How a module declares a boundary, forwards through it, nests, and is consumed
from another module. The decision this design rests on is
[ADR-0016](../90-decisions/ADR-0016-a-module-has-the-same-boundary-as-a-service.md)
(a module has the same boundary as a service); the uniform-boundary principle it
realizes is described in
[`../03-domain-model/authoring-surface.md`](../03-domain-model/authoring-surface.md).

## The authoring surface

```ts
export function module<D extends Deps, E extends Expose, I extends StandardSchemaV1 | undefined>(
  name: string,
  boundary: { deps?: D; input?: I; expose?: E },
  body: (ctx: ModuleContext<D, I>) => ModuleOutputs<E>,
): ModuleNode<D, E, I>;

interface ModuleContext<D extends Deps, I extends StandardSchemaV1 | undefined> {
  /** The module's declared dependencies as wiring values — pass them into provision(). */
  readonly deps: { [K in keyof D]: InputRef<D[K]> };
  /** The module's input: one value per field, typed from its input schema's output (ADR-0061); `undefined` when it declares none. Pass a field into a provision() binding or list it as a resolve() dependency. */
  readonly input: I extends StandardSchemaV1 ? ModuleInput<I> : undefined;
  /** The deploy-time facts of the environment, each a value: today only `environment.name`. */
  readonly environment: EnvironmentFacts;
  /** Registers an owned child (service or module) under a stable id. */
  readonly provision: ModuleBuilder["provision"];
}

/** One ref-port per declared expose key, contract-assignable to it. */
type ModuleOutputs<E extends Expose> = { [P in keyof E]: RefPort<E[P]> };
```

- `deps` and `expose` are the *same types services declare* — `Deps` and
  `Expose` — so a `ModuleNode<D, E>` is wireable exactly where a
  `ServiceNode<D, _, E>` is. That interchangeability is the composition
  property: an enclosing scope wires "a thing with typed dependencies and exposed interfaces"
  without knowing which kind of thing it is.
- The body receives `deps` (the declared dependencies as forwardable wiring values)
  and `provision`, and must return one ref-port per `expose` key. TypeScript
  checks the return against `E` (each returned `RefPort`'s contract must be
  assignable to the declared output contract); Load re-checks via
  `satisfies()` — the same two-layer check all wiring uses.
- The body also receives `environment`, whose `name` is a value: an opaque
  stand-in the body cannot read or branch on. The body lists it as a
  dependency of `resolve(dependencies, fn)`, which returns a computed value it
  can bind to a service's input or params; Load runs `fn` after every module
  body has run
  ([ADR-0062](../90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)).
- A module with an empty boundary is the closed, deploy-root form; it is the
  degenerate case of one shape, not a separate shape. Omitting the boundary
  argument — `module(name, body)`, where the body provisions and returns
  nothing — is the closed-root spelling of exactly that empty boundary.
- `provision`'s id may be omitted — `provision(node)` / `provision(node,
  wiring)` — and defaults to the node's own `name`. Pass an explicit id only
  when the name is not a valid id (contains `_`/`.`) or two provisioned nodes
  share a name.

## Forwarding

Forwarding is data flow through the body — no primitive of its own:

```ts
export default module("auth", { deps: { db }, expose: { verify: authContract } },
  ({ deps, provision }) => {
    const svc = provision("api", authService, { db: deps.db }); // the dependency flows DOWN
    return { verify: svc.verify };                                 // output flows UP
  });
```

- **Down**: an entry of `ctx.deps` is valid anywhere a `provision()` wiring
  value is — it stands for "whatever the enclosing scope wires here". Type
  checking is the existing `Wiring<D>` contract-assignability. A boundary
  input is a `DependencyEnd` carrying a required contract; forwarding treats
  every producer the enclosing scope might wire — a sibling service's exposed
  interface or a module-provisioned resource — identically, because both reach the
  slot as the same contract-carrying ref.
- At Load, a forwarded ref dereferences to the concrete producer it
  ultimately names — wiring edges always point at real provisioned
  addresses, so producer-kind checks and downstream config resolution never
  see a boundary.
- **Up**: the value returned for an expose key is any `RefPort` whose contract
  satisfies the declared one — a child service's exposed interface, a nested
  module's own exposed interface, or one of the module's own dependencies returned
  directly (a pass-through: the module re-offers what it was wired, and a
  consumer of that output still resolves to the original producer).
- An untyped input (a dependency end with no required contract) has no
  compile-time forwarding check — it defers wholly to Load's `satisfies()`
  backstop at whatever consumer slot it reaches.
- A module that re-exports one child's whole face is both moves at once — a
  wrapper module is a few lines.

## Input

A module declares its configuration as one `input` Standard Schema, as a
service does, and whoever provisions it binds that input
([ADR-0061](../90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)):

```ts
import { module, resolve } from '@prisma/composer';
import { secretString } from '@prisma/composer/arktype';
import { envSecret } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';

const email = module(
  'email',
  { input: type({ from: 'string', deliveryCredential: secretString(), 'replyTo?': 'string' }) },
  ({ input, environment, provision }) => {
    const sender = resolve([input.from, environment.name], ([from, name]) =>
      name === 'production' ? from : `${name}+${from}`);
    provision(emailService, {
      id: 'service',
      input: { from: sender, replyTo: input.replyTo, deliveryCredential: input.deliveryCredential },
    });
  },
);

export default module('shop', ({ provision }) => {
  provision(email, {
    input: { from: 'shop@example.com', deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') },
  });
});
```

`prisma deploy --environment staging` gives `shop.email.service` the input
binding `{ from: 'staging+shop@example.com', deliveryCredential:
envSecret('EMAIL_DELIVERY_CREDENTIAL') }`. The binding has no `replyTo` key,
because the root left that optional field out.

The body holds one value for each key of the schema: `input.from`,
`input.smtp.host`, or `input` itself for the whole input. Each is a
[value](../03-domain-model/glossary.md#value), the same kind as
`environment.name` and a `resolve()` result, and a provided one: the body is
handed it. Its real value is the data at that key path in the module's
validated input, which is the module's binding with its values replaced by
their real values and passed through the module's schema. A real value is the
schema's output, so a field typed `number` by a `string.integer.parse` schema
receives `4`, not `'4'`. An input field is deploy-time: its real value is known
by the end of Load. A field bound to `envSecret()`, `generatedParam()` or
`serviceOrigin()` has a pointer as its real value, never a value, although its
type is the schema's output type.

The body can only pass an input field on. Turning one into text or a number,
serializing it, listing its keys, iterating it, testing it with `in`,
assigning to it or freezing it throws a Load error naming the field. `===`,
`!==` and `switch` against a literal fail to compile, because the types do not
overlap. A truthiness check (`if`, `!`, `&&`, `||`, `? :`, `??`) and `typeof`
cannot be caught: the body sees an object, so such a branch always goes the
same way, and the graph's structure still cannot vary. A body reaches only the
keys every member of a union schema has, and an array field has no element
access; to narrow, forward the whole `input` or narrow inside a `resolve()`
function.

An input field is accepted in four places:

- **a service's `input` binding**, at any depth, including the whole binding;
- **a module's `input` binding**, at any depth, including the whole binding;
- **a `resolve()` dependency**: `fn` receives the real value. For a field
  bound to a runtime value, that is a pointer, which the function may return
  unchanged;
- **a service param or a resource prop**, when its real-value type is plain
  data: not optional, and not a secret.

Nowhere else: not as a `provision()` id, not in `deps`, not in a module's
`secrets` or `params` binding, and not as an `expose` return. Load refuses each.

**How Load validates.** Load records each module's input binding at its
`provision()` call and validates it with the module's schema during the second
pass, synchronously, after every module body has run. A child's real value is
read from its parent's validated output, so the parent's schema runs first; an
async schema fails the Load. Each module's binding is validated once per Load,
whether or not the body uses any field. A secret source reaches the schema as
an empty `SecretString` box and is put back in the validated output, as the
Prisma Cloud serializer does for a service. A param source known only at boot
reaches the schema as the sentinel its target names, an empty `SecretString`
box when it is redacted, and is put back at its path; a schema that changes
such a field fails the Load. An optional field the binding left
out has no real value, and a binding that forwards it leaves the key out.

A root's input is the config pool, validated by its schema before any other module's binding.

**Not detected.** Load cannot list a schema's keys, because Standard Schema
exposes only `validate`. So a declared input field the body never uses is not
an error, unlike an unused `deps` entry.

## `provision()` accepts modules

A module overload mirrors the service forms:

```ts
provision<D extends Deps, E extends Expose, I extends StandardSchemaV1 | undefined>(
  child: ModuleNode<D, E, I>,
  opts: {
    id?: string;
    deps: DepBindings<D>;                                      // omitted when D is empty
    input: ModuleInputBinding<StandardSchemaV1.InferInput<I>>; // required when the module declares an input schema
  },
): ProvisionedRef<E>;
```

The returned ref is indistinguishable from a provisioned service's. Whether an
id names a service or a sub-module is invisible to sibling wiring, so topologies
nest to any depth.

## Load: flattening, addresses, validation

Load remains the single walk that turns authoring into the flat graph
everything downstream consumes:

- **Recursive flattening.** A provisioned module's body executes during Load
  (exactly once, pure), its children joining the same graph. Services remain
  the only leaves; lowering, target packs, and assembly never learn that
  nesting exists.
- **Hierarchical addresses.** The root's address is the deployed app name. A
  child's deploy address is its parent's address plus its provision id, joined
  with `.` (`shop.auth.api`) — the separator the address scheme
  and the serializer's config-key derivation already use. Deploy-time bundle
  correlation keys carry the full address, since provision ids are unique only
  within their scope.
- **Boundary validation** — Load errors, each naming its fix:
  - a declared `deps` entry never forwarded into any provision nor returned
    as an exposed interface — a boundary that promises a dependency it ignores lies to its
    consumers (re-offering a dependency as an exposed interface is using it);
  - a declared `expose` key missing from the body's return, or whose returned
    interface fails `satisfies()` — the runtime backstop of the compile-time check;
  - a module with non-empty `deps` deployed as root — the same "wire this from a
    composing scope" error a service with unwired dependency inputs gets;
  - a cycle through forwarding edges — expressible only once boundaries
    exist, so composition brings the check with it;
  - a module's input binding the module's schema refuses — validated in the
    second pass, after every module body has run.

The boundary is a wiring-time contract, checked at compile time and re-checked
at Load. It is not enforced against a body that captures a sibling scope's ref
through a closure and wires it directly: such a ref still resolves to a real
provisioned address, so Load accepts it silently rather than routing it through
the declared input. Per-scope provenance tracking would close that, and is a
later refinement — the shared address table that makes legitimate
ancestor-forwarding resolve is the same mechanism that lets closure capture
through.

## Runtime: nothing

A module does not exist at runtime. No process boots "a module"; there is no
module-level `run` or `load`. The boundary is a Load-time construct that
disappears into graph edges.

## Consuming a module from another module

A module is an exported value. Importing one — from a file in the same repo, a
workspace package, or a published package — is ordinary importing, and wiring
it is the same `provision()` call regardless of where it came from. Nothing
about consumption is specific to packaging.

What deploy requires is also provenance-independent, and already follows from
the path and build rules:

- **Built runnables must exist** at each service descriptor's
  `dirname(module)`-relative `entry` when `prisma deploy` runs (ADR-0005).
  Who built them is the consumer's arrangement with the module: an app importing
  module source builds it like the rest of its code; a prebuilt package ships its
  runnables and satisfies the requirement at publish time (ADR-0004 makes the
  paths resolve correctly either way, including from inside `node_modules`).
- **A service's build descriptor names its extension as data** (`extension` +
  `type`), and the `composer` section of the consuming app's `prisma.config.ts` lists the extensions
  its graph uses — including those a published module uses internally. The
  module documents them and can re-export a config fragment
  (`extensions: [...authModuleExtensions, prismaCloud()]`), keeping the cost to
  one line (ADR-0017).
- **For prebuilt distribution, versioning is the package manager's job, used
  as designed**: the module declares `@prisma/composer*` and its target pack as peer
  dependencies, and the declared range asserts that the reader code frozen
  into its published runnables understands what the consumer's deploy-time
  serializer writes. The serialized-config and stash encodings are public
  protocol under semver: a breaking format change is a major version of the
  pack.

Consumers depend on a module's *contracts*, never on the module itself — the wiring
site decides what fills a slot. Any node exposing the same contract
substitutes without the consumer changing:

```ts
const auth = provision("auth", fakeAuthService);   // same contract, no database
```

## Extension points (designed for, not yet built)

- **Target-neutral modules** — a module is authored in one pack's vocabulary and
  deploys to that target; a target-neutral authoring vocabulary would make a
  module portable across targets.
- **Shared resources** — one resource provisioned once and wired into several
  consumers turns the topology from a tree into a DAG (single provisioning,
  per-consumer config), and pairs with data contracts to bound what each
  consumer may touch.

## Related

- [`ADR-0016`](../90-decisions/ADR-0016-a-module-has-the-same-boundary-as-a-service.md)
- [`core-model.md`](core-model.md) — the node types and wiring machinery this
  extends (`Expose`, `ProvisionedRef`, `Wiring`).
- [`deploy-cli.md`](deploy-cli.md) — the pipeline that consumes the flattened
  graph.

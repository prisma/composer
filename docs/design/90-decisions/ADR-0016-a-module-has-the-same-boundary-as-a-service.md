# ADR-0016: A module has the same boundary as a service

```ts
// the app's topology
import { auth } from '@acme/auth-module'; // a module, installed from npm
import { serviceOrigin } from '@prisma/composer-prisma-cloud';
import storefront from './storefront/service.ts';

export default module('shop', { expose: { web: storeContract } }, ({ provision }) => {
  const identity = provision(auth(), { input: { baseUrl: serviceOrigin('shop.storefront') } });
  const store = provision(storefront, { deps: { auth: identity.verify } });
  return { web: store.web };
});
```

`auth()` returns a module. `shop` provisions it exactly as it provisions the `storefront` service: the same `provision()` call, an `input` binding typed from the node's schema, and a reference whose exposed interfaces, such as `identity.verify`, wire into another node's dependencies.

## Decision

A module declares the same boundary a service does:

- **dependencies**, `deps`: typed slots, each wired to an interface another node exposes ([ADR-0063](ADR-0063-a-node-depends-on-an-interface-or-exposes-one.md));
- **exposed interfaces**, `expose`: the contracts the module offers, each returned by its body as a port of a node it provisions;
- **input**, `input`: its configuration, one Standard Schema, as a compute service's is ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md), [ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).

`provision()` accepts a module wherever it accepts a service. It takes the same options, `deps` and `input`, each required exactly when the node declares it, and it returns the same `ProvisionedRef`, with one port per exposed interface. The `input` binding has one type for both kinds of node, `InputBindingOf<I>`, built from the schema's input type. So modules nest, and a consumer cannot tell a provisioned module from a provisioned service. The two differ only in what the framework can see: a service's body is a black box that boots, and a module's body is topology that runs at Load.

## Reasoning

**What this makes possible is installing a whole bounded context from a package.** In the example, `@acme/auth-module` deploys its own compute and owns its own data inside the app's topology, and everything reaches it through typed interfaces. The app never learns how many services it contains or what its database looks like. That is a reusable module: not a hosted service you call, and not a library you embed in your process, but a deployable component with a typed boundary.

**A module needs a boundary, and the model already has one.** A service declares dependencies and exposed interfaces, and `provision()` returns a reference with one typed port per exposed interface, which the wiring checks against the dependency it fills. Reusing that boundary for modules is the whole decision. It keeps wiring the same at every level of the tree, which is what lets composition compose: an enclosing module wires "a node with typed dependencies, exposed interfaces and input" without asking which kind of node it is.

**One binding type keeps the boundary the same for configuration too.** A module's input binding and a service's are typed from the schema by the same mapping. A binding that type-checks for a module with some schema type-checks for a service with that schema, and a binding the schema would refuse fails to compile for either. Replacing a service with a module that has the same schema, or the reverse, changes no binding.

**Forwarding is data flow, with no mechanism of its own.** The body is a function. It receives its dependencies as `deps`, its configuration as `input` and the environment's facts as `environment`, and passes them into the `provision()` calls that need them: they flow down by being passed. Its exposed interfaces are its return value: they flow up by being returned. Both directions are checked by the types and by the same contract check the flat wiring uses. An input field is a value, not data, so the body passes fields on by name and never reads them ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).

**The boundary makes a module replaceable by a fake.** A consumer depends on a contract, never on a module. The storefront above requires something that satisfies `identity.verify`'s contract, and the module that wires it decides what that is. Replace `auth()` with a one-service fake that exposes the same contract and the storefront does not change a line: a test topology is a different wiring file.

**Distribution follows from decisions already made.** A module package ships its services with their built runnables. Paths resolve relative to the file that writes them ([ADR-0004](ADR-0004-paths-resolve-relative-to-the-authoring-file.md)), so assembly finds output inside `node_modules/@acme/auth-module/` as it would in the app's own tree, and built output exists before deploy because the package was built when it was published ([ADR-0005](ADR-0005-users-build-the-framework-assembles.md)). The boot wrapper inlines each service's imports from that package's own dependencies ([ADR-0008](ADR-0008-wrapper-inlines-everything-except-runtime-builtins.md)). Version compatibility is the package manager's job: a module declares `@prisma/composer` packages as peer dependencies, and its declared range says that the reader code in its published runnables understands the input document the app's deploy writes.

**A module's build choices stay inside it.** A consuming app must not have to declare `@prisma/composer/nextjs` because a module it installed uses Next.js inside. How the deploy loads build adapters and targets is a separate decision ([ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md)); this one only states the requirement. The deploy target stays the application's own declaration, one per application ([ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md)).

## Consequences

- The authoring surface is `module(name, { deps?, input?, expose? }, body)`. The body receives `{ deps, input, environment, provision }` and returns one port per declared exposed interface. A module with an empty boundary, also written `module(name, body)`, is the closed form a deploy root takes.
- `module()` refuses a `params` or `secrets` key, and `provision()` of a module refuses a `params` or `secrets` map, each with an error naming `input`. A module takes its configuration only through `input`; a service keeps its reserved `params`, such as `port`.
- Load checks the boundary, and each failure is a Load error that names its fix: a declared dependency the body neither passes on nor returns; a declared exposed interface the body does not return, or returns a port that does not satisfy; a root that declares dependencies, since nothing above it can wire them; and a dependency cycle. A declared input field the body never uses is not an error, because Load cannot list a schema's keys.
- Deploy addresses are hierarchical: a child's address is its parent's plus its provision id, and assembled bundles are keyed by the full address.
- The input document's format is public surface: a module published against a target freezes its reader code, so a format change is a breaking release of the target.
- A reusable module is written in one target's vocabulary, such as `@prisma/composer-prisma-cloud`'s, and deploys only to that target.
- Nothing about a module exists at runtime. Load flattens modules into the graph, and services remain the only things that boot.

## Alternatives considered

- **Modules stay root-only wiring scripts**, with no boundary. Rejected: a module that cannot be wired cannot be installed, faked or nested, so every application would inline the topology of everything it uses.
- **A separate "package" or "component" concept beside the module.** Rejected: a second boundary to learn, wire and check, duplicating what services already have.
- **Forwarding as declared mappings**, a table linking each dependency to a child and each child's port to an exposed interface. Rejected: it is easier to inspect, but it adds a wiring language where a function already serves, and the body still has to exist for `provision()`.
- **Per-key `params` and `secrets` slots on modules**, which an earlier version of the module boundary had. Rejected: a module would take configuration in a different shape from a service ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).
- **A typed binding for modules and a loosely typed one for services**, which an earlier version had. Rejected: the same binding would type-check for one kind of node and not the other, and a service binding that type-checked could still fail the deploy.
- **Naming the two ends of a connection "input" and "output"**, which an earlier version did. Rejected: two traditions give the same ends opposite names ([ADR-0063](ADR-0063-a-node-depends-on-an-interface-or-exposes-one.md)).

## Related

- [ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md): a module's input.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md): a service's input, and the binding type both share.
- [ADR-0063](ADR-0063-a-node-depends-on-an-interface-or-exposes-one.md): dependencies and exposed interfaces.
- [ADR-0013](ADR-0013-resources-are-provisioned-by-modules-deps-are-declarations.md): a resource reaches a dependency as the same contract-carrying reference a service's port does, so forwarding handles both.
- [ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md), [ADR-0004](ADR-0004-paths-resolve-relative-to-the-authoring-file.md), [ADR-0005](ADR-0005-users-build-the-framework-assembles.md), [ADR-0008](ADR-0008-wrapper-inlines-everything-except-runtime-builtins.md) and [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md): why an installed module deploys.
- [module-composition.md](../10-domains/module-composition.md): the full design of modules.

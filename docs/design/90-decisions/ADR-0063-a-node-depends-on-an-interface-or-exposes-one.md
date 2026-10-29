# ADR-0063: A node depends on an interface, or exposes one

## Decision

The two ends of a connection are named by what the node does with them. A node **depends on** an interface, or it **exposes** one.

- An **interface** is the typed thing a connection carries: an RPC contract, a raw HTTP connection, a data contract. In prose it is an interface; in code it is a `Contract` (`rpc(contract)`, `rawHttpContract`, `dataContract()`). An interface in Composer's terms is what the ports-and-adapters literature calls a port: it can be exposed, or required as a dependency, by any node. That analogy is made once, here and in the glossary, and the word "port" is not otherwise used.
- A **dependency** is a node's need for an interface. It is declared with `deps` on a service or a module, and is wired to an exposed interface of a type that satisfies it.
- An **exposed interface** is one a node offers for others to depend on. It is declared with `expose` on a service or a module; a resource exposes the one interface it `provides`.
- A **connection** wires a dependency to an exposed interface.

**Input** and **Output** are retired as the words for the two ends. The only user-facing surface that used one of them for a dependency, the module body's `inputs`, is renamed `deps`:

```ts
export default module('auth', { deps: { db: rawPostgres() }, expose: { verify: authContract } },
  ({ deps, provision }) => {
    const svc = provision(authService, { id: 'api', deps: { db: deps.db } });
    return { verify: svc.verify };
  });
```

"Input" keeps its one other meaning, the configuration document a service or module declares as `input` ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md), [ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)). That is not an end of a connection.

The application topology keeps `in` and `out` as the port field on the wire (pdp-control-plane's `projects/branch-topology/spec.md`; Composer writes it in `packages/1-prisma-cloud/0-lowering/lowering/src/builds/application-topology.ts`): `in` is the dependency end and `out` is the exposed end. The Console draws them as it does today.

## Reasoning

**The two words were ambiguous, because two traditions give the same two ends opposite names.** Take a service `web` that offers an HTTP API and needs a database.

| | The dataflow reading, which Composer's documents used | Ports and adapters (Cockburn; Clean Architecture) |
| --- | --- | --- |
| The HTTP API `web` offers | output: other nodes call `web` through it | input port: calls come into `web` through it |
| The database `web` needs | input: `web` calls the database through it | output port: calls go out of `web` through it |

The dataflow reading names an end by who provides it: the database is provided to the service, so it is an input. Ports and adapters names an end by which way calls travel: the service calls out through the database, so it is an output port. Both readings are internally consistent, and every end has both aspects, so either word fits either end depending on which aspect the reader weighs. The documents defined the words by position in the authoring surface, "Inputs arrive as arguments, Outputs are the return", and a reader who brought the other tradition read every sentence backwards. The design discussion that settled this record went through exactly that, sentence by sentence, until it was clear the words were the problem.

**The words that name the relationship do not have the problem.** Whether a node depends on an interface or exposes one is a fact about the node, not a direction a reader has to pick. The authoring surface already said it: `deps` and `expose`. The glossary and the design documents now say the same.

**"Interface" is the noun, and it is already in the glossary.** A connection type was "its kind and its named interface". The code calls it a contract, which stays: `Contract` is the runtime value with its `kind` and its `satisfies()`, and renaming the type buys nothing.

**"Port" stays out of the user's view.** It sounds like an HTTP or TCP port, which Composer also has (`service.port()`). The analogy is useful once, for a reader who knows ports and adapters; it is not a term.

**The topology's `in` and `out` are not renamed.** They are a field on a platform API that the Console reads, owned by the Portal team, and their meaning is unambiguous once defined: `in` is a dependency, `out` is an exposed interface. A field rename would churn two repositories for a word users never see.

## Consequences

- The glossary's Connections section defines Interface, Dependency, Exposed interface and Connection, and its Input and Output entries are gone. The "Port — Input / Output by position" entry is gone; the position rule survives in the authoring-surface document in the new words.
- Every design document that said Input or Output for an end of a connection says dependency or exposed interface: the domain map, the layering map, the authoring-surface narrative, the example app, the guiding principles, and the domain documents.
- `ModuleContext.inputs` is `ModuleContext.deps`. The guide's module section carries the upgrade note. `InputRef`, the type of one forwarded dependency, keeps its name in code, as does `ServiceNode.inputs`, the dependency-slot map on a node: both are inside core and the extensions, and renaming them is recorded as debt in `.drive/deferred.md`.
- A public URL ([ADR-0060](ADR-0060-public-traffic-reaches-a-service-through-a-public-url.md)) depends on the service's exposed HTTP interface and exposes nothing.
- Ingress is the service's exposed HTTP interface made reachable from the public through a public URL node; egress is a service's dependency on something outside the topology, carried as configuration.

## Alternatives considered

- **Keep Input and Output, defined by the dataflow reading.** Rejected: the definition was already written that way, and the discussion that produced this record shows it does not hold in a reader's head against the other tradition.
- **Input and Output, flipped to the ports-and-adapters reading.** Rejected: it renames `ctx.inputs`, flips the meaning of the topology's `in`/`out`, and moves every port in the Console to the other side of its card, for words that remain ambiguous to the next reader from the other tradition.
- **Provided and required interface, UML's ball-and-socket.** Rejected in favour of the words the authoring surface already uses, `deps` and `expose`; "provider" also collides with an Alchemy provider.
- **Driving and driven ports.** Rejected: nobody on the authoring surface says "driven", and the word port is out.
- **Renaming `expose` to `provides` so services match `resource({ provides })`.** Rejected for now: a user-facing rename for consistency between a keyword and a verb that the prose no longer uses.

## Related

- [ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md): a module's boundary is `deps` in and `expose` out; amended by this record's words.
- [ADR-0013](ADR-0013-resources-are-provisioned-by-modules-deps-are-declarations.md): a dependency is a contract-checked slot.
- [ADR-0054](ADR-0054-raw-http-is-the-untyped-tier-of-service-connections.md): the raw HTTP interface.
- [ADR-0060](ADR-0060-public-traffic-reaches-a-service-through-a-public-url.md): the public URL, which depends on an exposed HTTP interface.
- [glossary.md](../03-domain-model/glossary.md), [authoring-surface.md](../03-domain-model/authoring-surface.md), [domain-map.md](../03-domain-model/domain-map.md).

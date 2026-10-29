# C1 — system design review of the built branch (architect)

Branch `claude/resolve-values-ca39d3` against `origin/main`, reviewed 2026-10-29.

Read first: `CLAUDE.md`; both principles files; the glossary entries Module, Service, Resource, Value, Input, Output, Ingress / Egress, Environment, Port, Load / Hydrate; the decision index; the resource decision (ADR-0013), the scheduled-work decision (ADR-0020), the service-input decision (ADR-0042), the error-envelope decision (ADR-0044), the public-URL decision (ADR-0060) and the `resolve()` decision (ADR-0062), each with its amendment note; `core-model.md` and `module-composition.md` as changed on the branch; the slice `spec.md` and `plan.md`; the design-time reviews in `reviews/design/`. Code read in full: `value.ts`, `resolve-values.ts`, the diffs to `node.ts`, `graph.ts`, `graph-types.ts`, `load-module.ts`, `load-service.ts`, `control/deploy.ts`, the CLI's `pipeline.ts`, `generate-stack.ts`, `generate-dev-stack.ts`, `execute-deploy-destroy.ts`, `execute-dev.ts`, the Prisma Cloud `compute.ts` for comparison, and the titles and structure of every new test file.

Settled points not reopened here: one `Value<T>` type; `environment.name` as a provided value; sources are not values in this slice; a resource keeps `provides`; `deps` (not `wiring`) for a resource's producers; `props` for its configuration; both environment options optional; the port-word rename is its own decision record.

## Summary

The branch adds one concept, the value: an opaque stand-in for data that Load knows only at its end. It adds one phase, a second pass of Load that runs after `provision` is sealed. It extends one existing concept, the resource, so that a resource can declare dependency slots wired at construction and carry `props`. The shape is right. The concept lives in core, the pass lives in Load, the graph handed to lowering holds only plain data, and nothing target-specific entered core. The CLI's only new dependency is passing the environment name into `Load` and into the generated stack files. The Prisma Cloud extension does not change.

The findings are about names and about where a few things live. One introduced name, `PlainValue`, contradicts the vocabulary the slice just defined. Resolved resource props live on a copied node while every other resolved binding lives in a table on the graph, and that choice puts a rule on every extension's resource class. A resource descriptor reads its slots through a free function that takes five arguments, all of them fields of the context it already has. Some new glossary prose widens "Resource" past its own lead sentence, and uses the inverted Input word for the public URL, which is where the inversion reads most backwards. The rest are small.

## What is sound

- **Dependency direction.** `value.ts` imports only `blindCast`, so it is a leaf. `node.ts` imports it. `resolve-values.ts` imports `graph-types.ts`, `node.ts` and `value.ts`, and is imported only by `load-module.ts`. The CLI imports nothing new from core beyond the `LoadOptions` shape it passes. No core file imports a target.
- **Planes.** Values are authoring data. The second pass runs inside Load, so the CLI's preflight, coverage check and topology submission, and the deploy engine's lowering, all see the same resolved graph. Lowering never sees a `Value`. This is what the `resolve()` decision asks for.
- **The structure rule is enforced in one place.** `provision` is sealed by one flag that `loadModule` owns and every nested `flatten` shares, so a `provision` that escaped through a closure is sealed too. Values are refused, each with its own message, where they would decide structure: a provision id, a `deps` entry, a resource's `deps`, and a module's `secrets` and `params`.
- **The public surface is small.** The barrel gains `Value`, `RealValuesOf`, `EnvironmentFacts`, `PlainValue`, `LoadOptions`, `DepBindings`, `ResourceProp`, `ResourceProps`, `isValue` and `resolve`. The origin, its symbols, `originOf` and `environmentFacts` stay inside core. A module body has no way to read a value.
- **Vocabulary from the design review landed.** "Real value" is used consistently in the glossary, the doc comments and the error texts. `RealValuesOf`, `EnvironmentFacts` and `props` replaced the earlier names. `resolve` is the verb for computing values, `resolveValues` names the pass, and `describeSite` and `ValueBindingSite` say what they are.
- **The resource change reuses existing machinery.** The slot is the same `DependencyEnd`. Wiring goes through the same `pending` list, `validateWiring`, `wiringEdges`, `recordAuthoredWiring` and the dependency-cycle check that a service uses. `serviceInputs` became `dependencySlots` and now serves both kinds. The `in` ports of a resource reach the application topology unchanged in shape.
- **The amendment notes are honest.** Each of the resource, scheduled-work, public-URL and `resolve()` decisions says what changed, on what date, and what still stands. The `resolve()` decision keeps its old `ResolvedValue` name in the body, as amended records should.

## Findings

### A01 — `PlainValue` names the opposite of a `Value` (medium)

`packages/0-framework/1-core/core/src/value.ts` lines 45–52; `node.ts` lines 199 and 256; `exports/index.ts` line 85.

The slice defines "value" as the opaque stand-in and "real value" as the data it stands for. The glossary adds that lower-case "value" keeps its plain meaning elsewhere. But `PlainValue` is a capitalised type exported beside `Value`. Read cold, `PlainValue` is "a plain kind of `Value`", the way `PlainObject` is a kind of object. It is the reverse: it is the set of data a `Value` may stand for, and it never contains a `Value`. `Value<PlainValue>` reads as "a value of plain values". The spec's own prose and every error text already say "plain data": "`fn` returns plain data", "`resolve()` returns plain data: strings, finite numbers, …", and `isPlainObject` says "the only objects Load walks into".

Proposal: rename `PlainValue` to `PlainData`. Then `Value<PlainData>` reads as "a value standing for plain data", which is what it is. It is exported but new on this branch, so the rename is free now and breaking later.

### A02 — resolved props live on a copied node; every other resolved binding lives on the graph (medium)

`load-module.ts` lines 887–940 (`resolvedNodes`, `withResolvedProps`); `node.ts` line 643 (the `#private` rule on `ResourceNodeBase`); `graph-types.ts` lines 110–112; spec § 6.4 and § 13 decision 8.

A service's input binding and param bindings are stored on the graph, in `graph.inputBindings` and `graph.params`, keyed by address. The second pass substitutes into those tables, and nodes are never touched. A resource's props are stored on the node, so the pass has to build a new node object with `Object.create` and property descriptors. That has three consequences that reach past this slice:

- Every extension's resource class now carries a rule that lives only in a doc comment: no `#private` fields.
- For a resource whose props held a value, `graph.nodes` holds a different object from the one the author built and from the one in Load's `byId` map. A node's object identity is no longer stable across the phases.
- The resolved form of a binding is found in two different places depending on the node's kind.

The asymmetry has a real cause. Props are set by the factory at construction, while service bindings are set at `provision()`. That explains why the authored props sit on the node. It does not require the resolved props to sit there too.

Proposal: keep the authored `props` on the node, and record the resolved props in a graph table alongside the other two, for example `graph.resourceProps: ReadonlyMap<NodeId, ResourceProps>`, or hand them to the resource descriptor as a field of its lowering context. `resolveValues` already returns exactly that map. This would reverse spec § 13 decision 8 (the prototype-keeping copy) and remove the `#private` rule. If the copy stays, add the rule to `core-model.md`'s extension contract, not only to a doc comment.

### A03 — a resource descriptor rebuilds its own config from five context fields (medium)

`control/deploy.ts` lines 365–444 (`buildConfig`, `connectionInputs`); `exports/deploy.ts` line 2 (the wildcard re-export puts `connectionInputs` in `@prisma/composer/deploy`).

For a service, core builds the `Config` and hands it to the descriptor's `serialize`. For a resource, the descriptor must call `connectionInputs(ctx.node, ctx.id, ctx.graph, ctx.lowered, ctx.provisioned)` itself. Every argument is a field of the `LowerContext` the descriptor already holds. The function becomes extension-facing surface through the wildcard export, with a five-argument signature that exposes how core computes config rather than what a resource receives. When P1 writes the public URL's descriptor, it will be the first extension to depend on it.

Proposal: either core computes the slots' connection params for a resource and passes them in, the way it passes `Config` to a service, or the exported function takes the context: `connectionInputs(ctx: LowerContext)`. The first keeps the two node kinds symmetric. The second is the smaller change. Decide before P1 depends on the current signature.

### A04 — the glossary's Resource entry now contradicts its own first sentence, and uses the inverted Input word for an ingress (medium)

`docs/design/03-domain-model/glossary.md` lines 57–83 (Resource) and 229–240 (Ingress / Egress).

The Resource entry opens: "A provisioned dependency with a managed lifecycle … Its defining characteristic is the state it holds", and "a Resource's Output provides it, a Module's Input requires one". The new paragraph adds a public URL as a Resource. Nothing depends on a public URL, nothing in the graph wires to its contract, and it is defined by its lifecycle and its edge, not by the data it stores. The lead sentence now has a counterexample in the same entry. The resource decision's amendment already uses the right test: a provider manages its lifecycle.

The new paragraph also says a Resource "may also declare Inputs … so it can depend on the Service it serves". Will has ruled the Input and Output words inverted. This is the one place where the inversion reads most backwards. The Ingress entry calls the public boundary an "Output", and now an ingress adapter reaches it through an "Input". The rename is out of scope, but new prose should not add another sentence that the rename must rewrite.

Proposal: change the Resource lead to the lifecycle test, which the entry's second paragraph already states, for example "A node whose lifecycle a provider manages: the framework can create, update and delete it. Most Resources hold state, such as a database, a bucket or a cache." In the new paragraph, say "dependency slots" instead of "Inputs", as the resource decision's amendment note does. "Dependency slots" stays true after the rename.

### A05 — the set of environment facts is written three times with no type link (low)

`value.ts` lines 22 and 108–112 (`fact: 'name'`, `EnvironmentFacts`); `graph.ts` line 23 (`LoadOptions.environment`); `resolve-values.ts` line 162.

`ValueOrigin`'s `fact: 'name'`, `EnvironmentFacts.name`, and the `{ readonly name: string }` shape in `LoadOptions` and in `resolveValues`'s input are three independent spellings of one list. The design review asked for `LoadOptions.environment` to have the shape of `ctx.environment` so that a second fact is one new key. With the shapes unlinked, a second fact is four edits that the compiler does not connect.

Proposal: derive the other spellings from `EnvironmentFacts`. Make `fact: keyof EnvironmentFacts`. Name the real-value shape once, as a mapped type over `EnvironmentFacts` (`{ readonly [K in keyof EnvironmentFacts]: EnvironmentFacts[K] extends Value<infer T> ? T : never }`), and use it in `LoadOptions` and `resolveValues`. `LowerOptions.environment` stays a plain string, as the design review agreed.

### A06 — a param binding accepts a value of any type, an input binding only of plain data (low)

`node.ts` lines 172–177 (`ParamBindings`) and 192–201 (`InputBinding`); `__tests__/value.test-d.ts` lines 52–60.

`InputBinding` and `ResourceProp` accept `Value<PlainValue>`, so the compiler refuses `Value<Date>`. `ParamBindings` accepts `Value<InferOutput<schema>>`. For a param whose schema output is a `Date` or a class, the compiler accepts a value that the second pass always rejects as "not plain data". The three places that accept a value make different promises at the type level for one runtime rule.

Proposal: intersect the param's type with the plain-data type, `Value<InferOutput<…> & PlainData>` or an equivalent conditional, and add the `Value<Date>` case to the type test.

### A07 — `dependencySlots` and `slotsOf` are near-synonyms with different results; `serviceId` now names a resource (low)

`packages/0-framework/1-core/core/src/load-service.ts` lines 25 and 53–91.

`slotsOf(node)` returns a node's slot declarations. `dependencySlots(node, serviceId)` returns the graph nodes and edges built from those slots. A reader would expect both to return slots. `dependencySlots` now accepts a resource, but its parameter is still `serviceId` and its first error says `Service "…" has no inputs map.` for a resource too. The spec allowed keeping the parameter name, but the error text now says something false.

Proposal: rename `dependencySlots` to say what it returns, for example `slotNodesAndEdges`, rename `serviceId` to `nodeId`, and make the first error say `Node "…" has no inputs map.` The other messages already avoid naming the kind.

### A08 — `LoadOptions` in `graph.ts` creates a type-only import cycle (low)

`graph.ts` lines 1–24; `load-module.ts` line 3.

`graph.ts` imports `loadModule` from `load-module.ts`. `load-module.ts` now imports the `LoadOptions` type from `graph.ts`. `graph-types.ts` exists to hold the types that `Load` and its helpers share, such as `Graph`, `LoadError` and `NodeId`, so that the helpers do not import `graph.ts`.

Proposal: declare `LoadOptions` in `graph-types.ts` and re-export it from `graph.ts`, as `Graph` and `LoadError` are.

### A09 — the recorded reason for `deps` understates the name clash (low)

Spec § 6.2 line 400; `node.ts` line 243.

The spec says "the one collision is inside core, on `ModuleNode.deps`", and the doc comment repeats it. The clash is also in the two author-facing factories. `module(name, { deps })` declares slots, and the Prisma Cloud `compute({ deps })` declares slots. Now `resource({ inputs, deps })` uses `deps` for producers. Will chose `deps` knowing the trade-off, and this review does not reopen it. But the record a later reader checks should state the full cost that was accepted.

Proposal: change the spec sentence and the doc comment to name all three: `ModuleNode.deps`, `module()`'s boundary `deps`, and `compute()`'s `deps` declare slots, while `provision()`'s and `resource()`'s `deps` bind producers.

### A10 — the test files split the second pass across two files and label first-pass checks as second-pass (low)

`__tests__/resolve-values.test.ts` lines 66 and 314–445; `__tests__/resource-slots.test.ts` lines 268–318.

The second pass resolves values in three kinds of binding site. Service inputs and params are tested in `resolve-values.test.ts`. Resource props are tested in `resource-slots.test.ts`, although props are not slots. Inside `resolve-values.test.ts`, one `describe("Load's second pass")` also holds the refusals of a value as an id, a `deps` entry, a `secrets` binding and a `params` binding. Those run during the first pass, inside `provision()`. The file layout should show the slice's three parts: values and `resolve()`, the second pass, and resource slots.

Proposal: move the "a value in a resource's props" block into `resolve-values.test.ts`. Split that file's tests into `describe("Load's second pass")` and `describe('where a value is refused')`, with the seal tests in the first.

### A11 — `ResourceProp` names a member at any depth, and is the third hand-written plain-data union (low)

`node.ts` lines 192–201 and 249–258; `value.ts` lines 45–52.

`ResourceProp` is not a property. It is any member at any depth inside props, including an array element. `PlainValue`, `ResourceProp` and `InputBinding` are three recursive unions over the same plain-data skeleton. They differ only in which extra leaves they allow: none, values, and values plus sources.

Proposal: rename `ResourceProp` to something that says it is a member at any depth, for example `PropsMember`. Optionally, define the skeleton once with the leaf as a parameter, so the three cannot drift. Leave this second step out if it makes compiler errors harder to read.

### A12 — `ValueBindingSite.channel` reuses a word the guides define differently (low)

`resolve-values.ts` lines 11–18.

The guide and the core-concepts skill both say "two channels: dependencies and input". Here `channel` is `'input' | 'param' | 'props'`. That is a different partition, and `param` belongs to the guide's input channel. The type is internal, so the cost is small.

Proposal: rename the field to `binding` or `kind`.

### A13 — "driver" is used in the glossary without a definition, and already means a database client there (low)

`glossary.md` lines 76–79 and 233; `core-model.md` lines 98–104 and 873 use "driver" for a database client library.

The public URL is now "a Resource by kind and a driver by role". The role is defined only in the scheduled-work decision. Elsewhere in the docs, "driver" means a database client library.

Proposal: add a short Driver entry: "a node that depends on what it sends work to and that nothing calls; cron and a public URL are drivers (the scheduled-work decision)." Or replace "a driver by role" with that clause in both places.

### A14 — "resolve" is also the verb for binding a param at lowering (low, debt)

`control/deploy.ts` line 311 (`resolveParam`); spec § 2 ("resolve is the only verb used for the act").

The spec makes "resolve" the one verb for computing a value. Lowering already has `resolveParam`, which picks a param's binding or default and checks it against the schema, a different act. A param bound to a value is now handled by `resolveValues` at Load and then by `resolveParam` at lowering. Environment resolution (the environment-as-stage decision) is a third meaning.

Proposal: no change in this slice. Record in `.drive/deferred.md` that `resolveParam` should become, for example, `bindParam` when that file is next touched.

## Architect-class concerns, and what is routed elsewhere

**In this pass (system shape):** A01, A05, A07, A11 and A12 are names and types. A02 and A03 are about where resolved data lives and the shape of the extension contract. A06 is a mismatch between what the types promise and what the runtime allows. A08 is dependency direction inside core. A04, A09 and A13 are the glossary and the decision record. A10 is how the tests partition the concepts. A14 is recorded debt.

**Routed to the principal-engineer pass:**

- Whether a resource built in one module body and provisioned in another fails with a clear error. The glossary now says it "can only be provisioned there". I did not check where that is enforced.
- Whether anything reads `byId` or holds the authored resource object after the props copy (A02 touches this from the shape side).
- The `found.length === 0` early return in `resolveValues`, and whether `substitute` keeps object identity for bindings with no value inside nested structures.
- Whether `collect`'s per-site `WeakSet` and `substitute`'s shared `inProgress` set behave correctly for a plain object shared between two bindings.
- The CLI's `runPipeline` parameter order and the destroy test's use of `globalThis`.

**Out of this skill's lenses:** the guide section's readability and the example's input key named `environment` beside `ctx.environment` (devrel). The port-word rename is Will's separate decision record.

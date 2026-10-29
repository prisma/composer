# C1 — system design review (architect)

Reviewed: `.drive/projects/public-urls/slices/c1-resolve/spec.md` and `plan.md`; the amendment notes at the top of ADR-0062, ADR-0060 and ADR-0013; the glossary's new `### Value` entry; entries 9 to 11 of `.drive/projects/public-urls/design-notes.md`.

Read first: `CLAUDE.md`; both principles files; the glossary in full; the decision index; ADR-0013, ADR-0020, ADR-0042, ADR-0060, ADR-0061 (index line), ADR-0062 in full, ADR-0059's reasoning on the word "environment"; `core-model.md` and `module-composition.md`; the project's `spec.md`, `plan.md` and `design-notes.md`. Code: core `node.ts`, `load-module.ts`, `load-service.ts`, `graph.ts`, `graph-types.ts`, `config.ts`, `control/deploy.ts`, `exports/index.ts`; the Prisma Cloud extension's `orm-postgres.ts`, `bucket.ts`, `compute.ts`.

## Summary

The core idea is sound and well placed: one opaque type for a handle whose real value comes later, a second pass inside Load with `provision` sealed, and only plain data reaching lowering. The problems are in the names the slice adds around it. The worst is `ResourceNode.deps`: everywhere else in core and in the authoring surface, `deps` on a node or in a node constructor means the slots a node *declares*, and here it means the producers a resource is *wired to*. Second, the decision that a public URL is a resource is recorded without reconciling it with the scheduled-work decision (a driver is "not a resource"), with the glossary's Ingress entry, or with the fact that every resource must provide a contract and gets an `$out` port, which the public-URL decision says it must not have. Third, the word "value" now names a handle while `Values<P>`, `InputValueOf<I>`, the new `ValuesOf<D>` and the glossary's Configuration entry use it for real data; the spec patches this with "real value" and "plain result", inconsistently. The rest is smaller: the opacity the spec claims is not what the public type gives, two verbs (evaluate, resolve) name one act, several error texts say "resolve() value" where `environment.name` is not one, and the amendment notes misattribute one statement and leave index lines and three documents unamended.

## What is sound

- One type, `Value<T>`, with provided and computed as an internal distinction. Matches the prior art cited and keeps the public surface small.
- The second pass in Load, not lowering. Lowering (the provisioning plane) receives plain data, as ADR-0062 requires ("Only the fully resolved graph is handed to Alchemy"), and the CLI's preflight sees resolved bindings.
- `LoadOptions.environment` beside `id`. Both are deploy-time choices the command makes, neither is authored.
- `isValue` follows `isNode`, `isSecretSource`, `isParamSource`, `isProvisionNeed`: `is` plus the type name, brand check only.
- `fact: 'name'` as "one reference per deploy-time fact", as ADR-0062 words it.
- Reusing `DependencyEnd`, `dependency` edges, `validateWiring` and `assertDependencyDag` for a resource's slot. ADR-0013's "one mechanism, one edge kind" holds.
- Amending ADR-0013 for "a resource may declare slots". It is the record of the resource model.

## Findings

### A01 — `ResourceNode.deps` means the opposite of `ModuleNode.deps` (high)

Spec § 6.2, § 6.3; `node.ts` lines 301 and 368; `load-service.ts` line 22; `compute.ts` lines 138 and 159.

Today `deps` on a node, and in a node constructor, is the map of declared slots. `ModuleNode.deps: D` holds `DependencyEnd`s. `compute({ deps })` declares slots and stores them as `ServiceNode.inputs`. `boundaryPortsOf` reads `node.kind === 'module' ? node.deps : node.inputs` because the two fields mean the same thing. `module-composition.md` says `deps` are "the same types services declare". Only `provision(child, { deps })` uses `deps` for the producers bound to those slots, and the code calls that "wiring" (`PendingWiring.wiring`, `localWiring`, `recordAuthoredWiring`).

The spec adds `ResourceNode.deps: DepBindings<D>` (bound producers) and `resource({ inputs, deps })`. A pack author writing `publicUrl` in the same package as `compute({ deps })` sees `deps` mean declarations in one constructor and bound producers in the next. A reader extending `boundaryPortsOf` to resources finds a `deps` field on a resource that is not the slots.

The asymmetry itself is real: a resource is wired once, when constructed; a service is wired at each `provision()`. The names should make that visible, not hide it under a reused word.

Proposal: the node field and the factory key are both `wiring`.

```ts
export interface ResourceNode<C, D, P> {
  …
  /** Dependency slots, as a service's `inputs`. Empty for a resource that depends on nothing. */
  readonly inputs: D;
  /** The producer wired to each slot. A resource is wired when it is constructed, a service at `provision()`. */
  readonly wiring: DepBindings<D>;
  readonly props: P;   // see A10
}
resource({ name, extension, provides, inputs, wiring, props })
```

Errors in § 6.3 follow: `resource() declares input "target" but its wiring leaves it unwired. A resource is wired when it is constructed.` and `resource() wiring names "extra", which is not a declared input.`

### A02 — every resource provides a contract and gets an `$out` port; a public URL must have neither (high)

Spec § 6.2, § 6.4 (`ports.push({ … RESOURCE_OUT_PORT … })`, `return refForResource(…)`); ADR-0060 Reasoning; glossary "Resource".

`ResourceNode.provides` is required ("the resource's single port"), Load always adds the `$out` port to the application topology, and `provision()` returns a ref that a consumer could wire into a slot. ADR-0060 says "a public URL's result is not captured and not exposed from its module, because nothing inside the graph consumes it". So P1 will have to invent a contract nobody consumes, show an `$out` port on the topology, and return a wireable ref. That decision belongs to the slice that changes the resource model, not to P1.

Proposal: decide it here. Either `provides` becomes optional, a resource without it has no `$out` port, and `provision()` returns `{ id }` only; or the ADR-0013 amendment records that a public URL provides a named contract and why exposing it is acceptable after ADR-0060 rejected it. The first fits ADR-0060; it is a change to ADR-0013 and should be in its amendment note.

### A03 — "a public URL is a resource" contradicts "a driver, not a resource" without saying so (high)

ADR-0060 amendment note; ADR-0060 body ("a driver wired to … as `cron` is"); ADR-0020 title, Consequences ("Cron and resources do not share a mould") and its Related line ("ADR-0060 models a public URL as a driver"); glossary "Ingress / Egress" ("a driver wired to the HTTP connection").

ADR-0020's test is direction: a resource is something a consumer calls; a driver calls you. By that test a public URL is a driver. The amendment applies the glossary's other test, a managed lifecycle, and calls it a resource. Both can be true, but only if "driver" is a role and "resource" a kind of node. Nothing written says that, and three documents still say "driver, not resource".

Proposal: add to the ADR-0060 amendment: "A public URL is a resource by kind, because a provider manages its lifecycle, and a driver by role, because it depends on what it sends traffic to and nothing calls it. The scheduled-work decision contrasted a driver with a resource a consumer loads; it does not rule out a driver whose lifecycle is managed." Amend ADR-0020's Related line to match, and the glossary's Ingress entry to "a resource wired to the HTTP connection a service exposes".

### A04 — "value" names a handle; four neighbouring names use it for real data (medium)

Spec § 2 (paragraph "Why the word value"), § 3.2 `ValuesOf`, § 3.3 `EnvironmentValues`; `config.ts` line 41 `Values<P>`; `node.ts` line 193 `InputValueOf<I>`; glossary "Configuration — params and their sources".

The spec argues `Value<T>` and `Values<P>` don't collide because the spellings differ. Read cold, `Values` is the plural of `Value`. After this slice the public barrel has `Value<T>` (a handle), `Values<P>` (hydrated param data), `ValuesOf<D>` (the real data behind handles), `InputValueOf<I>` (validated input data) and `EnvironmentValues` (an object of handles). Three of five mean real data. The glossary's Configuration entry also uses "value" for real data throughout ("turns … into a value", "a generated value"). To compensate, the spec says "real value" in § 2 and the glossary, and "plain result" in one error text.

Proposal:
- Make "real value" the one term for what a value stands for, in the glossary entry, every doc comment and every error text (see A09).
- `ValuesOf<D>` → `RealValuesOf<D>`.
- `EnvironmentValues` → `EnvironmentFacts`, and the constant `environmentValues` → `environmentFacts`. ADR-0062 calls these "deploy-time facts", the spec's own field is `fact`, and the doc comment already says "The deploy-time facts a module body receives".
- Record `Values<P>` → `ParamValues<P>` as debt for the next breaking release; it is public, so not in this slice.
- Add one sentence to the glossary Value entry: "Elsewhere in this glossary 'value' in lower case means plain data, as in a param's value."

### A05 — the glossary's definition excludes runtime values and coins "deployment system" (medium)

`docs/design/03-domain-model/glossary.md` lines 132–144; spec § 2; ADR-0062 amendment.

The lead sentence says a value stands for "something that has a real value once the graph is fully evaluated". The second bullet says a runtime value never has one at deploy time. "Deployment system" appears nowhere else; the glossary's words are "the platform" and "the hosting plane". ADR-0062's own table names the same axis "known at deploy time" and "held by the platform". "Wherever a value of its type is accepted" uses "value" in the ordinary sense inside the definition of the term.

Proposal, lead paragraph: "An opaque stand-in, in a module body, for data that is known later: by the end of Load for a deploy-time value, or only on the platform for a runtime value. The body can pass a value wherever data of its type is accepted, and can do nothing else with it." Runtime bullet: "A runtime value is known only to the platform the app is deployed to; at deploy time it is a pointer to it. ADR-0062's table calls this 'held by the platform'."

### A06 — the public type is not opaque, and the phantom precedent is misquoted (medium)

Spec § 2 ("a discriminant … the body never sees"), § 3.2, § 3.4; `contract.ts` line 12; `load-module.ts` line 70; `orm-postgres.ts` line 40.

`Value<T>` exposes `origin` as a plain public member, and § 3.4 exports `ValueOrigin`. A module body can read `v.origin.kind`, walk `v.origin.dependencies` and call `v.origin.compute`. That contradicts the definition ("can do nothing else with it") and puts Load's mechanism on the public surface. Only `evaluate-values.ts`, inside core, reads it.

The `__type` justification cites `Contract.__cmp` and `RefPort.__providerId`. Neither is a phantom: `__cmp` is assigned a real object (`bucketContract.__cmp = { url: '', … }`), and `__providerId` is written by Load and read back. The repo's actual phantom is `OrmCmp._contract?: C`. And the phantom sits on one branch of `ValueOrigin`, while the variance that matters is `Value<T>`'s.

Proposal: key `origin` by a symbol, as the brand is, and do not export `ValueOrigin`. Put the phantom on `Value<T>` under a type-only unique symbol, so it does not appear in autocomplete:

```ts
export interface Value<T> {
  readonly [VALUE]: true;
  readonly [VALUE_TYPE]?: T;          // phantom, never assigned
  readonly [VALUE_ORIGIN]: ValueOrigin;  // core-only
}
```

### A07 — the discriminator is not the axis the model describes (low)

Spec § 2, § 3.2; design note 9.

The model's axis is provided or computed. The code's discriminator is `'environment' | 'computed'`: one source noun and one participle. When the `module-input` project adds input references, the union becomes `'environment' | 'input' | 'computed'`, and "provided" will never appear in code. That flat union is the right shape for Load's switch, which asks where to get the real value. The text that says otherwise is what is wrong.

Proposal: keep the union. In § 2 and design note 9, replace "The provided-or-computed difference is a discriminant on the value that Load reads" with "`origin.kind` says where Load gets the real value: from a deploy-time fact of the environment, or by running a computation. Facts, and later module inputs, are the provided values."

### A08 — two verbs, "evaluate" and "resolve", for one act (low)

Spec § 5.2 (`evaluateValues`, `evaluate-values.ts`, "second evaluation pass"), § 6.4 ("resolved copy", `resolvedOptions`), § 7.3 ("the resolved graph"); glossary ("fully evaluated"); ADR-0060 amendment ("Load's second pass resolves").

The function authors call is `resolve()`, and every other document says Load "resolves" values. The pass, its file and the glossary say "evaluate".

Proposal: `resolveValues()` in `resolve-values.ts`, "the second pass resolves every value", and in the glossary "known by the end of Load". `resolve()` declares a computed value; Load resolves every value.

### A09 — error texts: "resolve() value" is wrong for `environment.name`, and "plain result" is a third term (medium)

Spec § 5.3, § 6.3.

`environment.name` is a value but not a `resolve()` value. Passing it as `provision()`'s `id`, into `deps`, or into a resource's wiring produces a message calling it a `resolve()` value. "A value computes a node's configuration" is also untrue of a provided value. "Plain result" appears nowhere else. The `undefined` message uses "value" for real data and points at "the schema", which a resource's options and props do not have.

Proposed texts:

| Condition | Text |
| --- | --- |
| value as `id` | `provision() received a value as its id (module "shop"). A value can configure a node, never decide its address: the graph is the same whatever inputs Composer is given (ADR-0062).` |
| value in `deps` | `The deps for "shop.web.db" are bound to a value. A value can configure a node, never decide its edges: the graph is the same whatever inputs Composer is given (ADR-0062).` |
| value in a resource's wiring | `resource() wires "target" to a value. A value can configure a node, never decide its edges (ADR-0062).` |
| cycle | `<site> depends on itself: a computed value's dependencies lead back to it. Remove the cycle.` |
| `fn` returned a value | `The resolve() function for <site> returned a value, not a real value. List that value as a dependency; fn receives its real value.` |
| `fn` returned `undefined` | `The resolve() function for <site> returned undefined. Return a result for every environment; Composer never picks a default.` |

### A10 — `options` / `ResourceOptions` is a homonym and a second place for a resource's configuration (medium)

Spec § 6.2, § 6.3; `orm-postgres.ts` lines 84–96; glossary "Provisioning plane" ("Props").

In this codebase "options" names call-option bags: `LoadOptions`, `LowerOptions`, `provision()`'s "trailing options", `opts`. In Pulumi, which the spec cites as prior art, `ResourceOptions` is exactly the type for meta-options (`dependsOn`, `parent`, `provider`), not a resource's configuration. Here it is the configuration.

It is also a second place for a resource's configuration. `PostgresResourceNode` keeps `config` and `targetRef` as subclass fields, which is what `ResourceNodeBase` exists for. After this slice a value is accepted only in the new bag, and nothing says so.

Proposal: `props: ResourceProps`, the glossary's own word for "the desired configuration passed at declare time", which is what a resource descriptor turns these into. The binding-site channel becomes `'props'`, rendered `prop "url" of resource "shop.site"`. Add to the glossary Resource entry and `core-model.md`: "A resource's configuration that may hold a value goes in `props`; Load resolves values there and nowhere else on a resource." Record moving `PostgresResourceNode.config` and `targetRef` into `props` as debt.

### A11 — documents that state what this slice changes, missing from § 9 (medium)

Spec § 9.

These say the opposite of what the slice builds and are not on the list:

- Glossary "Resource": defines a resource by its state and its Output only. Add: "A resource may also declare Inputs, wired when it is constructed, so it can depend on the service it serves (a public URL). A resource node that is wired carries references from the module body that built it, so it can only be provisioned there." The second sentence matters: until now every node was a context-free declaration, provisionable anywhere.
- Glossary "Ingress / Egress": "a driver" (see A03).
- Glossary "Load / Hydrate": "with nothing executed". Load now runs `resolve()` functions.
- `core-model.md` line 446: "Load executes nothing of the user's — the graph is data". Same.
- `graph.ts` `Load` doc comment: "Executes nothing of the user's own code beyond module bodies". Add "and `resolve()` functions".
- Glossary "Environment": one sentence that `environment` in a module body holds facts about the deployment environment and never environment variables. ADR-0059 accepted the overlap with "environment variables". `core-model.md` says "Core reads no environment" a few lines from where `Load({ environment })` will be documented.

### A12 — amendment notes: one misattribution and three omissions (medium)

ADR-0060 and ADR-0013 amendment notes; design note 11; `docs/design/90-decisions/README.md`; spec § 12; plan D4.

- ADR-0060's note and design note 11 say ADR-0013 "said a resource takes no wiring". ADR-0013 never says that. `core-model.md` line 443 does ("resources take no wiring"), and so does the `provision()` error ("a resource has no dependency slots to satisfy"). Proposed: "This amends the resource decision (ADR-0013), which modelled a resource as a producer only, with no dependency slots of its own."
- ADR-0013's note covers slots but not `options`/`props`, which also changes what a resource carries. Add: "and may carry plain-data props that Load resolves." Add the answer to A02 here too.
- ADR-0062's note introduces "provided value" without mapping it to the body's words, "a reference to a deploy-time fact". Add: "What the decision below calls a reference to a deploy-time fact is a provided value." Its phrase "create a persisted resource for a value" collides with the defined term Resource, a node with a managed lifecycle. Say what is meant, for example "store the value in a platform variable the deploy owns", or say it is a Resource node.
- The index lines for ADR-0013, ADR-0060 and ADR-0020 carry no "(Amended by …)" note, which is the house form for every other amended record.
- The done check "a grep over `docs/` … for `ResolvedValue` finds nothing" cannot pass: ADR-0062's amendment note must name the old type, and its body keeps it in the house form. Narrow the check to `docs/guides`, `docs/design/03-domain-model`, `docs/design/10-domains`, `skills` and `.drive/projects/public-urls/design`.

### A13 — `LoadOptions.environment` should have the shape of `ctx.environment` (low)

Spec § 5.1, § 5.2 (`result = environment  // the only fact today is 'name'`).

`Load(root, { environment: 'staging' })` and `({ environment }) => environment.name` use one key for a string and for an object of facts. ADR-0062 says "a new fact is a new reference, never a new argument". A second fact would add a second Load option.

Proposal: `LoadOptions.environment?: { readonly name: string }`, and the pass reads `environment[origin.fact]`, which removes the special case. `LowerOptions` and the stack files can keep a plain `environment: string` and build the object when they call Load.

## Answers to the eight questions

1. **Is "value" sound here?** Yes as the name of the concept, which is settled. It collides, though: with `Values<P>` and `InputValueOf<I>`, with the new `ValuesOf<D>` and `EnvironmentValues`, and with the ordinary word in the glossary's Configuration entry and in ADR-0062's body ("`fn` … returns a value"). It does not collide with Input or Output. The glossary entry does not read correctly cold: its lead sentence excludes runtime values, and it uses "value" in both senses (A04, A05).
2. **`ValueOrigin`.** The flat `'environment' | 'computed'` union partitions where Load gets the real value, which is the right job for it. It is not the provided-or-computed axis the text claims (A07). `fact: 'name'` is the right shape for "one reference per fact". The phantom is acceptable, but on the wrong type and justified by the wrong precedent: `__cmp` and `__providerId` are real fields; the repo's phantom is `OrmCmp._contract`. `origin` and `ValueOrigin` should not be public (A06).
3. **`EnvironmentValues` and `ctx.environment`.** Placing `environment` beside `inputs`, `secrets`, `params` and `provision` is right. It is what ADR-0062 specifies, and it is a provided input to the body like the others. The type name should be `EnvironmentFacts` (A04). `environment` can read cold as environment variables, which the no-globals principle says user code never touches. ADR-0059 accepted that overlap, so mitigate it in the glossary instead of renaming (A11).
4. **`resolve()` and `isValue`.** `resolve()` is fixed by ADR-0062 and reads correctly if the documents say "`resolve()` declares a computed value; Load resolves every value". So the pass should be `resolveValues`, not `evaluateValues` (A08). `isValue` is right beside `isNode`, `isSecretSource` and `isParamSource`.
5. **The resource change.** Fixing a resource's wiring at construction is a real structural difference from a service, which is wired at each `provision()`. But `deps` hides it, and it inverts the meaning `deps` has on `ModuleNode`, in `compute()` and in `module()`. Use `wiring` (A01). `options` collides with call-option bags and with Pulumi's `ResourceOptions`, and is a second home for resource configuration. Use `props` (A10). An `in` port does change what the glossary says a resource is: the Resource entry, the Ingress entry, and the driver-versus-resource decision all need amending (A03, A11). It also leaves open the `$out` port and contract a public URL must not have (A02).
6. **Planes.** The second pass in Load keeps the planes right. Values are authoring-plane data, and lowering receives plain data, as ADR-0062 requires. `LoadOptions.environment` belongs on Load beside `id`. Shape it as `{ name }` (A13). The glossary's and `core-model.md`'s "Load executes nothing" must change (A11).
7. **Error texts.** Mostly consistent. "resolve() value" is wrong whenever the value is `environment.name`, "plain result" is a third term for "real value", and the `undefined` text uses "value" for real data and refers to a schema a resource's props lack. Replacement texts are in A09. "Structure rule" does not appear in any text; the texts state the rule itself, which is better.
8. **Amendment notes.** The ADR-0062 note is accurate, but it should map "reference to a deploy-time fact" to "provided value", and it should not use "resource" loosely. The ADR-0060 note misattributes "a resource takes no wiring" to ADR-0013, and it does not reconcile "resource" with the body's and ADR-0020's "driver". The ADR-0013 note is accurate for slots but omits props and the `$out` question. ADR-0013 is the right record to amend. The index lines and the `ResolvedValue` grep need fixing (A12).

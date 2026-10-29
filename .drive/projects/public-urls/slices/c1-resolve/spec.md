# C1 — `resolve()` and the second evaluation pass

Parent: [public-urls spec](../../spec.md). Decisions: ADR-0062 (`resolve()`), ADR-0060 (a node with its edge already set). Builds on main at 1d4017ce; nothing depends on it until P1.

## At a glance

```ts
import { module, resolve } from '@prisma/composer';

export default module('shop', ({ environment, provision }) => {
  const greeting = resolve([environment.name], ([name]) => `hello from ${name}`);
  const shout = resolve([greeting], ([text]) => text.toUpperCase());
  provision(echoService, { input: { greeting: shout } });
});
```

```sh
prisma deploy                          # the service's greeting input is "HELLO FROM PRODUCTION"
prisma deploy --environment staging    # "HELLO FROM STAGING"
prisma dev                             # "HELLO FROM DEV"
```

```ts
// the structure rule, enforced
resolve([environment.name], ([name]) => {
  provision(extraService);   // LoadError: provision() inside a resolve() function
  return name;
});
```

## Chosen design

### The value

- **`resolve(deps, fn)` returns a `ResolvedValue<T>`.** `deps` is a tuple of resolved values; `fn` receives their values as one tuple, in the same order, and returns `T`. `fn` is typed from `deps`. Core never inspects `fn`; it only calls it.
- **A dependency is a `ResolvedValue`.** `environment.name` is a `ResolvedValue<string>` with no dependencies, which the second pass fills from the environment being loaded. A computed value's dependencies are copied and frozen at construction. Module input references (ADR-0061) are a later project and are not built.
- **A `ResolvedValue` is opaque in the module body.** It carries a brand symbol (`Symbol.for`, like every other core brand), its dependencies and its function. The body can pass it where a value is accepted and nothing else.
- **The body receives `environment` beside `inputs`, `secrets`, `params` and `provision`.** `environment` holds `name` only in this slice. A new deploy-time fact is a new reference on this object, never a new argument to `fn`.

### Where a resolved value is accepted

- **A service's `input` binding**, as a leaf anywhere inside the plain-data document. `InputBinding` gains `ResolvedValue<InputBinding>`.
- **A service's `params` binding**, in place of the literal. `ParamBindings` gains `ResolvedValue<the param's value type>`.
- **Nowhere that decides structure or identity.** A `ResolvedValue` is never a node's `name`, `id`, a `deps` entry, a `target`, a module `secrets` binding or a module `params` binding. The types do not admit one there, and Load rejects one it finds there at runtime with a `LoadError` naming the structure rule.

### The second pass

Load runs in two passes. The first pass is today's: it runs every module body and builds the graph, with every `ResolvedValue` unexecuted. The second pass then:

1. **Disables `provision`.** Every module's `provision` is sealed once the first pass finishes. A call after that point, which can only come from inside a `fn`, throws a `LoadError`: `provision() was called inside a resolve() function. resolve() computes values, never structure: the graph is the same whatever inputs Composer is given (ADR-0062).`
2. **Runs every `ResolvedValue` that the graph binds**, once each. Values are memoised by identity for the duration of one Load, so a value bound in two places runs once, and the order is dependency-first: a value's dependencies are run before it. A value reached again while it is being run is a cycle, and the error names the values involved by where they are bound (`the resolve() value bound to input key "greeting" of service "shop.echo"`; a value bound nowhere is named by its position in the chain). A `ResolvedValue` whose dependency tuple was tampered with after construction is the only way to make a cycle, and the check is cheap, so it stays.
3. **Checks each result.** `fn` returning `undefined` is a `LoadError` naming the binding: a value that is "nothing for this environment" must say so in its schema, not fall through to a param default. A result that is a `ResolvedValue`, contains one, or is a `Promise` is a `LoadError` naming the binding. Anything else is handed on as the value.
4. **Substitutes the results.** `graph.inputBindings[].binding` and `graph.params[].binding` are rewritten with every `ResolvedValue` replaced by its result. The graph that Load returns is the resolved graph; lowering and the deploy target's preflight never see a `ResolvedValue`.
5. **Validates like any other value.** A substituted param literal is validated by the param's own schema in `buildConfig`, as today. A substituted input leaf is validated by the deploy target's input resolution and the service's schema, as today. Both run inside the stack effect before anything is applied, so an invalid result fails the deploy before anything is created.

- **`environment.name` needs a name.** `Load(root, { id, environment })` takes the environment's name. It is optional: a graph that binds no resolved value needs none, and a resolved value that depends on `environment.name` when Load was given no environment fails with a `LoadError` saying which caller must pass one. `LowerOptions.environment` is required; the unused `LowerOptions.stage` goes, since the Alchemy stage is passed on the `alchemy` command line (C3) and core never read it. Both generated stack files render `environment` from the name the command resolved. The CLI's own Load in `pipeline.ts` passes it too, so the deploy target's preflight sees the resolved graph.
- **Nothing in core compares the name with anything.** Core passes the string through. The author's `fn` is the only thing that branches on it.

### A node with its edge already set

- **A resource may declare dependency slots and wire them at construction.** `resource({ name, extension, provides, inputs?, deps? })`: `inputs` declares the slots, as a service's does; `deps` supplies a provisioned ref for each, as a `provision()` call's `deps` does. The node carries both, frozen. `provision(resource)` records the slot nodes, the `input` edges and the `dependency` edges exactly as it does for a service, reuses `validateWiring`, counts a forwarded module input used, and records the authored edge. `provision(resource, { deps })` stays rejected: the wiring is the node's own.
- **Why a resource.** A public URL is a driver like cron (ADR-0020, ADR-0060): it depends on the service and the service knows nothing about it. It has no code, so it is not a service; it lowers through a resource descriptor, which already receives `ctx.graph` and `ctx.lowered`, and topological order places it after the service it points at. Nothing about the mechanism is specific to public URLs; it is the general form of "an ordinary node whose edge sits where every edge sits".
- **The resource descriptor is unchanged.** It finds its producer through the graph's edges and `ctx.lowered`; core adds no config building for resources.
- **Documentation follows.** `core-model.md` and `module-composition.md` today say resources take no wiring and only service edges can cycle. They are updated in this slice.

### Public surface

- `@prisma/composer` exports `resolve` and the type `ResolvedValue`. `ModuleContext` gains `environment`.
- `docs/guides/building-an-app.md` gains a section on values that differ per environment, `docs/guides/deploying.md`'s environments section points at it, and `skills/prisma-composer-core-concepts/SKILL.md` mirrors both, per the user-facing-surface rule. The glossary gains "Resolved value". `core-model.md` and `module-composition.md` describe the second pass and the resource's slots.

## Coherence

One PR, one reviewer sitting: the value type, the second pass in Load, the environment name's path from the command to Load, the resource's construction-time wiring, and the docs. Each piece is small; together they are the one capability P1 builds on. The resource change is in this slice rather than P1 because it is core's, and P1 lives in the Prisma Cloud extension.

## Scope

In: everything above, in `packages/0-framework/1-core/core`, `packages/0-framework/3-tooling/cli` (the environment name into Load and both stack files), `docs/`, `skills/`. An example app, `examples/env-param`, gains a `resolve()` over `environment.name` so QA has a real app.

Out: module input references and `resolve()` over them (ADR-0061, the `module-input` project); config adapters; `publicUrl()` (P1); a `ResolvedValue` as a secret binding; async `fn`; a `ResolvedValue` that reads a deploy result.

## Pre-investigated edge cases

| Case | Expected |
| --- | --- |
| `Load(root)` from a test with no environment, graph binds no resolved value | Loads as today. |
| Same, graph binds a value over `environment.name` | `LoadError` naming the missing environment and the Load option. |
| The same `ResolvedValue` bound to two services' inputs | `fn` runs once; both bindings get the result. |
| `fn` returns `undefined` | `LoadError` naming the binding. |
| `fn` throws | The error propagates out of Load unchanged, so the author sees their own error. |
| A `ResolvedValue` found in `provision()`'s `id`, `deps`, module `secrets` or module `params` | `LoadError` naming the structure rule. |
| `resource({ inputs: { target: dep }, deps: { target: forwardedInput } })` inside a module whose boundary declares that input | The input counts as forwarded; the authored edge runs from the module's in-port. |
| `resource({ inputs: { target: dep } })` with no `deps` for it | `LoadError`: unwired dependency input, as for a service. |

## Done

- A test app's service input bound to a `resolve()` over `environment.name` differs between `prisma deploy` to two environments (`prisma dev` for two environments proves the same path locally, and the deploy report's input document shows the value).
- `provision` inside `fn` fails with the structure error; `undefined` from `fn` fails before anything is created.
- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` green; guides, skill and design docs updated.

## Open questions

None. The kind of node that carries a construction-time edge (a resource with dependency slots) is an execution decision recorded here; the orchestrator reports it to Will with the pull request.

## References

- `packages/0-framework/1-core/core/src/node.ts`, `load-module.ts`, `load-service.ts`, `graph.ts`, `graph-types.ts`, `control/deploy.ts`.
- `packages/0-framework/3-tooling/cli/src/pipeline.ts`, `generate-stack.ts`, `dev/generate-dev-stack.ts`, `operations/execute-deploy-destroy.ts`, `operations/execute-dev.ts`.
- `packages/1-prisma-cloud/1-extensions/target/src/serializer.ts` (`resolveInputBinding`): where a substituted input leaf is validated today.
- `examples/env-param`.

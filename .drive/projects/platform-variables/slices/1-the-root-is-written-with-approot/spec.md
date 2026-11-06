# 1. The root is written with `appRoot()`

Parent: [project spec](../../spec.md), [plan](../../plan.md), [design](../../design.md) section 4, "Only the root provisions one, and the compiler enforces it".

## 1. At a glance

```ts
// module.ts, the app's entry
import { appRoot } from '@prisma/composer';
import { type } from 'arktype';
import { shop } from './shop.ts';

export default appRoot('storefront', { input: type({ SITE_HOSTNAME: 'string' }) }, ({ input, provision }) => {
  provision(shop(), { input: { hostname: input.SITE_HOSTNAME } });
});
```

- `appRoot()` builds the app's root. It takes what `module()` takes, minus `deps` and `expose`, which a root never has.
- Its result is an app root node, a type of its own. Passing one to `provision()` fails to compile: in a `module()` body, in an `appRoot()` body, and through a wrapper whose parameter is typed `ModuleNode`.
- The deploy, `prisma dev` and `destroy` accept it as the entry exactly as they accept a `module()` root. An entry built with `module()` is still accepted, as it is.
- Every root in this repository and its guidance is written with `appRoot()`, so there is one way to teach.

Slice 3 gives `appRoot()`'s body one `provision()` overload that `module()`'s body lacks: the one that accepts a platform variable node. This slice adds nothing for platform variables. It makes the root a type of its own, so slice 3 has somewhere to put that overload. It is additive, not breaking, and it ships alone for review size: moving every root in the repository would double the next slice's diff.

Will settled the two decisions this spec rests on, that a `module()` root is accepted silently and that the app root is a distinct type, on 2026-11-06 (`wip/pv-review/decisions-round-3.md`).

## 2. Chosen design

### 2.1 The app root node

`appRoot()` returns an **app root node**. At runtime it is a module node in every respect but one: every module node has a method `isRoot()`, which answers `false` for a node built with `module()` and `true` for one built with `appRoot()`. One internal builder, shared by both constructors, assembles the node and captures the answer in a closure. There is no exported symbol and no helper function; the CLI and Load call `node.isRoot()`.

In the types, `ModuleNode` declares `isRoot(): false` and `AppRootNode<I>` declares `isRoot(): true`. The literal return types make the two mutually unassignable, so every existing `provision()` overload refuses an app root with no change to the overloads and no extra type. If a name is ever needed for "a node `provision()` accepts", it is `ChildNode`. The doc comment on `isRoot()` says why the distinction exists: the app root is the deploy's entry and cannot be provisioned.

`Load()`, `lowering()`, `lower()`, `LoadedEntry.root`, `isNode()`'s return type and the generated stack file accept `ModuleNode | AppRootNode`. Everything that handles a module root today handles an app root unchanged: the graph, the targets and the stack files see a module node.

Load keeps one run-time check, for a root that reaches `provision()` through a cast: when a module body provisions a node whose `isRoot()` is true, Load fails with `COMPOSE.GRAPH_INVALID`:

```text
Module "<parent address>" provisions the app root "<root name>". An app root is the deploy's entry and cannot be provisioned. Build the module with module() instead.
```

### 2.2 The constructor

In `packages/0-framework/1-core/core/src/node.ts`, beside `module()`:

```ts
export function appRoot(name: string, body: (ctx: AppRootContext<undefined>) => void): AppRootNode<undefined>;
export function appRoot<I extends StandardSchemaV1 | undefined = undefined>(
  name: string,
  options: { input?: I },
  body: (ctx: AppRootContext<I>) => void,
): AppRootNode<I>;
```

- It builds the node through the builder `module()` uses, so the `params`/`secrets` refusals, the input-schema check and freezing behave identically. The body's return value is ignored, as a closed root's is today.
- An unknown key in the options object, such as `deps` or `expose`, is a compile error. If one arrives at runtime anyway, `appRoot()` throws: `appRoot("<name>") declares \`deps\`, which an app root cannot have: nothing provisions the root, so nothing can wire a dependency into it. Provision the resource inside the root's body instead.` For `expose`: `appRoot("<name>") declares \`expose\`, which an app root cannot have: nothing provisions the root, so nothing can consume what it exposes.`
- `appRoot` is exported from `@prisma/composer`'s public barrel (`packages/0-framework/1-core/core/src/exports/index.ts`, and the public package's re-export), with `AppRootNode` and `AppRootContext`.

### 2.3 The body context

`AppRootContext<I>` is a type of its own with three members: `input`, typed from the input schema as a module body's is; `environment`; and `provision`. It has no `deps`, because nothing can wire a dependency into the root. In this slice its `provision` is the same as a module body's; slice 3 widens that one member.

### 2.4 The entry

`packages/0-framework/3-tooling/cli/src/load-entry.ts` decides, before Load, from the entry's default export:

| The entry's default export | Result |
| --- | --- |
| an app root node | accepted |
| a module node built with `module()` | accepted |
| a service node | `COMPOSE.ROOT_NOT_MODULE` |
| anything else | `COMPOSE.ENTRY_EXPORT_INVALID` |

The service check moves from after Load to before it, so every command that loads the entry, including the ones that only read the app's name from it, gives the same answer. `LoadedEntry.root` is `ModuleNode | AppRootNode`. The messages:

- `COMPOSE.ROOT_NOT_MODULE`: summary `The entry "<path>" default-exports a service. The app's root must be a module, built with appRoot().`, fix `Provision the service inside a root, e.g. export default appRoot('name', ({ provision }) => { provision(service); }).`
- `COMPOSE.ENTRY_EXPORT_INVALID`: summary `Entry module "<path>" must default-export the app's root.`, fix `Build it with appRoot() from @prisma/composer.`

The `--entry` help texts in `family/commands/deploy.ts`, `dev.ts` and `dev-stop.ts`, and `composer-config.ts`'s "built with module(...)" text, say `appRoot()`.

## 3. Expected behaviour

Everything below is observable without reading the code.

- `appRoot('x', body)` and `appRoot('x', { input }, body)` both compile; in the second, the body's `input` is typed from the schema. An options object with any key other than `input` fails to compile.
- The four `provision()` call shapes: a module in an `appRoot()` body compiles; a module in a `module()` body compiles; an app root in a `module()` body fails to compile; an app root in an `appRoot()` body fails to compile. A wrapper `(m: ModuleNode) => …provision(m)…` called with an app root fails to compile at the wrapper's call site. Each existing overload of `provision()`, with and without a binding, behaves this way.
- Load of an app root gives the same graph as Load of the same body written with `module()`. Load of a body that provisions an app root through a cast fails with the message in 2.1.
- Every root in this repository is written with `appRoot()`, and the test suite passes. Tests that encode the old entry messages or the old position of the service check are updated as part of the slice.
- An entry that default-exports a `module()` root deploys and runs under `prisma dev` exactly as before, with no message about it.

## 4. Scope

### In

- **Core:** sections 2.1 to 2.3.
- **CLI:** section 2.4. The doc comment at the top of `load-entry.ts` says the entry's default export is an app root built with `appRoot()` or a module built with `module()`.
- **Every root in this repository moves to `appRoot()`:** the ten examples' `module.ts` (`auth`, `bucket`, `cron`, `email`, `env-param`, `orm-demo`, `storage`, `store`, `storefront-auth`, `streams`), `website/module.ts`, the CLI test fixtures under `cli/src/__tests__/fixtures/` that are entries, `test/integration/test/fixtures/local-dev/module.ts`, `test/integration/test/fixtures/extension-config/service.ts`, `examples/email/tests/secret-bindings.ts`, the placeholder roots in `test/integration/test/control.dev-current.test.ts` and `test/integration/test/local-dev-detach.integration.ts`, and the entries the CLI's and `composer-cli`'s tests write to disk.
- **Guidance that shows a root, by path.** Each `export default module(` becomes `appRoot(`, with the import changed and nothing else: `README.md`; `docs/design/10-domains/core-model.md` and `module-composition.md`; `docs/design/10-domains/deploy-cli.md` (its wrapping advice names `appRoot()`); `docs/guides/getting-started.md` and `building-an-app.md`; `docs/guides/running-locally.md` and `deploying.md` where they describe the entry; `packages/1-prisma-cloud/2-shared-modules/auth/README.md`, `email/README.md`, `storage/README.md` and `streams/README.md`; the core-concepts agent skill, `skills/prisma-composer-core-concepts/SKILL.md`.
- **Decision records whose code sample shows a root.** The rule: every `export default module(` in a decision record becomes `appRoot(`, with no other change to that record, so each stays one current record. The files: ADR-0013, 0022, 0023, 0025, 0032, 0051, 0054, 0056, 0057, 0060, 0062 and 0063.
- **Records rewritten in place as current statements.** No supersession note, no "amended by" line, no history paragraph; each reads as if written today. The graph is still a composition of modules that are all the same, except the root, which is written with `appRoot()`, cannot be provisioned, and (from slice 3) alone may provision a platform variable; the model is less uniform than these records say, and each says so plainly:
  - ADR-0014: `module()` is the authoring primitive for every module below the root, and `appRoot()` builds the root, because a root-only `provision()` overload needs a root-only type. Its line in `docs/design/90-decisions/README.md` changes with it.
  - ADR-0003: the entry's default export is an app root built with `appRoot()`, or a module built with `module()`; the root is marked by its type, not only by being the one you deploy.
  - ADR-0016, ADR-0061, where they show or describe a root; ADR-0044's error list, for `ROOT_NOT_MODULE`'s meaning.
  - The glossary's Module entry (the App paragraph), its `module` function entry, its superseded-terms App line, and every "implicit root Module" passage (the two Aggregate Contract passages and the superseded-terms arrow), which now say "app root".
  - A new glossary entry, **App root**: the outermost module, the one the entry default-exports and nothing provisions, built with `appRoot()`. Also called the root, the root module or the root node; those terms stay where they are exact and point at this entry.
- **The release note,** in the PR description: a root before and after, and the two changed error messages.

### Out

- Anything about platform variables. Slices 2 and 3.
- Making the root's other rules compile-time beyond `deps` and `expose`. The no-`field()`-at-the-root rule stays a Load check (design section 4).
- Anything about `module()` roots beyond accepting them as they are.

## 5. Done when

CI is green, `/drive-code-review` has run on the slice with its findings fixed, and manual QA shows, against Prisma Cloud: one repository example (`examples/email` or another) deployed after its root moves to `appRoot()`; the same example under `prisma dev`; and the same example with its entry put back to `module()`, deploying as before.

## 6. Open questions

None.

## 7. References

- Design: [../../design.md](../../design.md) sections 4 and 14.
- `packages/0-framework/1-core/core/src/node.ts` (`module()`, `ModuleNode`, `ModuleContext`, `ModuleBuilder.provision`).
- `packages/0-framework/3-tooling/cli/src/load-entry.ts` and `pipeline.ts` (the entry checks).
- ADR-0003, ADR-0014, ADR-0016, ADR-0044, ADR-0061, the glossary's Module and `module` entries.

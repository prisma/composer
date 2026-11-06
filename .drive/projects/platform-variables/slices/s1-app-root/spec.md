# S1: The root is written with `appRoot()`

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
- Its result cannot be provisioned. `provision(appRoot(…))` inside another module fails to compile.
- The deploy, `prisma dev` and `destroy` accept it as the entry exactly as they accept a `module()` root today.
- An entry built with `module()` still works, and the command prints a warning that `module()` as the entry is deprecated and says to write `appRoot()`.

S2 gives `appRoot()`'s body one `provision()` overload that `module()`'s body lacks: the one that accepts a platform variable node. S1 adds nothing for platform variables. It makes the root a type of its own, so S2 has somewhere to put that overload.

## 2. Chosen design

### 2.1 The node

`appRoot()` returns an **app root node**. It is a module node with one extra brand, so everything that handles a module root today handles it unchanged: Load, the graph, `lower()`, the generated stack files and every target.

In `packages/0-framework/1-core/core/src/node.ts`:

```ts
declare const APP_ROOT: unique symbol;   // type-level brand, following MODULE_INPUT in module-input.ts

/** The type error an author sees for an app root passed to provision(). */
export type AppRootIsNotProvisionable =
  "an app root is the deploy's entry and cannot be provisioned; build a module that other modules provision with module()";

export type AppRootNode<I extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined> =
  ModuleNode<Record<never, never>, Record<never, never>, I> & { readonly [APP_ROOT]: AppRootIsNotProvisionable };

/** Required of every module provision() accepts, so an app root fits none. */
export type NotAppRoot = { readonly [APP_ROOT]?: never };

/** What an app root's body receives. S2 widens its `provision`. */
export type AppRootContext<I extends StandardSchemaV1 | undefined> = ModuleContext<Record<never, never>, I>;
```

- The brand is type-only, as `MODULE_INPUT` is. At runtime the node carries a symbol-keyed marker, `Symbol.for('prisma:app-root')`, set to `true`, so the CLI can tell an app root from a `module()` root after loading the entry. Core exports `isAppRoot(node): node is AppRootNode`. The marker is a `Symbol.for` key for the same reason as `NODE`: a check must survive two installed copies of core.
- Every `provision()` overload in `ModuleBuilder` that accepts a module adds `& NotAppRoot` to its module parameter, and so does the generic `N extends ServiceNode | ModuleNode` overload. An app root then fits no overload, and the compiler's message ends with `AppRootIsNotProvisionable`. A type test asserts that message text, as module-input's tests assert `ModuleInputIsNotAValue`.
- `InputBindingOf`, `ServiceNode<D, P, E>` and `ModuleNode<D, E>` widening for generic wrappers stay as they are. A generic wrapper that takes `ModuleNode` and provisions it now refuses an app root, which is intended.

### 2.2 The constructor

In the same file, beside `module()`:

```ts
export function appRoot(name: string, body: (ctx: AppRootContext<undefined>) => void): AppRootNode<undefined>;
export function appRoot<I extends StandardSchemaV1 | undefined = undefined>(
  name: string,
  boundary: { input?: I },
  body: (ctx: AppRootContext<I>) => void,
): AppRootNode<I>;
```

- It builds the node through the same code `module()` uses, so the `params`/`secrets` refusals, the input-schema check and freezing behave identically. The body's return value is ignored, as a closed root's is today.
- `deps` or `expose` in the boundary fail to compile: the boundary type has no such keys, and an object literal with extra keys is an error. At runtime, for a caller that casts past the type, `appRoot()` throws: `appRoot("<name>") declares \`deps\`, which an app root cannot have: nothing provisions the root, so nothing can wire a dependency into it. Provision the resource inside the root's body instead.` For `expose`: `appRoot("<name>") declares \`expose\`, which an app root cannot have: nothing provisions the root, so nothing can consume what it exposes.`
- `appRoot` is exported from `@prisma/composer`'s public barrel (`packages/0-framework/1-core/core/src/exports/index.ts`, and the public package's re-export), with `AppRootNode`, `AppRootContext` and `isAppRoot`.

### 2.3 Load

`Load()` and `lower()` take a `ModuleNode`, which an app root is. They do not change, with one addition: when a module body provisions a node that `isAppRoot()` recognises, which only a cast allows, Load fails with `COMPOSE.GRAPH_INVALID`:

```text
Module "<parent address>" provisions the app root "<root name>". An app root is the deploy's entry and cannot be provisioned. Build the module with module() instead.
```

### 2.4 The CLI: which entries it accepts

`packages/0-framework/3-tooling/cli/src/load-entry.ts` decides, before Load:

| The entry's default export | Result |
| --- | --- |
| an app root node | accepted |
| a module node built with `module()` | accepted, with the deprecation warning below |
| a service node | `COMPOSE.ROOT_NOT_MODULE`, message below |
| anything else | `COMPOSE.ENTRY_EXPORT_INVALID`, message below |

The service check moves from `pipeline.ts` (after Load) to `load-entry.ts` (before Load). `LoadedEntry.root` becomes `ModuleNode`, and `LoadedEntry` gains `deprecatedModuleRoot: boolean`. The pipeline's check after Load goes, because nothing that reaches Load can fail it.

Messages, verbatim:

- `COMPOSE.ROOT_NOT_MODULE`: summary `The entry "<path>" default-exports a service. The app's root must be built with appRoot().`, fix `Provision the service inside a root, e.g. export default appRoot('name', ({ provision }) => { provision(service); }).`
- `COMPOSE.ENTRY_EXPORT_INVALID`: summary `Entry module "<path>" must default-export the app's root.`, fix `Build it with appRoot() from @prisma/composer.`
- The deprecation warning, printed to stderr once per command run, after the entry loads and before the first step, through the same `console.warn` channel the deploy uses for its other warnings:

  ```text
  Warning: the entry <path> default-exports a module built with module(). Build the app's root with appRoot() from @prisma/composer. module() as the entry is deprecated, and only an appRoot() body can provision platform variables.
  ```

  `<path>` is the path relative to the working directory. The warning appears in every output format, on stderr, so `--json` output on stdout stays clean.

### 2.5 Why `module()` entries keep working

The design says the deploy refuses an entry built with `module()`. This spec softens that to a deprecation warning, for one reason: outside this repo, `module()` roots exist in the `create-prisma` template (`templates/create/_shared/module.ts.hbs`), in five `prisma/prisma-examples` apps under `compute/`, in `prisma/studio` and in `prisma/web`, together with the Composer docs in `prisma/web`. A hard error would break each of them on its next upgrade, and would force a release in four repositories at once. Accepting them costs nothing: S2's guarantee comes from the type of the root's body, so a `module()` root simply cannot provision a platform variable. Removing `module()` as an entry is recorded in [deferred.md](../../deferred.md), to be done after those repositories have moved. [design.md](../../design.md) section 4 is updated to say this.

## 3. Coherence

One reviewer can hold this in one sitting: one new constructor that reuses `module()`'s machinery, one type brand following an existing pattern, one entry check moved and widened, and the mechanical move of every root in the repo. It ships alone because it is a breaking change every app feels, and keeping it out of S2 keeps S2's review about platform variables.

## 4. Scope

### In

- **Core:** sections 2.1 to 2.3.
- **CLI:** section 2.4. The doc comment at the top of `load-entry.ts`, which cites ADR-0003's "nothing else marks a root", is rewritten to say the entry's default export must be an app root, or a deprecated `module()` root. The `--entry` help texts in `family/commands/deploy.ts`, `dev.ts` and `dev-stop.ts`, and `composer-config.ts`'s "built with module(...)" text, say `appRoot()`.
- **Every root in this repo moves to `appRoot()`:** the ten examples' `module.ts` (`auth`, `bucket`, `cron`, `email`, `env-param`, `orm-demo`, `storage`, `store`, `storefront-auth`, `streams`), `website/module.ts`, the CLI test fixtures under `cli/src/__tests__/fixtures/` that are entries (`pipeline/`, `pipeline-config-adapters/`, `pipeline-app-configuration/`, `valid-module.ts`), `test/integration/test/fixtures/local-dev/module.ts`, and the entries the CLI's and `composer-cli`'s tests write to disk. A root that today declares `deps` or `expose` is a bug this slice surfaces; report it rather than working around it.
- **One fixture stays on `module()`,** to test the deprecation warning end to end.
- **Docs, rewritten as one current record each:**
  - ADR-0003: the entry's default export is an app root built with `appRoot()`; a `module()` root is deprecated. The statement "nothing else marks a root" is reversed.
  - The glossary's Module entry ("The App is the outermost Module … There is no separate root construct"): the root is built with `appRoot()`, a module that cannot be provisioned; in every other respect it is the outermost module. A new glossary entry, **App root**.
  - ADR-0061 and ADR-0016, where they show or describe a root.
  - ADR-0044's error list: `ROOT_NOT_MODULE`'s meaning.
  - `docs/design/10-domains/core-model.md`, `module-composition.md`, `deploy-cli.md`; the guides `getting-started.md`, `building-an-app.md`, `running-locally.md` and `deploying.md`; both copies of the core-concepts agent skill (`skills/` and `packages/9-public/composer/skills/`).
- **Project docs:** design.md section 4 says `module()` entries are deprecated, not refused; deferred.md records removing them and the four external repositories.
- **The release note,** in the PR description: before and after for a root, the deprecation warning, and the two changed error messages.

### Out

- Anything about platform variables. S2.
- Moving roots in other repositories: `create-prisma`, `prisma-examples`, `prisma/studio`, `prisma/web`. Recorded in deferred.md.
- Making the root's other rules compile-time beyond `deps` and `expose`. The no-`field()`-at-the-root rule stays a Load check (design section 4).
- Removing `module()` as an entry.

## 5. Tests

- **Type tests** (core's type test files, ArkType and Zod): `appRoot()` with and without `input`; the body's `input` typed from the schema; `deps` or `expose` in the boundary fails to compile; `provision(appRoot(…))` fails to compile in every overload, and the message contains `AppRootIsNotProvisionable`'s text; a generic wrapper typed with `ModuleNode` refuses an app root; a `module()` node still provisions as before.
- **Core runtime tests:** `appRoot()` throws for `deps` and `expose` passed through a cast, with the messages above; `isAppRoot()` is true for an app root and false for a `module()` node; Load of an app root gives the same graph as Load of the same body written with `module()`; Load fails with the message in 2.3 when a body provisions an app root through a cast.
- **CLI tests** (`load-entry.test.ts`, the pipeline tests): an app root entry loads with no warning; a `module()` entry loads, and the warning is printed once to stderr with the relative path; a service entry fails with the new `ROOT_NOT_MODULE` message before Load runs; a non-node export fails with the new `ENTRY_EXPORT_INVALID` message.
- **Existing tests** keep passing after the mechanical move. If one fails for any other reason, the implementer stops and reports.
- Integration: run only `test/integration/test/local-dev.integration.ts` and `local-dev-store.integration.ts`, each alone, with `bun run test/<file>` from `test/integration`. Never `pnpm test` in that folder: it runs the whole integration suite.

## 6. Done when

CI is green, `/drive-code-review` has run on the slice with its findings fixed, and manual QA shows, against Prisma Cloud: an example deployed with its `appRoot()` entry, and the same example with a `module()` entry deploying and printing the warning once.

## 7. Open questions

None.

## 8. References

- Design: [../../design.md](../../design.md) sections 4 and 14.
- `packages/0-framework/1-core/core/src/node.ts` (`module()`, `ModuleNode`, `ModuleContext`, `ModuleBuilder.provision`).
- `packages/0-framework/1-core/core/src/module-input.ts` (the `MODULE_INPUT` brand and `ModuleInputIsNotAValue`, the pattern 2.1 follows).
- `packages/0-framework/3-tooling/cli/src/load-entry.ts` and `pipeline.ts` (the entry checks).
- ADR-0003, ADR-0016, ADR-0044, ADR-0061, the glossary's Module entry.

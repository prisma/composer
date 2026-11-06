# ADR-0014: Modules compose recursively, and the App is the outermost one, built with `appRoot()`

Amended by [ADR-0063](ADR-0063-a-node-depends-on-an-interface-or-exposes-one.md): the port words Input and Output used below are retired; a node depends on an interface or exposes one.

## Decision

`module()` is the authoring primitive for every module below the root. It wraps services, resources, and other modules, and composes recursively. The **App is the outermost module**, the one the entry default-exports and nothing provisions, and it is built with `appRoot()`. Here's the shape in a real app:

```
store                             the App — the app root, built with appRoot()
├─ catalog     (Module)
│    ├─ database  (resource)
│    └─ catalog    (service)
├─ orders      (Module)
│    ├─ database  (resource)
│    └─ orders      (service)
└─ storefront   (service)          wired straight into the App, no Module needed
```

Everything under `store` is provisioned the same way regardless of depth. `store` itself is an app root: a module node in every respect but one, which is that `provision()` refuses it. `appRoot()` takes what `module()` takes minus `deps` and `expose`, because nothing provisions the root, so nothing can wire into it or consume from it.

An entry that default-exports a module built with `module()` is still accepted as the root, as it is.

The name for what you build is a **Prisma App** — the deployed result. `appRoot()` names the node at its root, not the App.

(This ADR's naming choices for the unit, the framework, the packages, and the CLI are superseded — see [ADR-0025](ADR-0025-name-the-unit-of-composition-module.md) and [ADR-0026](ADR-0026-name-the-framework-prisma-compose.md).)

## Reasoning

Start from what a developer is actually trying to do: build an app, deploy it, and watch it run. The thing they build is their **Prisma App** — the outcome, the value they're after. "App" belongs to that outcome, so no constructor is called `app()`.

The framework's composition unit is the module. A module can contain modules, as deep as the app needs, and every module below the root is written the same way, with `module()`. For those modules this follows two principles that govern the framework's design: **compose, don't special-case**, and **thin core**.

The root is an exception to **compose, don't special-case**: core has a type that exists for this one node, and the model is less uniform for it. The reason is a capability only the root may have. The root's scope is the whole app, and the app is the platform's project, so some things can be declared only there. Platform variables are the first: only the root may provision one, so the root needs its own `provision()`, and a root-only capability needs a root-only type. `appRoot()` gives the root that type. Platform variables are not built yet, so today the type's only effect is that a root cannot be provisioned. Every `provision()` overload refuses an app root, and so does a wrapper whose parameter is typed `ModuleNode`, at compile time. Load keeps one run-time check for an app root that reaches `provision()` through a cast. At run time, an app root node is a module node whose `isRoot()` answers `true`.

Deploying a single module in isolation, for testing, still works: an entry may default-export a module built with `module()`, and it deploys as the root. Such a root threatens nothing, because its body has no root-only overload.

## Consequences

- **One primitive below the root, one constructor for the root.** The whole model is: define modules with `module()`, compose them, and build the outermost one with `appRoot()`. Guides and examples teach `appRoot()` for every root.
- **The root is marked by its type.** Load, lowering and the CLI's entry accept a module node or an app root node; the graph, the targets and the stack files see a module node in both cases.
- **"App" is outcome-only vocabulary.** It names the product (a **Prisma App**) and the running result, never a construct. Do **not** add a `defineApp()` sugar preemptively — sugar can be added later, a primitive cannot be removed once it's in the wild.
- **The unit noun, framework name, package family, and CLI live in other ADRs.** [ADR-0025](ADR-0025-name-the-unit-of-composition-module.md) names the unit Module; [ADR-0026](ADR-0026-name-the-framework-prisma-compose.md) names the framework Prisma Composer and renames the packages and CLI to match.

## Alternatives considered

- **No root type: the App is just the outermost `module()`.** Rejected: a `provision()` overload that only the root's body has cannot exist without a type only the root has, and nesting a root could not be refused at compile time.
- **Refusing a `module()` root.** Rejected: such a root threatens nothing, because its body has no root-only overload, and accepting it keeps deploying a single module in isolation the same operation as deploying the app.
- **Calling the constructor `app()`.** Rejected: it would fold the outcome word "App" onto the authoring surface. `appRoot()` names the node at the root of the App.

## Related

- [ADR-0026](ADR-0026-name-the-framework-prisma-compose.md) — the framework
  name (Prisma Composer), the package family, and the CLI.
- [ADR-0025](ADR-0025-name-the-unit-of-composition-module.md) — the unit of
  composition (Module), authored with `module()`.
- [ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md) — deploy derives everything from the root node, the entry's default export.
- [ADR-0006](ADR-0006-every-node-is-named.md) — the root's name names the
  application.
- `docs/design/01-principles/guiding-principles.md` — "compose, don't
  special-case" and "thin core".

# ADR-0014: One authoring primitive — the App is the outermost Module

## Decision

There is exactly one authoring primitive: `module()`. It wraps services,
resources, and other Modules, and composes recursively. The **App is simply the
outermost Module** — the one node you point the deploy command at — and nothing
in the source marks it as special. Here's the shape in a real app:

```
store                             the App — the outermost Module, the deploy target
├─ catalog     (Module)
│    ├─ database  (resource)
│    └─ catalog    (service)
├─ orders      (Module)
│    ├─ database  (resource)
│    └─ orders      (service)
└─ storefront   (service)          wired straight into the App, no Module needed
```

`store` is the App only because it's the node nobody provisions — everything
under it is provisioned the same way regardless of depth.

There is no separate `app()` construct. The name for what you build is a
**Prisma App** — the deployed result.

(This ADR's naming choices for the unit, the framework, the packages, and the
CLI are superseded — see
[ADR-0025](ADR-0025-name-the-unit-of-composition-module.md) and
[ADR-0026](ADR-0026-name-the-framework-prisma-compose.md); the single-primitive
model here stands.)

## Reasoning

Start from what a developer is actually trying to do: build an app, deploy it,
and watch it run. The thing they build is their **Prisma App** — the outcome,
the value they're after. "App" belongs to that outcome. Naming a code
constructor `app()` would be a category error: it drags the word for the result
onto the surface where you write code, as if the outcome itself were something
you author.

So the framework exposes exactly one construct to author with. It wraps
services, resources, and other Modules, and composes recursively — a Module can
contain Modules can contain Modules, as deep as the app needs. The App is
simply the outermost one in that tree.

Making the App just another Module — not a distinct kind of node — buys a real
capability: deploying a single Module in isolation, for testing, is the same
operation as deploying the whole app, just aimed at a different node. No
special root type means no second code path for that case.

This also follows two principles that already govern the framework's design.
**Compose, don't special-case** says sophisticated behavior comes from
combining a few simple primitives, never from baking a special-case type into
the core — here, that means no privileged root type. **Thin core** says the
core stays small and stable, with specifics pushed out into extensions — here,
that means one authoring construct, not two.

One consequence is worth stating plainly: "App" never appears as an imported
symbol anywhere in a Prisma Composer codebase. It's the product name and the
word for the deployed result — but the only thing a developer ever writes is
`module()`.

## Consequences

- **One authoring primitive.** The whole model is: define a Module, compose
  Modules, deploy the outer one. Fewer concepts to learn; the root needs no
  special syntax.
- **"App" is outcome-only vocabulary.** It names the product (a **Prisma App**)
  and the running result, never a construct. Do **not** add a `defineApp()`
  sugar preemptively — sugar can be added later, a primitive cannot be removed
  once it's in the wild.
- **The unit noun, framework name, package family, and CLI now live in other
  ADRs.** [ADR-0025](ADR-0025-name-the-unit-of-composition-module.md) names the
  unit Module; [ADR-0026](ADR-0026-name-the-framework-prisma-compose.md) names
  the framework Prisma Composer and renames the packages and CLI to match.

## Alternatives considered

- **A separate `app()` construct**, distinguishing the root from an ordinary
  Module. Rejected: it would break the capability the single-primitive model
  buys — deploying a nested Module in isolation would need a different code
  shape than deploying the root — and it would fold the outcome word "App" onto
  the authoring surface, the exact category error the Decision avoids.

## Related

- [ADR-0026](ADR-0026-name-the-framework-prisma-compose.md) — the framework
  name (Prisma Composer), the package family, and the CLI.
- [ADR-0025](ADR-0025-name-the-unit-of-composition-module.md) — the unit of
  composition (Module), authored with `module()`.
- [ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md) — deploy
  derives everything from the root node (the "outermost Module is the deploy
  target" mechanism).
- [ADR-0006](ADR-0006-every-node-is-named.md) — the root's name names the
  application.
- `docs/design/01-principles/guiding-principles.md` — "compose, don't
  special-case" and "thin core".

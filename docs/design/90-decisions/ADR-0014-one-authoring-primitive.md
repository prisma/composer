# ADR-0014: One authoring primitive — the App is the outermost Module

## Decision

There is exactly one authoring primitive, and no separate `app()` construct: **the
App is the outermost Module**, distinguished only by being the node you deploy. That
one construct wraps services, resources, and other Modules and composes recursively;
the App is simply the outermost one, and nothing in the source marks a Module as
"the root" — the root is whichever node you deploy.

This ADR also fixed the product name for what you build — a **Prisma App** — and,
originally, the framework's own name and the names of its packages and CLI. Those
naming choices are superseded (see Status); the single-primitive model is what
remains in force.

## Reasoning

Start from what a developer is trying to do: build an app, deploy it, and see it
run. The thing you build is your **Prisma App** — the outcome, the value you are
after. "App" belongs to that outcome, so a code constructor named `app()` would be a
category error, dragging the value word onto the authoring surface. The thing you
*do* write is one primitive.

So we expose exactly one. It wraps services, resources, and other Modules, and
composes recursively. The App is simply the outermost one. This falls out of a
capability we want — deploying a single Module in isolation, for testing, is the
same operation as deploying the whole app, just aimed at a different node — and it
honors two standing principles: **compose, don't special-case** (no privileged root
type) and **thin core** (one authoring construct, not two). A consequence worth
stating: "App" never appears as an imported symbol; it is the product name and the
word for the deployed result, but developers only ever write the one primitive.

The framework's own name, its package family, and its CLI were also decided here; the
reasoning and the superseding choices now live in
[ADR-0026](ADR-0026-name-the-framework-prisma-compose.md).

## Consequences

- **One authoring primitive.** The whole model is: define a Module, compose Modules,
  deploy the outer one. Fewer concepts to learn; the root needs no special syntax.
- **"App" is outcome-only vocabulary.** It names the product (a **Prisma App**) and
  the running result, never a construct. Do **not** add a `defineApp()` sugar
  preemptively — sugar can be added later, a primitive cannot be removed once it is
  in the wild.
- **The framework, package, and CLI names live elsewhere now.** See
  [ADR-0026](ADR-0026-name-the-framework-prisma-compose.md) for the framework name
  (Prisma Compose) and the full-surface rename; the unit noun is Module
  ([ADR-0025](ADR-0025-name-the-unit-of-composition-module.md)).

## Related

- [ADR-0026](ADR-0026-name-the-framework-prisma-compose.md) — the framework name (Prisma Compose), the package family, and the CLI.
- [ADR-0025](ADR-0025-name-the-unit-of-composition-module.md) — the unit of composition (Module), authored with `module()`.
- [ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md) — deploy derives everything from the root node (the "outermost Module is the deploy target" mechanism).
- [ADR-0006](ADR-0006-every-node-is-named.md) — the root's name names the application.
- `docs/design/01-principles/guiding-principles.md` — "compose, don't special-case" and "thin core".

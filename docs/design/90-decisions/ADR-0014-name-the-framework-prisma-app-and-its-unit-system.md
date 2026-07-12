# ADR-0014: Name the framework "Prisma App", its unit of composition "System", and expose one `system()` primitive

## Status

Accepted; the unit-noun decision ("System", `system()`) is superseded by
[ADR-0025](ADR-0025-name-the-unit-of-composition-module.md) — the unit is a
**Module**, authored with `module()`. The framework name, the `@prisma/app*`
package family, the `prisma-app` CLI, and the single-primitive model all stand.

## Decision

The framework is the **Prisma App Framework**, published as `@prisma/app` (target
packs as `@prisma/app-nextjs`, `@prisma/app-cloud`, `@prisma/app-node`,
`@prisma/app-rpc`, `@prisma/app-assemble`, `@prisma/app-cli`; the Alchemy provider
package as `@prisma/alchemy`). Its unit of composition — previously "Hex" — is a
**System**, authored with a single primitive, `system()`. There is no separate
`app()` construct: **the App is the outermost System**, distinguished only by being
the node you deploy. The CLI binary — previously `makerkit` — is **`prisma-app`**.

This replaces the working names "MakerKit" (the framework) and "Hex" (the unit).

## Reasoning

Start from what a developer is actually trying to do: build an app, deploy it, and
see it run. Everything the framework offers is in service of that outcome, so the
name should be that outcome. "MakerKit" sounds like a standalone starter kit that
happens to share a logo with the rest of the family; it says nothing about building
an app and sits outside the Prisma family it belongs to. The name should instead be
the value the user is after — their app — which is why the framework is **Prisma
App**, the component of the family whose job is to assemble the others into a running
application.

We name every part for the value it delivers, not the machinery that delivers it.
That rule already lives in the product naming doc as a three-column shape: the
**Product** is what the user values, the middle column is what they **author**, and
the right column is what it **compiles to**. For this framework the row reads: you
value an **App**, you author it as **Systems**, and it compiles to a **Topology**.
Read that row carefully and it settles two things at once. First, "App" belongs in
the Product column — it is the outcome, not a thing you write — so a code constructor
named `app()` was a category error, dragging the value word into the authoring
surface. Second, the thing you *do* write needs its own word, and that word is
**System**.

"System" wins because it is the word developers already reach for at exactly this
granularity. Nobody says "my auth module" for a bounded piece that owns its own
services and a database; they say "the auth system," "the billing system," and they
say those systems talk to each other. The word needs no teaching — a first-time
reader guesses its meaning correctly — and unlike "Hex" it carries the right
connotations for free: a system runs, holds state, and is composed of smaller
systems. That last property matters most. "System" is scale-invariant: "my app is a
system composed of systems" is ordinary English, where "a hex composed of hexes"
demanded the reader accept framework jargon. Because the word behaves the same at
every level of the tree, the distinction between the root and its children
disappears — which is precisely the model we want, and the model these decisions
already describe: [ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md)
makes deploy derive everything from the root node, and
[ADR-0006](ADR-0006-every-node-is-named.md) makes the root's name name the
application. The App is simply the outermost System that deploy is aimed at.

So we expose one primitive. A `system()` wraps services, resources, and other
systems, and composes recursively. The App is simply the outermost one. Nothing in
the source marks a system as "the root"; the root is whichever node you point
`prisma-app deploy` at. This falls out of a capability we already have and want —
deploying a single system in isolation, for testing, is the same operation as
deploying the whole app, just aimed at a different node. Keeping a single primitive
also honors two standing principles: **compose, don't special-case** (no privileged
root type) and **thin core** (one authoring construct, not two).

A consequence worth stating plainly: "App" never appears as an imported symbol. It is
the product name, the package (`@prisma/app`), and the word for the deployed result —
"my app is live" — but developers only ever type `system()`. That keeps the authoring
surface honest to the three-column model, and it shrinks a naming collision:
"a Prisma app" today colloquially means "an app that uses the Prisma ORM," and since
nobody writes an `App` type in code, the two meanings never meet on the page.

The CLI binary is `prisma-app`, not `prisma`. Bare `prisma` belongs to the Prisma
ORM CLI; the app framework cannot claim it. `prisma-app deploy` is unambiguous today
and leaves room for the command to later become a subcommand of a unified `prisma`
CLI — a separate project — without stranding users on a name we had to walk back.

## Consequences

- **One authoring primitive.** The whole model is: define a system, compose systems,
  deploy the outer one. Fewer concepts to learn; the root needs no special syntax.
- **"App" is outcome-only vocabulary.** It names the product and the running result,
  never a construct. Do **not** add a `defineApp()` sugar preemptively — sugar can be
  added later, a primitive cannot be removed once it is in the wild.
- **The CLI is `prisma-app`.** Its generated scratch directory is `.prisma-app/`
  (not `.prisma/`, which the ORM owns). If it later folds into a `prisma` subcommand,
  that is a deliberate future migration, not this decision.
- **Service/System adjacency needs a crisp boundary.** Both are S-words in the same
  register, and speech blurs "the auth service" with "the auth system." The glossary
  must hold the line: a Service is one deployed compute unit; a System is a composed
  subtree.
- **"System" is not a unique token.** It is a generic English word, so search and grep
  lean on the `@prisma/app` scope, the `system(` call site, and capitalization rather
  than on the noun itself. This is an accepted trade — we rank a correct naive reading
  above token uniqueness.
- **A repo-wide rename.** `@makerkit/*` becomes `@prisma/app*` (with
  `@makerkit/prisma-alchemy` becoming the independent `@prisma/alchemy`), `hex()`
  becomes `system()`, the `makerkit` binary becomes `prisma-app`, and design docs, the
  glossary, the README, and earlier ADRs move from "Hex"/"MakerKit" to
  "System"/"Prisma App" — including [ADR-0005](ADR-0005-users-build-the-framework-assembles.md),
  whose title and body name the framework directly.
- **The registry name is reopened.** "Hexicon" derived from "Hex" and no longer fits;
  a replacement (or a plain descriptive name) is a separate decision, deferred until
  the registry itself is built.

## Alternatives considered

- **Prisma Compose (for the framework).** Elegant — it describes exactly what the tool
  does — but it names the mechanism, not the user's goal, and "compose" is a verb, not
  a noun that sits beside Postgres and Compute in the family. Decisively, its search
  space is already owned: results for "prisma compose" are dominated by
  docker-compose-with-Prisma content, including our own Docker docs.
- **Hex (for the unit).** Uniquely ours and precise once learned, but it teaches the
  wrong thing first: a developer's first reading is a hex color or hexadecimal, then
  the spell, then perhaps the polygon — hexagonal architecture is a minority prior. A
  name whose naive reading is wrong is a tax on every newcomer.
- **Module / AppModule (for the unit).** "Module" reads correctly at first glance but
  is among the most overloaded words in software — a file, a folder, an ES module, a
  Nest or Terraform module — so it can rarely be used without qualification. The
  qualified form "AppModule" collides head-on with NestJS, where `AppModule` is
  conventionally the *root* module — the inverse of our "a unit within the app"
  meaning.
- **Context (for the unit).** Accurate to "bounded context," but it collides in the
  editor with React's `useContext`, and to an agent-first audience "context" first
  means the context window.
- **Overlay (for the framework or the topology).** A precise description of what the
  system graph *is* — a logical topology lowered onto real infrastructure — and a good
  internal word for that concept. But as a product name it is too abstract: readers
  steeped in the domain still needed it explained, so it fails the first-encounter
  test that the whole naming philosophy is built to pass.
- **Cell, Tile, Block, Node, Core, Peer, Layer (for the unit).** Each fails on one of
  three axes we judge by, in priority order — naive reading, disambiguation from
  existing terms, precision. Tile and Block read as passive UI or inert material; Cell
  connotes many tiny identical units; Node and Core collide with words our own lower
  layers already use (topology nodes; the framework core); Peer implies a flat mesh
  our nesting model contradicts; Layer implies a horizontal slice, the wrong geometry
  for vertical, self-contained units.

## Related

- `agent-os/product/naming.md` — name-for-value principle and the three-column model.
- `agent-os/product/naming-proposal.md` — the family-of-components framing this fits into.
- `docs/design/03-domain-model/glossary.md` — the ubiquitous language this renames.
- [ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md) — deploy derives everything from the root node (the "outermost System is the deploy target" mechanism).
- [ADR-0006](ADR-0006-every-node-is-named.md) — the root's name names the application.
- `docs/design/01-principles/guiding-principles.md` — "compose, don't special-case" and "thin core".

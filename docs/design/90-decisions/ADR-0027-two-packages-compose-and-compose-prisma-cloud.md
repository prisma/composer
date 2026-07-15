# ADR-0027: Ship two packages — `@prisma/compose` and `@prisma/compose-prisma-cloud`

## Decision

The framework publishes exactly two **public** packages. The constraint is on the
published surface only — the workspace may hold as many **private** packages
(`"private": true`) as engineering convenience wants; internal seams are free,
names users install are not. The two public packages:

- **`@prisma/compose`** — the framework: core (`module()`, types, casts), the
  **`prisma-compose`** CLI as its bin, the assemble pipeline as internals, and the
  target-agnostic authoring surfaces as subpath exports — `@prisma/compose/rpc`,
  `@prisma/compose/node`, `@prisma/compose/nextjs`.
- **`@prisma/compose-prisma-cloud`** — the Prisma Cloud target: `compute()`,
  `postgres()`, the Alchemy provider and lowering (absorbing `@prisma/alchemy`),
  and the first-party modules realized on Prisma Cloud — cron first — as subpath
  entrypoints (`@prisma/compose-prisma-cloud/cron`).

There is no unscoped wrapper package: `npx @prisma/compose` runs the bin, and the
CLI is temporary surface anyway — it folds into a unified `prisma` CLI later, per
the note in [ADR-0014](ADR-0014-one-authoring-primitive.md).

Naming conventions this sets: under the `@prisma` scope, framework-family packages
are `compose-*`; outside the scope, community packages use the `prisma-compose-*`
prefix. A target extension carries the **target's full name** — the package is
`compose-prisma-cloud`, "prisma" twice, deliberately: it is stuff for *Prisma
Cloud*, not stuff for "cloud," and it establishes `compose-<target>` for future
targets.

## Reasoning

A package boundary should sit where the **user makes a choice**, not where the code
has a seam. Judged that way, the old nine-package family had one real boundary in
it: *where does the app run?* Everything else was internal seams travelling as
installs — `rpc` and `node` are the defaults every app authors with regardless of
target, `assemble` is a pipeline stage only the CLI drives, and the CLI itself is
not a choice. Core absorbs all of it; Next.js and Vite proved a decade ago that
framework + CLI + build in one package is not just viable but the expected shape.
Subpath exports keep the core import light — loading `@prisma/compose` never
touches the Next.js adapter, and `/nextjs` peer-depends on `next`.

First-party modules ship as entrypoints of the target package rather than as their
own packages because **module is a role, not an artifact** — the register model
([ADR-0025](ADR-0025-name-the-unit-of-composition-module.md)) already states that
one npm package may provide several modules. The ecosystem thesis ("modules are
ordinary npm packages you install") is proven by the composition contract — a
`cron()` with a typed boundary drops into any app — and by the first *third-party*
package, not by how Prisma bundles its standard library; Rails ships ActiveJob
inside Rails and the gem ecosystem thrives. Placing cron in
`compose-prisma-cloud` is also dependency-correct today: its scheduler is a Prisma
Cloud `compute()` service. The boundary rule still applies going forward — a
first-party module that is genuinely target-agnostic belongs in `@prisma/compose`
subpaths, never in the cloud package.

The consolidation also collapses the release surface: two packages version in
lockstep, hello-world installs two names instead of six, and — after the old
family's unpublish — two names is the entire republish burden.

## Consequences

- **Only two names are ever republished.** The old family (`@prisma/app*`,
  `@prisma/alchemy`, unscoped `prisma-app`) was unpublished on 2026-07-12;
  `compose-node`, `compose-rpc`, `compose-nextjs`, `compose-assemble`,
  `compose-cli`, `compose-alchemy`, and `compose-cron` never exist as packages —
  they are subpaths or internals.
- **The workspace restructure follows the public surface, not vice versa**: the
  old package directories become source directories behind the two `package.json`s
  *or* stay as private workspace packages (`"private": true`) — whichever builds
  cleaner. Only the two public names are constrained.
- **The registry convention must enumerate modules per package** (a manifest field
  or keywords listing each provided module and its entrypoint) — already implied by
  the register model, now load-bearing for discovery.
- **Splitting later is a breaking change** (import paths move). Accepted: the
  subpath layout makes future extraction mechanical, and pre-GA is the time to be
  wrong in the cheap direction.
- **Future targets** publish as `@prisma/compose-<target>` and may carry their own
  target-realized modules the same way.

## Alternatives considered

- **The nine-package status quo.** Six installs for hello world, a 9×N version
  matrix, and boundaries at code seams users never chose between.
- **A five-package middle** (core, cli, cloud, nextjs, cron). Still ceremony
  without meaning: the CLI and the Next.js adapter are not choices, and cron's own
  dependencies point at the cloud package.
- **`compose-cron` as a separate exemplar package.** Rejected on our own register
  model: module is a role, and packaging the exemplar separately proves nothing the
  composition contract doesn't already prove — while adding a name to version,
  publish, and explain. The ecosystem is demonstrated by third-party packages.
- **Authoring surfaces (`rpc`/`node`/`nextjs`) in the cloud package.** Couples
  target-agnostic authoring to one target; the day a second target exists, its
  users would import build adapters from the *Prisma Cloud* package.
- **An unscoped `prisma-compose` bin wrapper.** Near-free to build, but it is one
  more name to manage for a CLI whose long-run home is the unified `prisma` CLI.

## Related

- [ADR-0026](ADR-0026-name-the-framework-prisma-compose.md) — the Prisma Compose
  rename; its package enumeration is consolidated here.
- [ADR-0025](ADR-0025-name-the-unit-of-composition-module.md) — the register model
  (package / extension / Module) this leans on.
- [ADR-0014](ADR-0014-one-authoring-primitive.md) — the
  single-primitive model and the unified-CLI note.
- `agent-os/product/naming.md` — the family table and distribution model.

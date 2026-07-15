# ADR-0025: Name the unit of composition "Module", authored with `module()`

## Decision

The unit of composition is a **Module**, authored with a single primitive,
**`module()`**. The App is the outermost Module — the node you point
`prisma-compose deploy` at. Everything ADR-0014 established about the primitive's shape
(recursive composition, no privileged root, deploy derives everything from the root
node) carries over under the new name.

"System" leaves the vocabulary entirely: no construct, type, document term, or
diagram label uses it. Prose may still use "system" as plain English — a large
module may well *be* an inventory system — but the word names nothing in the
framework.

The vocabulary sits in a three-register model. A **package** is the artifact npm
hosts; npm owns that word and we do not rename it. An **extension** is what you slot
into `prisma-compose.config.ts` — deploy targets, build kinds, anything that extends the
toolchain. A **Module** is what you plug together inside the app. One npm package
may register an extension and provide modules; the registers name roles, not
artifacts.

## Reasoning

The unit was first named "System", chosen with product-name tests — name the value,
not the machinery — but a unit-of-composition noun is not a product name. To the user a container noun
is *all* machinery; the value lives in the capability (cron, auth), never in the
box. The choice was therefore carried by a single remaining criterion, the naive
first reading, evaluated in one sentence at one grain: "the auth system." That
sentence is real, but the example apps that existed then were all auth-sized, so the
word was never tested where composition actually lives.

The first small shared unit — the cron package — exposed the failure within days of
existing. "Install the cron system" is a category error: English "system" has a size
floor and an ownership register — a system is something you *operate*, not something
you install. "This system uses the cron system and an image-resizer system" is
barely sayable. And the deciding claim behind that first choice — that nobody says
"my auth module" — is simply false: developers say it constantly in the ecosystems
nearest to ours (Nest, Angular, Terraform, Go). The rubric that replaces those tests is
recorded in `agent-os/product/vocabulary-tests.md`: every test is a sentence said
aloud — grain sweep, repetition, install, publish, instance/artifact duality,
adjacency, the gloss test, and a prior-art check.

"Module" passes them. It has no size floor or ceiling: "the auth module" and "a
module that provides one cron job" are both ordinary speech, and so is "your app is
the outermost module." It stays invisible under repetition. It sits naturally in the
consuming frames — "install the cron module," "I published a module" — because npm
packages already *are* modules colloquially, which also gives it instance/artifact
duality for free. Its prior art is exactly our meaning: a Nest or Angular module is
a composable, boundary-owning unit assembled by dependency injection, and a
Terraform module is a reusable composition with typed inputs and outputs. Notably,
Nest's convention that the root module *is* the app corroborates "the App is the
outermost Module" — the first-round reading had taken that same convention as a
collision, inverted.

The one real adjacency is ES modules, and it is inter-register: the language's
"module" names a file-grain unit, ours names a composition-grain unit, and no spoken
sentence confuses them — "the cron module" cannot be misheard as a file. At the
authoring surface the collision is empty: `module` is a legal identifier at call
position, and the repository is ESM-only, so there is no CommonJS `module` global to
shadow.

Two structural rules fall out of the failure and are worth stating as rules. First,
**identity is the registry's job, not the unit noun's.** Branded unit nouns (Hex
before; Prism, Shard, Facet as candidates now) fail the gloss test by construction —
each is explained via the common word it displaced — and tax every composition
sentence to buy an ecosystem signal the registry should carry. Prism specifically is
one letter from Prisma and owned in search by prismjs; it is recorded as a candidate
for the *registry* name, where it is said occasionally, not in every sentence.
Second, **a unit noun must be chosen at the smallest grain**, because composition
math puts most units below any hero example. A noun that fits only flagship-sized
units fails where most of the usage is.

## Consequences

- **A repo-wide mechanical rename**, mirroring the earlier repo-wide rename ADR-0014
  itself performed: `system()` becomes `module()`, `SystemNode` becomes
  `ModuleNode` (and kin), `system.ts` files and `systems/` directories are renamed,
  and the README, glossary, domain docs, and earlier ADRs' prose move from "System"
  to "Module." Package names, the CLI, and the config file are untouched.
- **"System" must not survive as a term.** The Service-vs-unit adjacency the first
  naming asked the glossary to defend disappears; Service stays, unambiguous now.
- **The register model is canon**: package (npm's word) / extension (toolchain slot)
  / Module (unit of composition). Docs introducing a shared capability say "the
  cron module," provided by a package, possibly alongside an extension.
- **The registry decision stays deferred** and gains a shortlist entry: Prism. The
  unit noun no longer carries any identity burden, so the registry name can be
  chosen purely for the identity frames ("it's on ___," "publish to ___").
- **Naming rubrics are now split**: product names use naming.md's value tests;
  vocabulary nouns use vocabulary-tests.md's spoken-sentence tests. Neither decides
  the other's domain again.

## Alternatives considered

- **Keep "System."** The failure record is in `agent-os/product/vocabulary-tests.md`:
  fails grain sweep, repetition, install, publish, duality, adjacency (an early
  warning was the demand that the glossary "hold the line" between Service and the
  unit noun), and the gloss test — the README introduced it as "a component — a
  System," reaching for the better register in the very sentence that defined it.
- **Component.** The word our own README glossed with, and C4's architecture sense
  matches ours. Disqualified by an intra-app collision: a Module *contains* React
  components in the flagship examples, so "the storefront component" is genuinely
  ambiguous inside one conversation — a worse adjacency than ES modules, which live
  at a different grain.
- **Gem-style branded nouns (Prism, Shard, Facet, Lens).** All re-create the Hex
  mistake: identity on the unit noun, gloss tax on every introduction. Prism is
  additionally one letter from the master brand; Shard already means a database
  partition — in a data company, a guaranteed misreading; Facet names an aspect of
  one surface and cannot nest; Lens is owned by FP optics libraries in TypeScript.
  Prism moves to the registry shortlist, where the identity frames belong.
- **Unit, Part, Block, Tile, Cell, Piece.** Fail the install frame and the gloss
  test ("a unit of what?"), or read as inert material at composition grain; none has
  prior art as a boundary-owning composition unit.

## Related

- `agent-os/product/vocabulary-tests.md` — the spoken-sentence rubric and the
  "System" failure record.
- `agent-os/product/naming.md` — product-name tests and the register model's place
  in the family story.
- [ADR-0014](ADR-0014-one-authoring-primitive.md) — the
  superseded unit-noun decision; its framework, package, CLI, and single-primitive
  decisions stand.
- [ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md),
  [ADR-0006](ADR-0006-every-node-is-named.md) — the root-node mechanics "the App is
  the outermost Module" rests on.
- [ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md) — the boundary
  model, unchanged by the rename.

# ADR-0003: Distribute apps as composable Hexes through a first-party registry, Hexicon

## Status

Accepted — with two product-line renames still Proposed (Prisma Next → Prisma
Model, MakerKit → Prisma Compose); see Consequences.

## Decision

The building block a developer composes is a **Hex**, and Hexes are assembled into
a single **app** — the noun the developer actually cares about. Hexes are ordinary
TypeScript libraries published to **npm**. Discovery, curation, and installation
happen through a first-party registry, **Hexicon** (hexicon.dev): a named directory
layered over npm whose install command not only downloads a Hex but **composes** it
— wiring its typed Inputs and Outputs into the app.

The tool that does the composing is **Prisma Compose**; the single-database
data/contract layer it sits above is **Prisma Model**. Both take their place in the
Prisma product family beside Postgres, Compute, and Durable Streams. "App" stays
the user-facing hero noun; the wired graph remains the **Topology**, and
"composition" stays internal machinery, never front-of-house vocabulary.

## Reasoning

Start with what a developer is trying to do: ship an app, fast, ideally by letting
an agent do the wiring. They need authentication. Instead of writing it, they pull
an **auth Hex** from Hexicon, and Prisma Compose wires that Hex's outputs into their
app's inputs. The app is the goal; the Hex is the part; Compose is the act.

The unit is a **Hex** because a Hex is a bounded context with typed Inputs and
Outputs that behaves like a Service (see the domain glossary). That contract is the
whole point: a stranger's auth Hex drops into your app with a boundary the machine
can check, which is what makes composition safe when the composer is an *agent*
rather than a human reading source. Naming the unit "Hex" also follows the
tradition that a shared unit gets its own short noun — a gem, a crate, a package.

Given npm can host these libraries, why name a registry at all? Because in a
compose-from-blocks product the registry is the highest-leverage name in the whole
system. It becomes the verb developers type and the destination they return to; it
is the network-effect asset (a Hex is published *to* somewhere, and others say it's
*on* somewhere — that preposition needs a proper noun); it is the trust mark that
says a stranger's Hex is real and installable; and, when the composer is an agent,
it is the agent's app store — the place it searches and pulls from. Hosting is a
commodity. Discovery, curation, and identity are the product. So the substrate stays
boring — npm, with its semver, resolution, and tooling — and the investment goes
into a thin, named directory on top: search, ranking, trust, and an install that
composes.

The registry is named **Hexicon** — "hex" plus "lexicon," the catalog of Hexes. A
lexicon is precisely a catalog, which is what a registry is. It also escapes two
collisions that the bare word "Hex" would walk into: `hex.pm`, the package manager
for Elixir and Erlang (a same-category registry, the most confusing kind of clash),
and `hex.tech`, an established data-tools brand. Hexicon is a Prisma first-party
property, so it lives under the Prisma umbrella rather than fighting for a
standalone identity.

Finally, the hero noun is deliberately **app**, not "composition," "topology," or
"product." "Composition" and "topology" are the true internal objects, but nobody's
goal is to produce one — they are machinery, like an abstract syntax tree.
"Product" errs the other way: it floats a layer above what the tool actually builds
(the tool builds the system that powers a product, not the product's pricing,
support, or market). The verbs that describe the developer's relationship to the
thing — create, design, maintain, optimize — describe a living application over
time, not a static artifact, which points at "app." And "app" has the rare virtue
of being a word you never have to teach.

## Consequences

- We commit to **running and curating a registry**. Hexicon is an operational and
  trust surface: ranking, moderation, and the security of community-published Hexes
  are now our problem, not just a website.
- Hexicon's install must **compose, not copy** — it wires a Hex's typed contract
  into the topology. That is a harder job than a file-copy install, and it depends
  on the typed-contract model being sound.
- Community Hexes are **arbitrary npm packages**, so Hexicon needs an indexing
  convention (a `keywords` entry or a manifest field) to recognise a package as a
  Hex.
- The naming leans on the **Prisma master brand**: components are humble role names
  (Compose, Model) under it, which is what lets the family read as the parts-list of
  one application rather than a set of standalone mascots.
- It **rules out** naming the registry bare "Hex" (the hex.pm / hex.tech
  collisions) and rules out leaning on "Hexal" as a public, domain-fronted brand
  (its domains are camped or guarded by Hexal AG, a pharmaceutical company).
- The **Prisma Model** and **Prisma Compose** names are renames of Prisma Next and
  MakerKit respectively. Adopting them touches existing naming across docs and code;
  until then they remain proposals and the old names persist.

## Alternatives considered

**Bare "Hex" as the registry name.** The cleanest word, but `hex.pm` is already a
package manager one ecosystem over — naming our package/component registry "Hex"
collides on the exact concept — and `hex.tech` holds the developer-tools mindshare.
Kept "Hex" for the *unit* (like gem/crate), gave the *directory* its own name, which
also matches how every prior ecosystem separates the two (gem vs RubyGems, crate vs
crates.io, package vs npm).

**"Hexal" as the product or tool name.** An earlier choice for the MakerKit rename,
with the `@hexal` npm organisation registered. Set aside once the tool settled on
Prisma Compose and because Hexal's public domains are camped or actively guarded by
Hexal AG (pharma; owns hexal.com through a brand-protection registrar). A related
vein — leaning into "hex" as *spell* (names like Sigil, Ward, Cast) now that the
substrate is Alchemy — was explored and dropped as too far from what the tool
literally does.

**Evocative standalone names** (Tessera/Tessellate, Mesh, Hedra, Facet). Attractive
and on-concept, but they pull a component out of its family and ask it to stand
alone, when the aggregate — a whole app built from Prisma components — is worth more
than any single clever part. Role names that imply their siblings beat mascots here.

**Naming the artifact "Composition," "Topology," or "Product."** The first two are
correct but internal — machinery a developer never set out to produce. "Product"
over-claims — it names the business offering, a layer above the system the tool
builds. "App" sits exactly at the layer the developer cares about.

**Self-hosting a package registry, or skills.sh-style raw-GitHub hosting.** The
skills.sh pattern — decentralised hosting plus a named central directory plus a
one-command install — is the right shape, and we adopt it. But its raw-GitHub
hosting suits text-file skills, not TypeScript libraries with dependencies and
versions; npm is the better substrate. So we host on npm and build only the
directory. The one place we deliberately do *more* than skills.sh: its install
copies files, ours composes a typed Hex into the topology.

## Related

- `docs/design/03-domain-model/glossary.md` — Hex, Service, Resource, Topology,
  Inputs/Outputs, Configuration.
- `docs/design/04-inspirations/Alchemy/` — the provisioning substrate Hexes lower
  to.
- The README's Hex metaphor: magnetic hexagon tiles you snap together, a nod to
  Hexagonal Architecture.

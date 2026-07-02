# Product Naming & Distribution

A developer builds an **app** by composing Prisma primitives — Postgres, Compute,
Data, and more — wired together by **Prisma Compose**. We name every piece for the
**value the user gets from it**, not the machinery that delivers it. This document
covers the product family, how Compose fits into it, the vocabulary Compose
introduces, and how its building blocks (Hexes) are distributed.

Some names are settled (Hex, Hexicon); the Prisma renames — Prisma Data (← Prisma
Next) and Prisma Compose (← MakerKit) — are still proposed.

## The Prisma product family

Each primitive is named for its role. Read down the value column and it says what
building an app is actually *for*:

| Primitive | Role | The value to the user |
|---|---|---|
| Prisma Postgres | persist | my data has a home |
| Prisma Compute | execute | my code runs |
| Prisma Data *(← Prisma Next)* | data | I model, access, and manage my data |
| Prisma Compose *(← MakerKit)* | compose | my app comes together from parts |
| Durable Streams | stream | my events flow and survive |
| Connection | connect | my services reach each other |

A product name need not equal its role word — Compute's role is "execute," Compose's
is "compose the rest." The name takes whichever word carries the most user value.

## How Prisma Compose fits

The other primitives each deliver one capability. **Prisma Compose is different: it
is the primitive that assembles the others into a running app.** It is the
composition layer of the family — and it introduces its own small vocabulary for the
job:

| Term | What it is | The value it names |
|---|---|---|
| **App** | the application you build | software with users and features — the whole point |
| **Hex** | a building block you compose | a capability you reuse instead of writing |
| **Hexicon** | the registry at `hexicon.dev` | finding and trusting those blocks |
| **Topology** | the graph Compose produces | *(machinery — the user never says this)* |

You build an **App** by snapping together **Hexes** — each one wrapping primitives
like Compute and Postgres — that you find on **Hexicon**; Compose infers the
**Topology** and provisions it. App, Hex, and Hexicon are the words a developer says;
Topology is the machinery underneath.

## Name for value, not machinery

That split — the word the user says versus the term for how it works — is the rule
behind every name here. Users say "my app" and "my data"; nobody says "my topology."
So the brand takes the first, and the precise term stays below, kept exact but
unnamed in the marketing.

Four questions decide a name:

1. **Would the user put "my" in front of it?** "My app," "my data" — yes. "My
   topology" — no; that's the wiring the tool produces, not the thing you set out to
   build.
2. **Does it predict the tooling?** "Data" tells you to expect model, migrate,
   query, types. A clever coinage tells you nothing.
3. **Does it name the goal, not the tax?** People value data *access*; migration is
   a necessary step, sometimes an obstacle, never the goal. Name the reward, not the
   chore.
4. **Does it keep the family legible?** Components named for their role read as the
   parts-list of one app — worth more than any single clever standalone name.

The payoff of taking the value word for the brand: the precise words stay **free to
mean exactly what they mean one level down**. The same shape repeats at every layer —
the user names the left column, writes the middle, and the system consumes the
right:

| Product (what the user values) | Authored as | Compiles to |
|---|---|---|
| **App** | **Hexes** you snap together | a **Topology** |
| **Prisma Data** | **models** in PSL | a **Contract** |

Name the product itself "Model" or "Contract" and you steal a word that is more
useful below it.

## The data layer: Prisma Data

The value here is *your data* — and above all accessing and querying it. That is why
the layer is named **Data**, not "Model" or "Contract." Modeling and migration are
the way in, not the goal, and you don't brand a product after the tax it charges.
Naming it "Data" also keeps the two precise words at work: you still author
**models** in PSL — the part of Prisma developers love, untouched — and those models
compile to a **Contract**, the typed boundary a Hex's input requires and a Postgres
output satisfies. Data is the value; model is what you write; Contract is what the
system wires against.

## The building block: Hex

A Hex is a bounded context with typed inputs and outputs that behaves like a service
(see `docs/design/03-domain-model/glossary.md`). The typed boundary is what makes it
reusable: a stranger's auth Hex drops into your app with a contract the machine can
check — which is what lets an **agent**, not just a human, compose it in safely.
Giving the shared unit its own short noun follows the tradition of a gem, a crate, a
package.

## The registry: Hexicon

"Hex" + "lexicon" — the catalog of Hexes. In a compose-from-blocks product the
registry is the highest-leverage name in the whole system: it becomes the verb
developers type, the destination they return to, the network-effect asset (a Hex is
published *to* somewhere and is *on* somewhere — that preposition needs a proper
noun), the trust mark for stranger-published Hexes, and — when the composer is an
agent — the agent's app store.

The name also dodges two collisions that bare "Hex" would hit: `hex.pm`, the
Elixir/Erlang package manager (a same-category registry — the most confusing kind of
clash), and `hex.tech`, an established data-tools brand.

## How Hexes are distributed

Hosting and discovery are split:

- **Hosting → npm.** Hexes are ordinary TypeScript libraries. npm brings semver,
  resolution, and tooling for free; the substrate stays boring and commodity.
- **Discovery → Hexicon.** A thin, named directory on top: search, ranking, trust,
  and a one-command install.

This is the shape skills.sh proved — decentralized hosting, a named central
directory, one-command install — with one deliberate difference: **Hexicon's install
composes, it doesn't just copy.** skills.sh drops text files into an agent's config;
Hexicon wires a Hex's typed contract into the app's topology. That richer install is
the point, and it depends on the typed-contract model being sound.

Because community Hexes are arbitrary npm packages, Hexicon recognizes them by
convention — a `keywords` entry or a manifest field.

## Names to avoid

- **Bare "Hex" for the registry** — collides with `hex.pm` and `hex.tech`. Keep
  "Hex" for the *unit*; the registry gets its own name (gem→RubyGems,
  crate→crates.io, package→npm).
- **"Hexal" as a public, domain-fronted brand** — its domains are camped or guarded
  by Hexal AG (a pharmaceutical company that owns `hexal.com`). The `@hexal` npm org
  is registered but is not the plan.
- **"Model" or "Contract" for the data layer** — each steals a word more useful one
  level down (`model` is the PSL construct; a `Contract` is what models compile to),
  and neither names the user's actual value: data access.

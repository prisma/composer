# Product Naming & Distribution

A developer builds a **Prisma App** by composing Prisma primitives — Postgres,
Compute, Data, and more — wired together by **Prisma Compose**, the framework. We
name every piece for the **value the user gets from it**, not the machinery that
delivers it. This document covers the product family, how Prisma Compose fits into
it, the vocabulary it introduces, and how its building blocks (Modules) are
distributed.

The framework name and its unit are settled: **Prisma Compose** (← Prisma App ←
MakerKit), recorded in
[ADR-0026](../../docs/design/90-decisions/ADR-0026-name-the-framework-prisma-compose.md),
and **Module** (← System ← Hex), recorded in
[ADR-0025](../../docs/design/90-decisions/ADR-0025-name-the-unit-of-composition-module.md).
**"Prisma App" names the artifact** — the thing you build and deploy — never the
tool.
**Prisma Data** (← Prisma Next) is still proposed. The **registry** name is deferred
until the registry itself is built; **Prism** is on its shortlist.

## The Prisma product family

Each primitive is named for its role. Read down the value column and it says what
building an app is actually *for*:

| Primitive | Role | The value to the user |
|---|---|---|
| Prisma Postgres | persist | my data has a home |
| Prisma Compute | execute | my code runs |
| Prisma Data *(← Prisma Next)* | data | I model, access, and manage my data |
| Prisma Compose *(← Prisma App ← MakerKit)* | compose | my app comes together from parts |
| Durable Streams | stream | my events flow and survive |
| Connection | connect | my services reach each other |

A product name need not equal its role word — but for the framework, it now does:
Prisma Compose's role is "compose," exactly as Compute's is "execute." The value
word — App — belongs to the artifact, and the artifact keeps it: you build **Prisma
Apps** with Prisma Compose.

## How Prisma Compose fits

The other primitives each deliver one capability. **Prisma Compose is different: it
is the framework that assembles the others into a running app.** It is the
composition layer of the family — and it introduces its own small vocabulary for
the job:

| Term | What it is | The value it names |
|---|---|---|
| **Prisma App** | the artifact: the application you build (the outermost Module) | software with users and features — the whole point |
| **Module** | a building block you compose | a capability you reuse instead of writing |
| **Extension** | what you slot into `prisma-compose.config.ts` | the toolchain reaches my target/stack |
| **Topology** | the graph the framework produces | *(machinery — the user never says this)* |

You build a **Prisma App** by composing **Modules** with **Prisma Compose** — each
Module wrapping primitives like Compute and Postgres; the framework infers the
**Topology** and provisions it. App, Module, and Compose are the words a developer
says; Topology is the machinery underneath. The App is not a separate construct — it
is simply the outermost Module, the one you point `prisma-compose deploy` at. (The
whole surface carries the name: `@prisma/compose*` packages, the `prisma-compose`
CLI, `prisma-compose.config.ts` — per ADR-0026.)

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

These four measure how a name **describes**. Names that people talk *about* — above
all a framework, a milieu developers live inside — must also **refer**: pass the
workbench frame ("I'm working on this feature in ___"), the bare-token test, the
identity frames, and the hard artifact-collision rule (never name a tool after its
output). Both rubrics live in [vocabulary-tests.md](vocabulary-tests.md). Applying
the description tests alone is how the unit was misnamed "System"
([ADR-0025](../../docs/design/90-decisions/ADR-0025-name-the-unit-of-composition-module.md))
and the framework was misnamed "Prisma App"
([ADR-0026](../../docs/design/90-decisions/ADR-0026-name-the-framework-prisma-compose.md)).

The payoff of taking the value word for the brand: the precise words stay **free to
mean exactly what they mean one level down**. The same shape repeats at every layer —
the user names the left column, writes the middle, and the system consumes the
right:

| Product (what the user values) | Authored as | Compiles to |
|---|---|---|
| **App** | **Modules** you snap together | a **Topology** |
| **Prisma Data** | **models** in PSL | a **Contract** |

Note that "App" sits in the *Product* column, not the *Authored as* column — you do
not write an `app()`; you write `module()`, and the App is the outermost one. The
App is the artifact the user values; Prisma Compose is the tool that makes the row
true.

## The data layer: Prisma Data

The value here is *your data* — and above all accessing and querying it. That is why
the layer is named **Data**, not "Model" or "Contract." Modeling and migration are
the way in, not the goal, and you don't brand a product after the tax it charges.
Naming it "Data" also keeps the two precise words at work: you still author
**models** in PSL — the part of Prisma developers love, untouched — and those models
compile to a **Contract**, the typed boundary a Module's input requires and a
Postgres output satisfies. Data is the value; model is what you write; Contract is
what the app wires against.

## The building block: Module

A Module is a bounded context with typed inputs and outputs that behaves like a
service (see `docs/design/03-domain-model/glossary.md`). The typed boundary is what
makes it reusable: a stranger's auth Module drops into your app with a contract the
machine can check — which is what lets an **agent**, not just a human, compose it in
safely. Giving the shared unit its own short noun follows the tradition of a gem, a
crate, a package.

"Module" replaced the earlier names "Hex" and "System" after both failed the
spoken-sentence rubric in [vocabulary-tests.md](vocabulary-tests.md) — Hex by
forcing ecosystem identity onto the unit noun, System by having a size floor
("install the cron system" is a category error; a system is operated, not
installed). "Module" has no size floor, sits naturally in the install and publish
frames, and its prior art (Nest, Angular, Terraform) means exactly what we mean. The
full reasoning is in
[ADR-0025](../../docs/design/90-decisions/ADR-0025-name-the-unit-of-composition-module.md).

Vocabulary sits in three registers: a **package** is the artifact npm hosts (npm's
word, not ours); an **extension** slots into `prisma-compose.config.ts` and extends the
toolchain; a **Module** is what you plug together inside the app. One package may
register an extension and provide modules — "use the cron module from the compose-cloud
extension" is the model in one sentence.

## How Modules are distributed

Hosting and discovery are split:

- **Hosting → npm.** Modules are ordinary TypeScript libraries. npm brings semver,
  resolution, and tooling for free; the substrate stays boring and commodity.
- **Discovery → a registry.** A thin, named directory on top: search, ranking,
  trust, and a one-command install. **Its name is deferred** until the registry is
  built. Because the unit noun carries no identity burden, the registry name can be
  chosen purely for the identity frames ("it's on ___," "publish to ___") — the
  current shortlist holds **Prism** (Prisma-centric; tolerable adjacency at
  registry frequency, disqualifying at unit frequency).

This is the shape skills.sh proved — decentralized hosting, a named central
directory, one-command install — with one deliberate difference: **the registry's
install composes, it doesn't just copy.** skills.sh drops text files into an agent's
config; here the install wires a Module's typed contract into the app's topology.
That richer install is the point, and it depends on the typed-contract model being
sound. Because community Modules are arbitrary npm packages, the registry recognizes
them by convention — a `keywords` entry or a manifest field.

## The framework: Prisma Compose

"Compose" is semantically exact where every synonym is not: build, construct, and
make describe fabricating from raw material; *compose* means assembling finished
parts into a whole — which is the product ("composability" is already the term for
the property it sells). It passes the referential battery ("I'm working on this
feature in Compose" refers instantly), aligns the name with its role word in the
family table, and completes the vocabulary chain: **you compose Modules with Prisma
Compose into your Prisma App.** The token is shared with Docker Compose and Jetpack
Compose — evidence it carries a prefix well. Accepted trade-offs: the in-family
Compute/Compose adjacency (frames never overlap — things run *on* Compute, are
built *with* Compose) and an SEO fight with docker-compose-with-Prisma content
(winnable; see ADR-0026).

## Names to avoid

- **"Model" or "Contract" for the data layer** — each steals a word more useful one
  level down (`model` is the PSL construct; a `Contract` is what models compile to),
  and neither names the user's actual value: data access.
- **A registry name derived from the unit noun** — the registry deserves its own
  proper noun (gem→RubyGems, crate→crates.io), not "Module registry" as a brand.
  Deferred, not decided.
- **Branded unit nouns (Prism, Shard, Facet, Lens)** — identity is the registry's
  job; a branded unit noun fails the gloss test by construction and taxes every
  composition sentence (this is how we got "Hex"). Prism belongs on the registry
  shortlist, nowhere else.
- **"System" for anything** — superseded vocabulary
  ([ADR-0025](../../docs/design/90-decisions/ADR-0025-name-the-unit-of-composition-module.md));
  plain-English use in prose is fine, but no construct, term, or diagram label.
- **"Prisma App" for the tool** — it names the artifact only
  ([ADR-0026](../../docs/design/90-decisions/ADR-0026-name-the-framework-prisma-compose.md)).
  Docs say "built with Prisma Compose," never "built with Prisma App." The general
  rule is hard: never name a tool after its output.

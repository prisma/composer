# The names: Prisma Compose and Module

How the framework and its unit of composition got their names — the philosophy,
the selection rubrics, the candidates that lost, and the lessons worth keeping.
The binding decisions are [ADR-0026](../../docs/design/90-decisions/ADR-0026-name-the-framework-prisma-compose.md)
(Compose) and [ADR-0025](../../docs/design/90-decisions/ADR-0025-name-the-unit-of-composition-module.md)
(Module); the reusable rubrics live in [vocabulary-tests.md](vocabulary-tests.md).
This document is the story that connects them.

## The names at a glance

> You build a **Prisma App** by composing **Modules** with **Prisma Compose**, and
> deploy it to Prisma Cloud.

| Name | What it names | Register |
|---|---|---|
| **Prisma Compose** | the framework — the tool you work *in* | milieu (referential token) |
| **Module** / `module()` | the unit of composition — what you plug together | vocabulary noun |
| **Prisma App** | the artifact — the thing a user builds and deploys | value word (the hero noun) |
| **Service** | one deployed compute unit inside a Module | vocabulary noun |
| **Extension** | what you slot into `prisma-compose.config.ts` | vocabulary noun |
| **package** | the artifact npm hosts | npm's word — never renamed |
| **Topology** | the graph the framework infers | machinery — users never say it |

Surfaces follow the framework name everywhere a user meets it: packages
`@prisma/compose` and `@prisma/compose-prisma-cloud`, CLI `prisma-compose`, config
`prisma-compose.config.ts` ([ADR-0027](../../docs/design/90-decisions/ADR-0027-two-packages-compose-and-compose-prisma-cloud.md)).

## The philosophy

Every name here is chosen by asking **what job the word actually has to do**, and
the jobs differ by register. Three principles, each learned by shipping a wrong
name first:

**1. Products are named for user value — but a name must refer as well as
describe.** "Name the value, not the machinery" gave the family its role names
(Compute, Data, Postgres) and gave the artifact its hero noun: people say "my
app," never "my topology." But a name has two jobs — *describe* (what is this?)
and *refer* (which thing do you mean?) — and value-naming only measures the first.
The framework is not a component mentioned occasionally; it is a **milieu**
developers live inside and talk *about* constantly. Milieu names must be
referential tokens — which is why every durable framework name (Rails, Django,
Vite) names mechanism, exactly what the value rule forbids for components.

**2. Vocabulary nouns are not product names.** To a user, a container noun is
*all* machinery — the value lives in the capability (cron, auth), never in the
box. So the unit noun is chosen by a different rubric entirely: sentences said
aloud, at every grain, in every frame (authoring, composing, installing,
publishing).

**3. Identity belongs to the registry, not the unit noun.** Branded unit nouns
(Hex; later Prism, Shard, Facet as candidates) fail by construction — each gets
explained via the common word it displaced, and taxes every composition sentence
to buy an ecosystem signal that a registry name carries better. The registry name
is deferred until the registry exists; Prism sits on its shortlist.

## The rubrics

Three test batteries, applied by register (full versions in
[vocabulary-tests.md](vocabulary-tests.md)):

**Product value tests** (components): would the user say "my ___"? does it predict
the tooling? does it name the goal, not the tax? does it keep the family legible?

**Referential battery** (products people talk about, above all the framework):
- *Workbench frame:* "I'm working on this feature in ___" — the daily sentence.
- *Artifact-collision rule* (hard): never name a tool after its output.
- *Bare-token test:* people drop prefixes; does the name survive unprefixed?
- *Identity frames:* "Intro to ___", "___ 2.0", "does ___ support X?"

**Unit-noun spoken tests** (vocabulary): grain sweep ("the auth ___" *and* "a ___
providing one cron job"), repetition (three in one sentence, invisibly), install
("install the cron ___"), publish, instance/artifact duality, adjacency with
Service/App/Extension, the gloss test (if the explanation contains a better word,
the gloss wins), and a prior-art check against how developers actually talk.

## Why "Module"

The unit was **Hex**, then **System**, then Module — each failure teaching one of
the rules above.

**Hex** (a nod to hexagonal architecture) put ecosystem identity on the unit noun:
uniquely ours, wrong at first reading (a color, hexadecimal, a curse), a jargon
tax on every newcomer. **System** fixed the naive reading and failed in speech the
moment the first *small* shared unit existed: "install the cron system" is a
category error — English "system" has a size floor and an ownership register (a
system is something you *operate*, not something you install). "This system uses
the cron system and an image-resizer system" is barely sayable. The deciding
claim behind it — "nobody says 'my auth module'" — was simply false in the
ecosystems nearest ours (Nest, Angular, Terraform, Go), and our own README
betrayed the choice by introducing it as "a component — a System."

**Module** passes every spoken test. No size floor or ceiling ("the auth module,"
"a module providing one cron job," "your app is the outermost module"). Natural
in the consuming frames, because npm packages already *are* modules colloquially —
which supplies instance/artifact duality for free. Its prior art means exactly
our meaning: a Nest or Angular module is a composable boundary-owning unit wired
by dependency injection; a Terraform module is a reusable composition with typed
inputs and outputs. Nest's convention that the root module *is* the app
corroborates our model — the App is simply the outermost Module. The one real
adjacency, ES modules, is inter-register: file-grain vs composition-grain, and no
spoken sentence confuses them.

Runner-up: **component** — the word our own README glossed with, disqualified
because a Module *contains* React components; "the storefront component" is
ambiguous inside a single conversation.

## Why "Prisma Compose"

The framework was **MakerKit**, then **Prisma App**, then Compose — same lesson,
other register.

**MakerKit** was a standalone-mascot name that sat outside the family. **Prisma
App** scored perfectly on the value tests — it *is* the value word — and failed
every referential frame the first week the team lived with it: "I'm working on
this feature in App" refers to nothing. The cause is exact: **the tool was named
after its output.** "App" is the user's artifact word, so every mention of the
tool parses as a mention of the artifact, and no prefix rescues it — "Prisma app"
is already what everyone calls an app built with Prisma. The fix kept the value
word where it was always right (**Prisma App is the artifact**) and gave the tool
a referential token.

**Compose** won a graded rubric over Construct, Alloy, Assemble, Wire, Forge,
Stack, Prism, "Prisma Framework," and a nineteen-word synonym sweep — the only
candidate with no failing grade. It is also the semantically exact verb: build,
construct, make, and forge describe fabricating from raw material; *compose*
means assembling finished parts into a whole — functions, music, apps — which is
why "composability" was already the word for the property the framework sells.
It restores the family's own logic (the framework's role in the product table was
always "compose," so name and role now agree, as they do for Compute), and it
completes the vocabulary chain in one sentence: *you compose Modules with Prisma
Compose into your Prisma App.*

Near misses: **Construct** (fabrication semantics; a third com/con- token; "a
construct" blurs with Module), **Assemble** (already a pipeline stage —
`assemble` — and the whole cannot share a name with its part), **Alloy** (best
metaphor, metaphor tax). Accepted trade-offs, eyes open: the **Compute/Compose**
in-family adjacency (frames never overlap — things run *on* Compute, are built
*with* Compose), the shared token with Docker/Jetpack Compose (evidence it
carries a prefix well), and an SEO fight with docker-compose-with-Prisma content
(content contention is winnable; grammatical jamming — "Prisma app" — is not).

## Lessons worth keeping

- **Test names in speech, not on the page.** Every failure here read fine in
  writing and died in a spoken sentence. Capital letters are silent.
- **Test at the smallest grain.** Composition math puts most units below any hero
  example; "the auth system" proved nothing about "the cron system."
- **Never name a tool after its output.** Hard rule; no prefix rescues it.
- **The gloss test is a tell.** If you introduce a name by reaching for another
  word ("a component — a System"), the gloss is the better name.
- **Check "nobody says X" against reality.** The deciding claim for System was
  false in four neighboring ecosystems.
- **Put identity where it's said occasionally, not constantly.** Branded nouns
  belong on destinations (the registry), not on words used three times per
  sentence.

## Related

- [ADR-0025](../../docs/design/90-decisions/ADR-0025-name-the-unit-of-composition-module.md) — Module: the decision and full alternatives record.
- [ADR-0026](../../docs/design/90-decisions/ADR-0026-name-the-framework-prisma-compose.md) — Prisma Compose: the decision and full alternatives record.
- [ADR-0027](../../docs/design/90-decisions/ADR-0027-two-packages-compose-and-compose-prisma-cloud.md) — the two public packages carrying the names.
- [vocabulary-tests.md](vocabulary-tests.md) — the rubrics with both failure records.
- [naming.md](naming.md) — the product family and register model.
- [naming-proposal.md](naming-proposal.md) — the original proposal that opened the discussion (historical).

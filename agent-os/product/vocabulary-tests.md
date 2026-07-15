# Vocabulary tests — spoken-sentence rubrics

Two rubrics live here, both born from names that read well and failed in speech:
one for **units of composition** (produced by the "System" failure, resolved by
[ADR-0025](../../docs/design/90-decisions/ADR-0025-name-the-unit-of-composition-module.md)),
and one for **product names that must refer** (produced by the "Prisma App"
framework-name failure, resolved by
[ADR-0026](../../docs/design/90-decisions/ADR-0026-name-the-framework-prisma-compose.md)).
Every test in both is a sentence said aloud to a colleague.

## Part 1 — naming a unit of composition

The tests in [naming.md](naming.md) decide **product names** (Prisma Data): name
the value, not the machinery. They have no purchase on **vocabulary nouns** — the
words for constructs and units. To the user a container noun is *all* machinery;
the value lives in the capability (cron, auth), never in the box. So the box needs
its own rubric of speech.

These tests exist because "System" (ADR-0014) failed them in practice the moment the
first small shared unit (cron) landed. The ADR's case rested on one sentence at one
grain — "the auth system" — and on the claim that nobody says "the auth module."
People say "the auth module" all the time. See the failure record at the bottom.

## The register model

Three registers, only one of which we name:

- **Package** — the artifact npm hosts. npm owns this vocabulary; we don't rename it.
- **Extension** — what you slot into `prisma-composer.config.ts`: deploy targets, build
  kinds, anything that extends the toolchain.
- **Unit of composition** — what you plug together inside the app. This is the noun
  under test.

One npm package may register an extension *and* provide composable units; the
registers name roles, not artifacts.

## The tests

1. **Grain sweep.** "The auth ___" *and* "a ___ that provides one cron job." The
   noun must have no size floor and no size ceiling. Most units in a real ecosystem
   are small — composition math guarantees it — so a noun that only fits hero-sized
   units fails where most of the usage is.
2. **Repetition.** "This ___ uses the cron ___ and an image-resizer ___." The noun
   appears three times in an ordinary sentence about composition; it must stay
   invisible.
3. **Install.** "Install the cron ___ and use that." The noun must sit naturally in
   the consuming frame, not just the authoring frame.
4. **Publish.** "I published a ___." It should not be absurd. (Ecosystem *identity* —
   the "it's a gem" signal — is the registry's job, not this noun's. Forcing the
   unit noun to carry identity is how we got "Hex.")
5. **Instance/artifact duality.** Does the same word work for "the ___ on npm" and
   "the ___ in my app"? If not, split the registers deliberately (see above) rather
   than letting one word fail both.
6. **Adjacency.** Distinguishable in speech from Service, App, and Extension. If the
   glossary has to "hold the line" between two words, the name is already losing.
7. **The gloss test.** Introduce the noun without reaching for a different noun. If
   the explanation contains a better word, the gloss wins — stop and use it.
8. **Prior-art check.** Any claim about how developers talk ("nobody says X") must
   survive contact with real usage in adjacent ecosystems (Nest, Angular, Terraform,
   Go, Rails). Test the claim at more than one grain and in more than one sentence
   frame before it decides anything.

## Failure record: "System"

The case study that produced these tests:

| Test | Result |
|---|---|
| Grain sweep | Fails small: "the cron system" for a scheduled job is absurd. English "system" has a size floor — a system is something you *operate*. |
| Repetition | Fails: "this system uses the cron system and an image-resizer system." |
| Install | Fails: systems are operated, not installed — category error in the consuming frame. |
| Publish | Fails: "I published a system" is generic to the point of meaningless. |
| Duality | Fails both sides; no register split was defined. |
| Adjacency | Flagged in ADR-0014 itself: Service/System "needs the glossary to hold the line." |
| Gloss | Fails: the README introduces it as "a component — a System —". The gloss contained the better register. |
| Prior art | The deciding claim ("nobody says 'my auth module'") was false — tested at one grain, in one sentence, against one example app whose units were all hero-sized. |

**Outcome:** the rubric was applied and the unit renamed — the unit of composition
is a **Module**, authored with `module()`
([ADR-0025](../../docs/design/90-decisions/ADR-0025-name-the-unit-of-composition-module.md)).
"Module" passed every test; "component" fell to adjacency (a Module contains React
components — an intra-app collision); branded nouns (Prism, Shard, Facet, Lens) fell
to the gloss test and the identity rule, with Prism moving to the registry
shortlist.

## Part 2 — product names must also refer

A name has two jobs: to **describe** (what is this?) and to **refer** (which thing
do you mean?). The value tests in [naming.md](naming.md) measure description only.
A product that people talk *about* — above all a framework, which is a **milieu**
developers live inside, not a component inside their app — must also pass
referential frames:

1. **The workbench frame.** "I'm working on this feature in ___." Said by a
   contributor, understood by a stranger. The daily sentence; if it fails, the team
   invents shorthand and the name is already dead internally.
2. **The artifact-collision rule** (hard rule, not a scored test). The name must not
   be the word for what users produce with the tool. A tool named after its output
   can never be referred to separately from the output — every mention of the tool
   parses as a mention of the artifact, and no prefix can rescue it.
3. **The bare-token test.** People drop prefixes; does the name survive unprefixed?
   ("Rails" yes; "App" no.)
4. **Identity frames.** "Intro to ___" as a talk title, "___ 2.0", "does ___
   support X?" — all sayable and unambiguous.

The register distinction that decides *which* rubric applies: **components**
(Postgres, Compute, Data) are parts inside the user's app, mentioned occasionally
and happily prefix-qualified — the value rule names them well. A **framework** is a
milieu, named constantly in referential frames; every durable framework name
(Rails, Django, Next, Vite) is a distinctive token, and most name *mechanism* —
which is the proper register for a milieu, not a violation of the value rule.

### Failure record: "Prisma App" (as the framework name)

| Test | Result |
|---|---|
| Workbench frame | Fails: "I'm working on this feature in App" refers to nothing — the sentence the team needed all week and could not say. |
| Artifact collision | Fails the hard rule: the tool was named after its output. "App" is the user's artifact word. |
| Bare token | Fails: "app" is ambient noise in every conversation about software. |
| Identity frames | Fails: "App 2.0" and "Intro to Prisma App" cannot pick out the product. |

**Outcome:** the framework is **Prisma Composer**
([ADR-0026](../../docs/design/90-decisions/ADR-0026-name-the-framework-prisma-compose.md));
"Prisma App" is kept as the name of the *artifact*, where it was always right — you
compose Modules with Prisma Composer into your Prisma App. The verb *compose* beat
the field (Construct, Alloy, Assemble, Wire, Forge, Stack, Prism, and a nineteen-word
synonym sweep) as the only candidate with no failing grade and the semantically
correct one — build/construct/make mean fabricating from raw material, while *compose*
means assembling finished parts into a whole, which is what the framework does; the
framework itself takes the agent-noun form, **Composer**.

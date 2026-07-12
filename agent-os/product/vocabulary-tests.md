# Vocabulary tests — naming a unit of composition

The tests in [naming.md](naming.md) decide **product names** (Prisma App, Prisma
Data): name the value, not the machinery. They have no purchase on **vocabulary
nouns** — the words for constructs and units. To the user a container noun is *all*
machinery; the value lives in the capability (cron, auth), never in the box. So the
box needs its own rubric, and it is a rubric of **speech**: every test below is a
sentence said aloud to a colleague.

These tests exist because "System" (ADR-0014) failed them in practice the moment the
first small shared unit (cron) landed. The ADR's case rested on one sentence at one
grain — "the auth system" — and on the claim that nobody says "the auth module."
People say "the auth module" all the time. See the failure record at the bottom.

## The register model

Three registers, only one of which we name:

- **Package** — the artifact npm hosts. npm owns this vocabulary; we don't rename it.
- **Extension** — what you slot into `prisma-app.config.ts`: deploy targets, build
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

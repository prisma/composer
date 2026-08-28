# ADR-0026: Name the framework "Prisma Compose"; "Prisma App" names the artifact

## Decision

The framework is **Prisma Compose**. The thing you build and deploy with it is
a **Prisma App** — that name is kept, and now means only the artifact:

```ts
import { module } from '@prisma/compose';
```

```sh
prisma-compose deploy app.ts   # reads prisma-compose.config.ts for its targets
```

You compose Modules with Prisma Compose into your Prisma App. The whole
surface follows the framework's name: the package family is
**`@prisma/compose*`** (`@prisma/compose`, `@prisma/compose-prisma-cloud`, and
others), the CLI binary is **`prisma-compose`**, the config file is
**`prisma-compose.config.ts`**, and the scratch directory is
**`.prisma-compose/`**. A name that exists so people can refer to the tool has
to be the name they meet at every surface — a split identity, where the
framework is called one thing and its packages another, would re-create the
referential problem this decision exists to fix.

## Reasoning

A name has two jobs: to **describe** (what is this?) and to **refer** (which
thing do you mean?). "Prisma App" was chosen by tests that measure description
only — would the user say "my app," does it name the goal — and by those tests
it scored perfectly. But then people tried to talk about the *tool*, and four
frames all broke. The **workbench sentence**, "I'm working on this feature in
App," refers to nothing — the sentence every contributor and community member
says daily can't pick the framework out of the world. The **bare token**, "does
App support X?", vanishes into the ordinary word. **Versioning**, "Prisma App
2.0," and a **talk title**, "Intro to Prisma App," fail the same way. The tests
that chose the name were never asked to check whether it could also refer.

The cause is precise: **the tool was named after its own output.** "App" is
the word for the user's artifact, so a tool sharing that name can never be
referred to separately from what it produces — every mention of the tool
parses as a mention of the artifact. No prefix rescues this, because the
compound word *is* the artifact phrase.

Underneath is a register distinction — the role a word plays, not just its
literal meaning. Postgres, Compute, and Data are **components**: parts inside
the user's app, mentioned occasionally, and correctly named by the
description-first rule. A framework is not a component; it's a **milieu** —
the thing a developer lives inside all day, said constantly by four different
groups: users asking about the tool, contributors placing work in it, the
ecosystem forming identity around it, and everyone versioning it. Durable
framework names — Rails, Django, Next, Vite — are distinctive tokens, and most
of them name *mechanism* rather than the user's goal. The description-first
rule was right for components; applying it to the one family member that's a
milieu, not a component, was the mistake.

"Compose" wins on both jobs. "I'm working on this feature in Compose" refers
instantly. It shares its token with Docker Compose and Jetpack Compose, which
is evidence it carries a framework name well — two major products already
share it without confusion. And it's semantically exact: build, construct,
make, and forge all describe fabricating from raw material, while *compose*
specifically means assembling finished parts into a whole — functions, music,
and now apps — which is already why "composability" is the established term
for what the framework sells. It also restores the family's own logic: the
framework's role in the product table was always "compose," so the name and
the role word now agree, the same way they already do for Compute.

The rule this satisfies, then, is: a milieu gets a distinctive,
mechanism-naming token; an artifact gets a goal-naming one. "Prisma Compose" is
the milieu name; "Prisma App" stays as the artifact name, which is what it was
always right for. A full candidate sweep — Construct, Assemble, Alloy, Wire,
Forge, Stack, Prism, "Prisma Framework," and a synonym pass — confirmed Compose
as the only candidate with no outright failure; the near misses are recorded
under Alternatives.

## Consequences

- **A full-surface rename.** Packages (`@prisma/app*` → `@prisma/compose*`,
  with directory names, workspace references, and imports following), the CLI
  binary (`prisma-app` → `prisma-compose`), the config file
  (`prisma-app.config.ts` → `prisma-compose.config.ts`), the scratch directory
  (`.prisma-app/` → `.prisma-compose/`), and all docs prose stop calling the
  framework "Prisma App" and say "Prisma Compose."
- **Artifact-sense "Prisma App" stays.** Occurrences that mean the *artifact*
  ("a Prisma App is one Prisma Cloud Project," "deploy your Prisma App") are
  correct and remain. The prose sweep is judgment work, not a blind
  substitution: substitute "the user's application" → keep; substitute "the
  tool" → rename.
- **A future unified CLI reads naturally.** `prisma-compose deploy` today
  leaves room for `prisma compose deploy` as a subcommand later.
- **"Prisma App" gains a sharper meaning.** It's the artifact and the platform
  story ("build Prisma Apps"), never the tool. Docs should not say "built with
  Prisma App"; they say "built with Prisma Compose."
- **The Compute/Compose adjacency is accepted, eyes open.** Two "com-" words in
  one family, one vowel apart. The frames don't overlap — things run *on*
  Compute, things are built *with* Compose; one is a component, the other the
  milieu — but if docs ever need a disambiguating gloss between the two,
  revisit.
- **An SEO fight is chosen deliberately.** "prisma compose" queries return
  docker-compose-with-Prisma content today; displacing that takes a product
  page and docs, a cost accepted because content contention is winnable.
- **The registry name stays deferred**, unaffected.

## Alternatives considered

- **Keep "Prisma App" for the framework.** Fails every referential frame — the
  workbench sentence, the bare token, versioning, talk titles — because the
  tool is named after its own output. Kept instead as the artifact name, where
  it was always right.
- **Prisma Construct.** The only other candidate with no outright failure:
  refers cleanly, and has installable prior art (Construct 3, a game engine).
  Loses on semantics (constructing is fabrication; composing is assembly of
  finished parts), on adding a third com-/con- token to the family, and on "a
  construct" blurring with Module as a noun.
- **Prisma Assemble.** Accurate and distinctive, but the framework already
  uses "assemble" for a build pipeline stage
  ([ADR-0005](ADR-0005-users-build-the-framework-assembles.md)); the whole
  can't share a name with one of its own parts.
- **Prisma Alloy.** The best metaphor in the field — finished parts fused into
  a stronger whole — but it taxes every first encounter with the metaphor, and
  MIT's Alloy analyzer is dev-adjacent prior art.
- **Prisma Wire.** Steals "wire," the working verb the docs already use in
  nearly every composition sentence.
- **Prisma Forge / Stack / Prism / "Prisma Framework."** Forge collides with
  Laravel Forge (same category); Stack is ambient noise and a partner's
  product name; Prism is one phoneme from the master brand and reserved on the
  registry shortlist; "Prisma Framework" is an earlier abandoned rebrand and
  fails every identity frame.
- **A synonym sweep** (create, build, make, merge, produce, work, resolve,
  combine, unite, invent, modulate, chime, cook, arrange, piece) — all failed
  on jammed tokens, same-category collisions (Combine is Swift's framework;
  Chime is Amazon's), or the wrong meaning (modulate, unite, invent, piece).

## Related

- [ADR-0014](ADR-0014-one-authoring-primitive.md) — the framework, package,
  and CLI names this ADR supersedes; its single-primitive decision stands.
- [ADR-0025](ADR-0025-name-the-unit-of-composition-module.md) — the unit noun
  (Module) this name composes with.

# ADR-0026: Name the framework "Prisma Compose"; "Prisma App" names the artifact

## Decision

The framework is **Prisma Compose**. The thing you build and deploy with it is a
**Prisma App** — that name is kept and now means *only* the artifact, which is what
it always named best. You compose Modules with Prisma Compose into your Prisma App.

The whole surface follows the name: the package family becomes **`@prisma/compose*`**
(`@prisma/compose`, `@prisma/compose-cloud`, `@prisma/compose-node`,
`@prisma/compose-rpc`, `@prisma/compose-nextjs`, `@prisma/compose-assemble`,
`@prisma/compose-cli`, `@prisma/compose-cron`). `@prisma/alchemy` is renamed too —
**`@prisma/compose-alchemy`** — because its independence was a fiction: every
published version depends on `@prisma/app`, so it is a member of the family and
should say so. The CLI binary becomes **`prisma-compose`**, the config file
**`prisma-compose.config.ts`**, and the scratch directory **`.prisma-compose/`**.
A name that exists so people can refer to the tool must be the name they meet at
every surface — a split identity (framework called one thing, packages called
another) re-creates the referential problem this decision exists to fix. Renaming
the repository is a separate, optional decision.

## Reasoning

A name has two jobs: to **describe** (what is this?) and to **refer** (which thing
do you mean?). The product-name tests that chose "Prisma App" measure description
only — would the user say "my app," does it name the goal — and by those tests the
name scored perfectly. Then the team tried to talk about the product. "I'm working
on this feature in App" refers to nothing: the sentence that every contributor,
integrator, and community member says daily cannot pick the framework out of the
world. "Prisma App 2.0," "Intro to Prisma App," "does App support X?" all fail the
same way. The tests never included a referential frame, so the name was never asked
to refer.

The failure has a precise cause: **the tool was named after its output.** "App" is
the word for the user's own artifact, and a tool named identically to what it
produces can never be referred to separately from it — every mention of the tool
parses as a mention of the artifact. No prefix can rescue it, because the compound
is the artifact phrase.

Underneath sits a register error. Postgres, Compute, and Data are **components** —
parts inside the user's app, mentioned occasionally, naturally prefix-qualified, and
correctly named by the value rule. A framework is not a component; it is a
**milieu** — the thing a developer lives inside all day, named constantly in
referential frames by four populations: users asking about the tool, contributors
placing work in it, the ecosystem forming identity around it, and everyone
versioning it. Every durable framework name — Rails, Django, Next, Vite — is a
distinctive token, and notably most of them name *mechanism*, which the value rule
forbids. The value rule was right for components and was extended to the one family
member that is not one. The referential test battery that captures this is recorded
alongside the unit-noun rubric in `agent-os/product/vocabulary-tests.md`.

"Compose" wins the referential battery and keeps everything the value rule wanted.
"I'm working on this feature in Compose" refers instantly. The token is shared with
Docker Compose and Jetpack Compose — which is evidence it carries a prefix well, not
evidence against it; two major products already coexist on it. It is semantically
exact in a way no synonym is: build, construct, make, and forge all describe
fabricating from raw material, while *compose* specifically means assembling
finished parts into a whole — functions, music, and now apps — which is why
"composability" is already the established term for the property the framework
sells. And it restores the family's own logic: the framework's role in the product
table was always "compose"; now the name and the role word agree, exactly as they do
for Compute.

ADR-0014 rejected Compose on three grounds, none of which survives. "It names the
mechanism, not the goal" — correct, and that is the proper register for a milieu
(Rails names mechanism; the goal word stays with the artifact, which keeps the name
"Prisma App"). "Compose is a verb, not a noun" — Docker and Jetpack disproved this
in production. "The search space is owned by docker-compose-with-Prisma content" —
that is content contention, winnable by shipping a product page and docs; it is not
a structural defect of the name.

A full candidate rubric was run — Compose, Construct, Alloy, Assemble, Wire, Forge,
Stack, Prism, "Prisma Framework," and a nineteen-word synonym sweep. Compose was the
only candidate with no grade below B−. The near misses are recorded under
Alternatives.

## Consequences

- **A full-surface rename.** Packages (`@prisma/app*` → `@prisma/compose*` and
  `@prisma/alchemy` → `@prisma/compose-alchemy`, with directory names, workspace
  references, and imports following), the CLI binary
  (`prisma-app` → `prisma-compose`), the config file
  (`prisma-app.config.ts` → `prisma-compose.config.ts`), the scratch directory
  (`.prisma-app/` → `.prisma-compose/`), and all docs prose — README, design docs,
  glossary, skills, and earlier ADRs — stop calling the framework "Prisma App" and
  say "Prisma Compose."
- **Artifact-sense "Prisma App" stays.** Occurrences that mean the *artifact* (e.g.
  ADR-0023's "a Prisma App is one Prisma Cloud Project," "deploy your Prisma App")
  are correct and remain. The prose sweep is judgment work, not a blind
  substitution: substitute "the user's application" → keep; substitute "the tool" →
  rename.
- **Published package names churn pre-GA.** The `@prisma/app*` packages are on npm
  at 0.2.0-dev; the rename means new names and a deprecation pointer on the old
  ones, handled per the repo's versioning process.
- **A future unified CLI reads naturally.** `prisma-compose deploy` today leaves
  room for `prisma compose deploy` as a subcommand later, per the same reasoning
  ADR-0014 applied to `prisma-app`.
- **"Prisma App" gains a sharper meaning.** It is the artifact and the platform
  story ("build Prisma Apps"), never the tool. Docs should not say "built with
  Prisma App"; they say "built with Prisma Compose."
- **The Compute/Compose adjacency is accepted, eyes open.** Two com- words in one
  family, one vowel apart. The frames do not overlap — things run *on* Compute,
  things are built *with* Compose; one is a component, the other the milieu — but
  this is the same S-word adjacency class ADR-0014 accepted for Service/System, and
  that one eventually failed. If docs ever need a disambiguating gloss between the
  two, revisit.
- **An SEO fight is chosen deliberately.** "prisma compose" queries return
  docker-compose-with-Prisma content today. Displacing that requires a product page
  and docs; the cost is accepted because content contention is winnable.
- **The family table updates**: the row reads Prisma Compose *(← Prisma App ←
  MakerKit)*, role "compose."
- **The registry name stays deferred**, unaffected.

## Alternatives considered

- **Keep "Prisma App" for the framework.** Fails every referential frame — the
  workbench sentence, the bare token, versioning, talk titles — because the tool is
  named after its output. Kept instead as the artifact name, where it was always
  right.
- **Prisma Construct.** The only other candidate with no outright failure: refers
  cleanly, accurate, installable prior art (Construct 3, a game engine). Loses on
  semantics (constructing is fabrication; composing is assembly of finished parts),
  on adding a third com/con- token to the family, and on "a construct" blurring with
  Module as a noun.
- **Prisma Assemble.** Accurate and distinctive, but the framework already uses
  "assemble" for a pipeline stage (`@prisma/app-assemble`,
  [ADR-0005](ADR-0005-users-build-the-framework-assembles.md)); the whole cannot
  share a name with one of its parts.
- **Prisma Alloy.** The best metaphor in the field (finished parts fused into a
  stronger whole, with an Alchemy resonance) but a metaphor tax on every first
  encounter, plus MIT's Alloy analyzer as dev-adjacent prior art.
- **Prisma Wire.** Steals "wire," the working verb the docs use in nearly every
  composition sentence — the same word-theft the data layer avoided by not taking
  "Model."
- **Prisma Forge / Stack / Prism / "Prisma Framework."** Forge collides with Laravel
  Forge (same category); Stack is ambient noise and a partner's product name; Prism
  is one phoneme from the master brand and reserved on the registry shortlist;
  "Prisma Framework" is our own abandoned 2019 rebrand and fails every identity
  frame.
- **Synonym sweep** (create, build, make, merge, produce, work, resolve, combine,
  unite, invent, modulate, chime, cook, arrange, piece). All die on jammed tokens
  (build, merge, make, work, create, produce, resolve), same-category collisions
  (Combine — Swift's framework; Chime — Amazon's), or wrong meaning (modulate,
  unite, invent, piece). The sweep confirmed Compose is not merely the best-graded
  option but the semantically correct verb.

## Related

- `agent-os/product/vocabulary-tests.md` — the referential test battery and the
  "Prisma App" failure record.
- `agent-os/product/naming.md` — the family table and register model.
- [ADR-0014](ADR-0014-one-authoring-primitive.md) — the
  superseded framework, package, and CLI names; its single-primitive decision
  stands.
- [ADR-0025](ADR-0025-name-the-unit-of-composition-module.md) — the unit noun
  (Module) this name composes with.

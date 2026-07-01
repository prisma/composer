# Alchemy (inspiration + viability study)

[Alchemy](https://alchemy.run) is a TypeScript-native infrastructure framework.
Its v2 line ("Infrastructure-as-Effects") rebuilds the tool on
[Effect](https://effect.website) and models applications very close to how
MakerKit does: resources + executables defined in code, dependency injection
instead of globals, and swappable implementations behind typed interfaces.

This folder exists for two reasons:

1. **Reference library** — a local copy of the v2 docs so we can mine the model.
2. **Viability study** — whether MakerKit should adopt Alchemy instead of being built.

## Read this first

- **[viability-assessment.md](viability-assessment.md)** — the answer to "use
  Alchemy instead of building MakerKit?", with the reasoning.

## Domain analysis (research library)

DDD-style notes on Alchemy's domain and ubiquitous language, mirroring the
structure of the other inspirations (e.g. `../Convex/`). "How Alchemy works" is
kept here; "what MakerKit should do about it" lives in the takeaways doc.

- `glossary.md`: domain terms and definitions (user-facing vs internal)
- `domain-map.md`: a conceptual relationship map of the domain
- `operations.md`: the verbs on each domain concept
- `user-domain.md`: the user's mental model and how it maps to internal mechanics
- `execution-flows.md`: the core loop — declare resources, wire bindings, deploy
  (plan → apply), run; plus phases, Layer-swap, references, local dev, streams
- `takeaways-for-makerkit.md`: what we want to emulate/adapt (expected to change)

## What's here

- `docs/` — the full v2 documentation site (`v2.alchemy.run`), downloaded as
  markdown on 2026-06-29. Mirrors the site's URL paths.
  - `docs/llms.txt` — the site's own navigation index (every page + one-line summary).
  - `docs/concepts/` — the mental model (Stack, Resource, Platform, Phases,
    Binding, Layers, State Store, …). Start with `what-is-alchemy.md`,
    `concepts/platform.md`, `concepts/phases.md`, `concepts/binding.md`,
    `concepts/layers.md`.
  - `docs/guides/` — task guides (infrastructure-layers, custom-provider,
    migrating-from-v1, …).
  - `docs/tutorial/` — Cloudflare and AWS walkthroughs.

The ~450 auto-generated per-resource provider API pages (AWS/Cloudflare resource
reference) were **not** downloaded — they're noise for a design study. Browse
them at `v2.alchemy.run/providers/` if needed.

## Facts worth knowing (as of 2026-06-29)

- **Two doc sites**: `alchemy.run` (v1, async/await) and `v2.alchemy.run` (v2,
  Effect). The version the model resembles is **v2**.
- **v2 is beta**: npm `latest` is still v1 (`0.93.12`); the Effect version ships
  under `next` as `2.0.0-beta.59`.
- **License**: Apache-2.0.
- **Effect is a hard dependency** of v2 — not optional.
- **v1 source** is public (`github.com/alchemy-run/alchemy`, ~2.2k stars).
  The **v2 source** repo referenced in the docs (`sam-goodwin/alchemy-effect`)
  is not publicly accessible, though the package is on npm.

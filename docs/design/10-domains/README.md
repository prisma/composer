# Domain deep dives

Lower-level, per-domain deep dives live here. They are written in the
architecture/design phase that comes *after* the high-level model is settled.

- [`core-model.md`](core-model.md) — the complete class/data-structure design of
  `@prisma/app` and the target-pack contract, with `@prisma/app-cloud` as
  the worked instance.
- [`deploy-cli.md`](deploy-cli.md) — the MakerKit-owned deploy entrypoint
  (`makerkit deploy` / `makerkit destroy`): the pipeline, the pack CLI seam and
  per-kind assembly contracts, and the error surface. Rests on ADR-0003 …
  ADR-0006.
- [`hex-composition.md`](hex-composition.md) — hex boundaries (deps/expose),
  forwarding, nesting, and the packaged reusable hex. Rests on ADR-0014.

The settled high-level model is recorded in:

- [`../00-purpose/`](../00-purpose/) — purpose and goals
- [`../01-principles/`](../01-principles/) — guiding and architectural principles
- [`../03-domain-model/`](../03-domain-model/) — glossary, domain map, and layering (MakerKit → Alchemy → Prisma Cloud)
- [`../02-example-app/`](../02-example-app/) — a worked example

The earlier brain-dump and stub deep-dives were removed once their content was
factored into the docs above. Fresh deep dives will be added here as we design
each domain in detail.

# Domain deep dives

Lower-level, per-domain deep dives live here. They are written in the
architecture/design phase that comes *after* the high-level model is settled.

- [`core-model.md`](core-model.md) — the complete class/data-structure design of
  `@prisma/app` and the target-pack contract, with `@prisma/app-cloud` as
  the worked instance.
- [`deploy-cli.md`](deploy-cli.md) — the Prisma App Framework's own deploy
  entrypoint (`prisma-app deploy` / `prisma-app destroy`): the pipeline, the
  pack CLI seam and per-kind assembly contracts, and the error surface. Rests
  on ADR-0003 … ADR-0006.
- [`system-composition.md`](system-composition.md) — system boundaries
  (deps/expose), forwarding, nesting, and the packaged reusable system. Rests
  on ADR-0016.
- [`config-params.md`](config-params.md) — how service config is declared
  (a caller-owned schema), carried through deploy, serialized to platform
  storage by the target (over key/value string pairs), and read back at boot.
  Rests on ADR-0018 and ADR-0019.
- [`scheduled-work.md`](scheduled-work.md) — cron as a driver System: a
  scheduler that depends on what it calls, the schedule as build-time config,
  emulated now and native-lowerable later. Rests on ADR-0020.

The settled high-level model is recorded in:

- [`../00-purpose/`](../00-purpose/) — purpose and goals
- [`../01-principles/`](../01-principles/) — guiding and architectural principles
- [`../03-domain-model/`](../03-domain-model/) — glossary, domain map, and layering (Prisma App Framework → Alchemy → Prisma Cloud)
- [`../02-example-app/`](../02-example-app/) — a worked example

The earlier brain-dump and stub deep-dives were removed once their content was
factored into the docs above. Fresh deep dives will be added here as we design
each domain in detail.

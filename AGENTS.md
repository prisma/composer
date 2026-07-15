# Agent guidance — Prisma Compose

**Before doing any design or implementation work in this repo, read the
guiding principles: [`docs/design/01-principles/`](docs/design/01-principles/).**
They are binding, not advisory. Proposals and code that contradict a recorded
principle are wrong by definition — the principle wins until an ADR supersedes
it. In particular: **we don't bundle the app's code, and we don't guess** — the
framework never bundles/transforms your code, and assembles the deploy artifact
only by documented, deterministic steps (no filename/depth guessing, no tree
laundering)
([ADR-0005](docs/design/90-decisions/ADR-0005-users-build-the-framework-assembles.md)).

For design work, also check:

- [`docs/design/00-purpose/`](docs/design/00-purpose/) — what this framework is for.
- [`docs/design/90-decisions/README.md`](docs/design/90-decisions/README.md) —
  the ADR index. Settled decisions are not relitigated; ground proposals in
  what is already decided.

Operational rules (naming, casts, build isolation, test idioms) live in
[`.agents/rules/`](.agents/rules/) and load automatically in harnesses that
support `.mdc` rules; if yours doesn't, read that directory's README and the
rules relevant to the files you touch.

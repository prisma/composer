# Agent guidance — Prisma Composer

**Before doing any design or implementation work in this repo, read the
guiding principles: [`docs/design/01-principles/`](docs/design/01-principles/).**
They are binding, not advisory. Proposals and code that contradict a recorded
principle are wrong by definition — the principle wins until an ADR supersedes
it. In particular: **we don't bundle the app's code, and we don't guess** — the
framework never bundles/transforms your code, and assembles the deploy artifact
only by documented, deterministic steps (no filename/depth guessing, no tree
laundering; symlinks are preserved as links only when their resolved target
stays inside the bundle, and never dereferenced)
([ADR-0005](docs/design/90-decisions/ADR-0005-users-build-the-framework-assembles.md),
amended by
[ADR-0047](docs/design/90-decisions/ADR-0047-compute-assembly-preserves-safe-runtime-topology.md)).

## A layer does not know what is built on it

This is an
[architectural principle](docs/design/01-principles/architectural-principles.md#a-layer-does-not-know-what-is-built-on-it),
and it is the one agents most often break without noticing. It comes up as a
shortcut: code in a higher layer needs a value, the only thing it holds is a
lower layer's interface, and one more member on that interface is the shortest
way. Stop there and read the principle.

If the member would exist for one kind of Connection, one deployment target or
one Module, do not build it. Do not offer it to the operator as an option
either, whether the idea is yours or a subagent's: the operator would have to
catch the problem themselves, and the gap in the design you found would go
unreported. Report the gap instead: what the higher layer needs, and why
nothing that exists carries it.

## Read the design docs before any design discussion

Before your first reply that offers an opinion, a proposal, or an answer to a
design question, read the documentation for that topic. This applies even when
the question looks small or conversational, and again whenever the discussion
moves to a new topic. Read:

1. [`docs/design/01-principles/`](docs/design/01-principles/) and
   [`docs/design/00-purpose/`](docs/design/00-purpose/).
2. The ADR index,
   [`docs/design/90-decisions/README.md`](docs/design/90-decisions/README.md),
   then every ADR it ties to the topic, in full, including the ADRs that amend
   them.
3. The [glossary](docs/design/03-domain-model/glossary.md) entry for every term
   the discussion uses.
4. The domain or architecture doc for the area, under
   [`docs/design/10-domains/`](docs/design/10-domains/) or the target's folder.

In your reply, say what you read. Settled decisions are not relitigated by
accident: when a proposal contradicts a recorded decision, say so plainly and
say what it would reverse. A discussion held without reading these has
repeatedly produced proposals that a recorded decision had already rejected,
renames of terms the glossary defines on purpose, and identity formats the
recorded design contradicts.

Operational rules (naming, casts, build isolation, test idioms) live in
[`.agents/rules/`](.agents/rules/) and load automatically in harnesses that
support `.mdc` rules; if yours doesn't, read that directory's README and the
rules relevant to the files you touch.

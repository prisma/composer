# Slice 2 — The container boundary moves; the exception is deleted

**Linear:** TML-3058 · **Branch:** `tml-3058-container-boundary` (stacked on
`tml-3057-deploy-identity-one-reader`; PR targets main after #137 merges)
**Design:** `../../design-notes.md` (binding, in full — this slice implements
everything except § Slice 1)

## Outcome

The full boundary move: core SPI + transport, CLI cutover, child threading,
prisma-cloud implementation, config surface change, ADR + docs, deletion of
the `crossDomainExceptions` entry, deletion of `.drive/projects/state-under-branch/`.
One PR. Project DoD (`../../spec.md`) becomes fully checkable.

## Scope

**In:** everything design-notes § "Change inventory / Slice 2" lists.
**Out:** anything else; in particular no change to `--name`/`--stage`/
`--production` semantics and no pinned/no-create mode.

## Definition of done

The project DoD in `../../spec.md`, plus: every error text matches
design-notes § Error surface verbatim; the stale-docs grep sweep is clean.

## Validation gate

Full workspace, from repo root:
`pnpm typecheck && pnpm test && pnpm lint && pnpm lint:casts && pnpm lint:deps`
plus the DoD greps (design-notes § Docs sweep + project-DoD greps), plus the
live deploy → destroy round trip (D3).

## Dispatch plan

Sequential; D1 is the only large one (splitting the cutover would leave the
workspace red between dispatches — the SPI change and its consumers must move
together).

- **D1 — code cutover.** Outcome: all source/test/config changes of
  design-notes § Slice 2 (core, CLI, prisma-cloud, ten config call sites,
  exception deletion) landed; full workspace gate green; DoD greps clean.
  Builds on: slice 1. Hands to: D2 a green tree whose only remaining work is
  prose. Gate: the full workspace gate above + DoD greps.
- **D2 — ADR + docs + sweeps.** Outcome: the new ADR (number claimed against
  current main), ADR index row, deploy-cli.md/core-model.md/ADR-0017/guides
  updates, stale-reference sweep clean, `.drive/projects/state-under-branch/`
  deleted. Builds on: D1. Hands to: D3 a PR-ready tree. Gate:
  `pnpm lint:deps` + the sweep greps (no code changes expected; full gate
  re-run only if code moved).
- **D3 — live proof + PR.** Outcome: deploy → destroy round trip against the
  dogfood workspace behaves identically to before (zero residue; state on
  the stage's Branch), evidence captured in the implementer report; PR
  opened. Builds on: D2. Gate: the live round trip itself.

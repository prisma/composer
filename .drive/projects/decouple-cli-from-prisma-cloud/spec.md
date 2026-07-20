# Project spec — Decouple CLI from Prisma Cloud

**Tracker:** https://linear.app/prisma-company/project/prisma-composer-decouple-cli-from-prisma-cloud-bf4f2b4b51f3
**Design:** `design-notes.md` (binding; settled with operator 2026-07-20)

## Purpose

The framework domain (`packages/0-framework`) is defined as importing nothing,
but Prisma Cloud semantics leak through it at four sites, held together by a
`crossDomainExceptions` escape hatch. While the leak exists, the framework is
platform-neutral in name only: no second platform extension can exist, and
every "extension-agnostic" claim in the docs carries an asterisk. This project
makes the boundary real — the framework orchestrates container lifecycle,
preflight, teardown, and child-process transport without knowing any
platform's names for anything.

## At a glance

Container resolution, container removal, hook context, and parent→child env
threading all move behind `ExtensionDescriptor` (ADR-0017's pattern, ADR-0033's
opacity idiom). The extension owns its container type and its serialization;
core owns orchestration and transport. `PRISMA_PROJECT_ID`/`PRISMA_BRANCH_ID`
cease to exist. Full mechanism: `design-notes.md`.

## Non-goals

- No pinned/no-create container mode (successor GitHub App project); the
  interface must merely not preclude it.
- No change to `--name`/`--stage`/`--production` semantics or defaults.
- No change to what containers Prisma Cloud uses (Project/Branch mapping,
  ADR-0023/0024) or to state placement (ADR-0034).
- No programmatic deploy API; the CLI remains the only driver.
- No relitigation of teardown's shape (#113) or of state-store singularity
  (ADR-0017).

## Cross-cutting requirements

1. **Boundary:** no `@internal/lowering` import and no Prisma Cloud
   vocabulary (`projectId`, `branchId`, `PRISMA_*` outside the framework's
   own `PRISMA_COMPOSER_*` namespace) in `packages/0-framework/**` source.
2. **Behavior preservation:** a deploy → destroy round trip is observably
   identical to today (same containers created/removed, same state
   placement, same ordering guarantees, same error texts per the design's
   error table).
3. **Opacity discipline:** core carries extension values as
   `ContainerInstance`/`unknown` only; every precise claim lives in the
   owning extension behind a guard or the descriptor generic (ADR-0033).
4. **Injection discipline:** extension code receives its container as a
   parameter everywhere (hooks, state creation); no global lookups, no
   process-boundary awareness in extension code.
5. **One-PR docs rule:** the ADR, doc updates, and implementation land in
   the same PR (operator rule: never docs-only).

## Transitional-shape constraints

- Slice 1 (prisma-cloud-internal refactor) must be behavior-invariant and
  mergeable alone with all checks green.
- No dual-path transitional state in the CLI (no "descriptor if present,
  else built-in resolution" fallback) — slice 2 cuts over atomically.

## Project DoD

- [ ] `crossDomainExceptions` entry `cli → lowering` deleted from
      `architecture.config.json`; `pnpm lint:deps` passes.
- [ ] `git grep -rn "@internal/lowering" packages/0-framework/ --include='*.ts'`
      returns nothing (source; `dist/` excluded).
- [ ] `git grep -rnE "projectId|branchId|PRISMA_(?!COMPOSER_)" packages/0-framework/`
      returns nothing for source files (perl-regexp grep; `PRISMA_COMPOSER_*`
      is the framework's own namespace and allowed).
- [ ] Workspace checks green: `turbo run test typecheck`, biome, cast-ratchet
      delta ≤ 0, `pnpm lint:deps` (incl. architecture coverage).
- [ ] Live deploy → destroy round trip against the dogfood workspace behaves
      identically to before: zero residue, state on the stage's Branch.
- [ ] ADR merged in the same PR as the code; ADR index updated; stale-docs
      grep sweep (design-notes § Docs) returns nothing.
- [ ] Close-out: `.drive/projects/state-under-branch/` deleted (slice 2 PR);
      long-lived content migrated to `docs/`; `.drive/projects/decouple-cli-from-prisma-cloud/`
      deleted; repo-wide references stripped.

## Open questions

None — design settled (see `design-notes.md` § Decisions).

## References

- `design-notes.md` — the binding design.
- ADR-0017, ADR-0023/0024, ADR-0028, ADR-0033, ADR-0034.
- `docs/design/10-domains/deploy-cli.md`.
- PR #113 (teardown hook — the pattern precedent) and its review threads.
- Linear agent brief 2bdada7e1f22.

# Dispatch D7 brief (ready once D6 is SATISFIED)

# Dispatch D7 — ADR-0033 + the rule + doc touch-ups + final verification

D6 is reviewed and SATISFIED. D7 is the documentation + guardrail dispatch that
ships in THIS PR (repo policy: no docs-only PRs — the ADR and its implementation
are one PR). No source moves. One or two commits.

**Read first for the decisions to record:**
`.drive/projects/exports-entrypoint/learnings.md` (every decision + finding this
slice produced) and `.drive/projects/exports-entrypoint/slices/exports-entrypoint/spec.md`
(the chosen design). The ADR/rule must reflect what was ACTUALLY built, not the
original plan.

## 1. ADR-0033
Create `docs/design/90-decisions/ADR-0033-public-entrypoints-live-in-src-exports.md`
(check the exact next number is 0033 — latest is ADR-0032). Follow the format of
`ADR-0028-numbered-domains-and-layers-enforced-by-dependency-cruiser.md`:
`# ADR-0033: <title>` → `## Decision` → rationale sections. Keep it terse and in
plain English (no invented jargon). It **completes ADR-0028**, which already
names `src/exports/<plane>.ts` as the plane-mapped entrypoint convention —
cross-link it. Record these decisions (all evidenced in learnings.md):

- **Public entrypoints live in `src/exports/`.** Only those files are the public
  surface; internal implementation stays at the `src/` root (or subdirs). tsdown
  `entry` lists only `src/exports/*` files.
- **The exports map is generated where safe.** `@internal/tsdown-config`'s base
  generates `package.json#exports` via a `customExports` hook (strips the
  `exports/` prefix; `enabled: 'local-only'`; `exclude: [/^bin$/]` keeps a `bin`
  entry non-importable). **Object entries with explicit names** fix the subpath
  key and the flat `dist/` filename, preserving the published surface.
- **Two deliberate exceptions keep hand-maintained maps:** (a) multi-pass
  packages (`cron`/`storage`/`streams`) — generation would clobber the map across
  passes; (b) the two published packages (`@prisma/composer`,
  `@prisma/composer-prisma-cloud`) — the published API contract, with a bin
  field / 9-pass build. Generation was PROVEN dts-safe (target's generated
  string-form is consumed by `composer-prisma-cloud`'s dts rollup), so the
  exceptions are deliberate, not forced.
- **Accepted characteristics** (document so they don't surprise): implementation
  MAY live in `src/exports/` and internal code MAY import from an `exports/`
  sibling (this is relocation-not-refactor; the purer `src/core/`-holds-impl form
  is a possible future refactor). Generated exports are string-form (TS resolves
  the adjacent `.d.mts`).
- **The dist invariant is ENTRY-filename stability, not byte-identical dist.**
  Moving a source file that backs a rolldown shared chunk rehashes that internal
  content-hashed chunk; that's fine — runtime `import.meta.url` resolves the
  byte-identical ENTRY, private packages never ship chunk names, and nothing
  pins them.
- **Plane mapping stays entrypoint-keyed (per ADR-0028) and globs must be
  NON-overlapping** — `dependency-cruiser.config.mjs` has no glob precedence (a
  file joins a plane group if ANY of its globs match), so there is deliberately
  NO `src/**` fallback. Plane globs are per-file. A `src/*.ts`-style collapse of
  root internals is NOT currently possible: `normalizeGlob` mis-normalizes
  wildcard-file globs (no `$` anchor + unescaped dots), so `src/*.ts` overlaps
  `src/exports/…`. State this as the reason per-file globs are used, and point at
  the follow-up (spawned task `task_b355e69d`) that fixes the normalizer and then
  enables the collapse.
- **Known follow-ups (record in the ADR):** (a) `storage`/`streams` (and cpc's
  storage/streams entries) are unmapped for plane enforcement (pre-existing);
  (b) the `normalizeGlob` wildcard-file bug + the glob-count reduction it would
  unblock. Both are deferred, orthogonal to the exports/entrypoint move.

Add the ADR-0033 one-line entry to `docs/design/90-decisions/README.md` (match
the existing list format).

## 2. The rule
Create `.agents/rules/exports-entrypoints.mdc` (canonical path; `.mdc`; follow
the frontmatter format of `.agents/rules/full-surface-rename.mdc` —
`description`, `globs`, `alwaysApply: false`). Terse, actionable. Cover:
- Only `src/exports/*` is the public surface; internals stay at `src/` root.
- tsdown `entry` lists only exports files, as OBJECT entries with explicit names
  (name = subpath: `index`→`.`, `control`→`./control`).
- Adding a subpath: add `src/exports/<name>.ts` → add the object entry → build →
  commit the regenerated `package.json#exports` (never hand-edit a generated
  map) → declare its plane in `architecture.config.json` with a NON-overlapping
  glob.
- Multi-pass packages + the two published packages keep `exports:false` +
  hand-maintained maps (say why: pass-clobber / published contract).
- The `/^bin$/` exclude keeps a `bin` entry non-importable.
- Moving a service file that backs a shared chunk rehashes an internal chunk —
  that's expected; the invariant is entry-filename + exports-map stability.
- Run `pnpm rules:sync` after adding the rule (regenerates the symlink trees).

## 3. Doc touch-ups
- **Fix the stale rule** `.agents/rules/tsdown-config-package-source-only.mdc`:
  it references `packages/tsdown-config` / `@prisma/composer-tsdown`; the real
  package is `packages/0-framework/0-foundation/tsdown-config` /
  `@internal/tsdown-config`. Update the path, the name, the glob, and the body.
- **ADR-0028 cross-reference:** add a pointer from ADR-0028 to ADR-0033 (the
  entrypoint/exports pattern is now fully realized). If ADR-0028's example still
  says `src/exports/runtime.ts`, note that this repo's execution-plane
  entrypoints exist per-package (don't rewrite ADR-0028's decision, just
  cross-link).
- **`.agents/rules/test-import-patterns.mdc`:** if any example path implies
  entrypoints live at `src/` root, add a one-line note that public entrypoints
  are now under `src/exports/` (within-package tests import `../exports/<name>.ts`
  for entrypoints, `../<name>.ts` for internals). Only if it actually needs it.

## 4. Final verification (whole slice)
Run the full suite at the branch tip and confirm green: `pnpm build && pnpm
typecheck && pnpm lint && pnpm lint:deps && pnpm test`. Also run `pnpm
rules:sync` and `pnpm lint:rules:symlinks` (the new rule must be synced). Report
the results.

## Scope
IN: ADR-0033 + its README entry; `exports-entrypoints.mdc` + rules:sync; the
three doc touch-ups; final verification. OUT: any source/config move; the
`./report` upstream reconciliation and rebase (that's PR-open, orchestrator-
handled); adding globs for the unmapped packages.

## Completed when (binary)
- [ ] ADR-0033 exists, indexed in the README, cross-linked with ADR-0028.
- [ ] `exports-entrypoints.mdc` exists at the canonical path; `pnpm rules:sync`
      run; `pnpm lint:rules:symlinks` green.
- [ ] The tsdown-config-source-only rule's stale path/name fixed; ADR-0028
      cross-link added; test-import-patterns touched if needed.
- [ ] Full suite green at the tip: `pnpm build && typecheck && lint &&
      lint:deps && test`.
- [ ] Commit(s): bot identity + both sign-offs, explicit staging. (ADR + rule +
      touch-ups can be one `docs(adr-0033): …` commit, or split docs vs rule —
      your call, keep each coherent.)

## Heartbeat
`wip/heartbeats/implementer.txt`: `<ISO-ts> | D7 | <phase> | <status>`.

## Return shape
The ADR path + title; the rule path; the doc touch-ups made; `rules:sync` +
`lint:rules:symlinks` result; the full-suite results; the commit SHA(s). Flag any
jargon you had to avoid or any decision in learnings.md you were unsure how to
phrase.
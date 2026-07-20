# S2 — Per-branch state bootstrap + destroy ordering

Implements [design-notes.md](../../design-notes.md) § The design, exhaustively.
The design doc is binding: where it specifies an algorithm step, message
string, failure semantic, or "unchanged" surface, the implementation follows
it without reinterpretation. Deviations discovered necessary during execution
go back through discussion mode, not into the diff. Requires S1 merged
(ADR-0034 exists).

## At a glance

One PR across two packages:

- `packages/1-prisma-cloud/0-lowering/lowering/src/state/bootstrap.ts` —
  replace workspace-project discovery with branch-scoped database
  find-or-create (design-notes § Bootstrap, steps 1–6, including exact error
  and log messages and the SDK-types fallback rule).
- `.../state/layer.ts` — `prismaState()` reads `PRISMA_PROJECT_ID`
  (required) + `PRISMA_BRANCH_ID` (optional); `workspaceId` option deleted;
  bootstrap-error step strings updated.
- New `deleteStateDatabase({ projectId, branchId? })` exported from lowering
  (design-notes § Destroy ordering, steps 1–4; ownership verification before
  deletion is mandatory).
- `packages/0-framework/3-tooling/cli/src/main.ts` — destroy tail gains the
  state-delete step with the asymmetric failure semantics (stage: throw
  `CliError`; production: warn-and-continue).
- `schema.ts`, `lock.ts`, `service.ts`, `errors.ts`, `transient.ts`,
  resource lowering, `ensure-containers` deploy path: **unchanged** (the
  review should verify the absence of changes here as much as the presence
  elsewhere).

## Coherence rationale

One reviewer, one sitting: the diff is one algorithm swap plus one new
operation plus two-line-order changes in the CLI, all specified in a single
design section, with the test rework tracking the same seams. Rollback is one
revert (no schema or state migration involved — the store format is
unchanged).

## Scope

**In:** the code above; test rework (below); `pnpm run deploy`-based live
verification of the DoD scenarios that don't need PDP answers.
**Deliberately out:** docs (S1); migration tooling (manual cutover is
documented); any lowering/provider change; anything in § Successor project.

## Pre-investigated edge cases

(From the design discussion — knowledge the implementer's grep would not
surface.)

- ~~The e2e noop assertion greps deploy output for bare create/update verbs.~~
  **False — it no longer exists** (deleted with the `makerkit-hello` example;
  nothing in `.github/`, `scripts/`, `test/`, or `examples/` greps for this).
  Follow design-notes' log phrasings anyway, because they read well and match
  the surrounding code — but do not repeat the claim that a check enforces it.
- PDP allows duplicate names; a user database named `prisma-composer-state`
  on the same branch must be skipped on adopt and left alone on delete
  (squatter verdict), never adopted by name, never deleted by name.
- A freshly provisioned database can refuse connections for minutes — the
  existing 2-minute migrate retry schedule must survive the rework untouched.
- `region: 'inherit'` and body `branchId` may be missing from the generated
  SDK types even though the API supports them — fallback is create-then-PATCH
  (mirroring `postgres/Database.ts`); a stale region union means updating the
  SDK dependency, never hard-coding a region literal.
- Destroy retry semantics: every crash window between alchemy exit 0 and
  container deletion must converge on re-run (design-notes documents each
  window; the tests assert the two interesting ones).

## Slice-specific done conditions

- `bootstrap.test.ts` reworked to the new discovery (branch resolution,
  candidate verdicts, squatter failure, default-branch-missing failure), and
  `main`/`ensure-containers` tests cover the destroy tail ordering + both
  failure semantics and idempotent re-run.
- Live round-trip per Project-DoD items 2–4 (named-stage zero-residue,
  production state on default branch, Console-delete-then-redeploy) executed
  against the dogfood workspace and evidence recorded in the PR. The
  production `deleteAppProject` leg may be waived pending OQ-2 with an
  explicit note.
- `git grep STATE_PROJECT_NAME` returns nothing.

## Dispatch plan

Sequential; implementer subagents on Sonnet-4.6-mid, reviewer on Opus-4.8-mid
(operator's standing rule).

1. **D1 — bootstrap rework in lowering.** Outcome: `bootstrapStateConnection`
   takes `{ projectId, branchId? }` and implements design-notes § Bootstrap
   steps 1–6; `prismaState()` env contract changed; `STATE_PROJECT_NAME`
   machinery deleted; `bootstrap.test.ts` reworked and green. Builds on: S1's
   merged ADR. Hands to: a lowering package whose deploy path is fully
   per-branch, destroy path not yet wired. Completed when: package tests
   green; `git grep STATE_PROJECT_NAME` empty; no changes outside
   `state/`.
2. **D2 — `deleteStateDatabase` + CLI destroy tail.** Outcome: the new
   operation (design-notes § Destroy ordering steps 1–4) exported from
   lowering; `main.ts` destroy tail ordered stage/production with asymmetric
   failure semantics; CLI tests cover ordering, both failure modes, and
   no-op-on-retry. Builds on: D1's bootstrap-shaped discovery (shared
   resolution helpers). Hands to: feature-complete code. Completed when: CLI +
   lowering tests green; the only `main.ts` diff is the destroy tail.
3. **D3 — live verification + review evidence.** Outcome: the three live DoD
   scenarios executed against the dogfood workspace (credentials per
   memory: copy `makerkit/.env`, `pnpm run deploy`), transcripts/evidence in
   the PR body; full-repo checks green. Builds on: D2. Hands to: PR open.
   Completed when: evidence for each scenario is recorded, or a scenario is
   explicitly waived with the OQ-2 note.

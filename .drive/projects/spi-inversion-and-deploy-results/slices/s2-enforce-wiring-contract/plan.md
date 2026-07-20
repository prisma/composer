# S2 — Dispatch plan

## D1 — Failing tests

**Outcome:** the four Slice-DoD cases exist in `lowering.test.ts`; cases
1 fails (no guard yet), 2–4 pass (pinning the exemptions before the guard
lands).
**Builds on:** S1 merged.
**Hands to:** D2 — an executable contract for the guard.
**Completed when:** test run shows exactly case 1 red.

## D2 — Implement the guard

**Outcome:** the spec's guard clause + proxy-fact comment in `buildConfig`;
all four cases green; dogfood/example lowering tests still green (any
newly-exposed under-delivery fixed as its own commit, named in the PR body).
**Builds on:** D1.
**Hands to:** D3 — a live guard whose user-visible consequence needs writing
down.
**Completed when:** full CI green. **DONE** (`ded15f4`, `49240bd`) — no
existing pair under-delivers; reach proven by mutating the real postgres
descriptor (3 e2e tests red, restored).

## D3 — Document the new failure mode (F3)

**Outcome:** `docs/guides/**` and `skills/prisma-composer/SKILL.md` both
explain the new deploy-time failure — added because
`.agents/rules/user-facing-surface-changes.mdc` (`alwaysApply: true`)
requires it and no slice owned the debt.
**Builds on:** D2 (documents behaviour that now exists).
**Hands to:** S3 — the branch's docs obligation for S2 is closed, so S3's
own surface changes are the only remaining debt.
**Completed when:** both surfaces updated; guides and skill do not disagree;
`website` content tests green; the guide explains the *consequence* (a
previously-green deploy now fails, and what to do) rather than the
mechanism.

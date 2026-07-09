# Slice R9 — core correctness cleanups

## At a glance

Five reviewed, settled findings closed in one PR: the graph becomes genuinely
topo-ordered (the doc's claim becomes true by construction); config-key
collisions become unrepresentable; the platform routes to whatever port the
app binds; the state store's lease check stops doubling round-trips; dead
`ALCHEMY_PASSWORD` plumbing goes away.

## Chosen design

All five are recorded findings with settled fixes — no design pass needed.

1. **Graph topological sort at Load** (R5 review follow-up). `Graph.nodes`
   claims "topo-ordered (deps first)" but preserves provision order;
   `lowering()` walks array order and `buildConfig` reads producer outputs
   positionally (`lowered.get(edge.from) ?? {}` silently yields undefined
   params for a consumer walked first). Reachable today only via forged refs;
   becomes legitimate with boundary ports/nesting. Fix: real topological sort
   over the edges at Load (deps first; stable order within ties so existing
   graphs keep their layout); the doc claim stays, now true.
2. **Config-key separator collision** (R5 review follow-up). `configKey` joins
   `address ▸ owner ▸ name` with `_` and uppercases, so service param
   `db_url` and input `db` param `url` both yield `AUTH_DB_URL`. Fix: forbid
   `_` in param and input names at construction (core factories), with a
   clear error naming the offender. No existing name uses `_`.
3. **`port` param ↔ listen port decoupling** (R5 review follow-up). The pack's
   `Deployment` hardcodes `port: 3000` while the service's `port` param
   (default 3000) is what the app binds — set the param to anything else and
   the platform routes to a port nobody listens on, silently. Fix: thread the
   service's resolved `port` value into the `Deployment` (mechanism is the
   implementer's: config already flows to `serialize`; `deploy` needs the
   value — smallest honest seam wins; amend core-model.md if the SPI shape
   changes — doc covenant).
4. **Interval-based lease check** (R8 review F05). `guardStateService` runs a
   `pg_locks` round-trip before every state operation, roughly doubling
   store traffic. Fix: amortize `checkLive` with a short TTL (a passed check
   is trusted for a few seconds; a failed check still fails immediately and
   is never cached). Semantics unchanged: reads stay gated, TOCTOU residual
   stays accepted and documented; only the per-op cost drops.
5. **`ALCHEMY_PASSWORD` dead plumbing** (R8 finding). Nothing in
   alchemy@2.0.0-beta.59 reads it (verified against source). Remove its
   generation from `scripts/setup-env.ts`, the e2e workflow step, and
   `.env.example`/docs mentions; leave user `.env` files alone.

Also rides along (bookkeeping): flip plan.md's R8 entry to merged (PR #17,
`b86f093`) and mark these follow-ups closed where plan.md lists them.

## Coherence rationale

One PR of independent, small correctness fixes, each with its own test; a
reviewer holds them one at a time. Rollback is per-commit or whole-PR.

## Scope

**In:** `packages/makerkit-core` (graph sort + name validation + tests),
`packages/makerkit-prisma-cloud` (port threading, configKey guard if any part
lives there, tests), `packages/prisma-alchemy/src/state` (lease-check TTL +
tests), `scripts/setup-env.ts`, `.github/workflows/e2e-deploy.yml` (password
step only), docs touched by the doc covenant, plan.md bookkeeping.

**Out:** everything else — no authoring-surface changes, no example
restructuring, no new capabilities.

## Pre-investigated edge cases

| Edge | Known |
| --- | --- |
| Topo sort stability | Existing examples provision producer-first; sort must not reorder already-valid graphs (stable sort, ties keep provision order) or the address-derived config keys/artifacts would churn. |
| Forged-ref forward wiring | Now legal ordering-wise after the sort; the unknown-producer LoadError and DAG check still apply unchanged. |
| Port threading | `deploy()` currently doesn't receive the Config; `serialize` does. Whatever seam is chosen must keep the SPI target-neutral and the doc in sync. |
| Lease TTL | A *failed* check must never be cached; TTL applies to successes only. Two stores in one process (different stacks) must not share a cache entry. |
| ALCHEMY_PASSWORD | CI e2e generates it per-run ("nothing to decrypt") — deleting the step must not break alchemy CLI invocations that might *require* the var to exist; verify by running a deploy without it locally before removing. |

## Slice DoD

All five fixes tested (the sort has a consumer-authored-first test proving
`buildConfig` sees real producer outputs); a real deploy still works after the
password removal (local `makerkit deploy`/`destroy` of hello against the real
workspace); gates green; Opus review; PR.

## References

plan.md "R5 review follow-ups" + R8 D5 block (F05); code-review.md F05 in
`wip/review-code/pr-17/` (local); alchemy source for the password claim.

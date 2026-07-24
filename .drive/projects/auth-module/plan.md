# Auth module — project plan

## Summary

Four slices deliver the auth module per `spec.md`. S1 lands the module,
pack, target support, and a deployed smoke example with password auth. S2
wires the email module (blocked on #146 merging). S3 proves the shared-DB
FK golden path on the real consumer example. S4 ships the embedded mode.

**Spec:** `.drive/projects/auth-module/spec.md`

Linear: project "Composer auth module" (Terminal) — S1 [TML-3076], S2
[TML-3077], S3 [TML-3078], S4 [TML-3079].

## Slices

### S1 — `auth-module-core` (TML-3076)

**Outcome:** `@internal/auth` exists and deploys. Email+password signup,
login, logout, sessions, JWTs with JWKS verification, `session` + `admin`
ports, proxy helper, local testing export. `examples/auth` (dedicated DB via
an empty-app-space PN project) deploys to real Prisma Cloud and its smoke
script passes.

**Contents (spec sections):** Package layout · Contracts · Pack (contract,
0001_init, schema.sql, descriptor) · Target changes (all four: `authSecret`
resource, `pnPackRequirement` + satisfies branch, pack preflight,
multi-space migrate passthrough) · Module factory (no `email` dep yet) ·
Service · auth-options (S1 no-op senders, `requireEmailVerification:
false`) · Entrypoint · Store · Proxy · Testing export · `examples/auth` ·
Test plan minus email/S2 and storefront/S3 items · public package
re-exports.

**Coordination check before start:** spec Open question 1 — the
"BetterAuth Extension" Linear project may supply the pack + DB adapter;
the § Pack portion of this slice is on hold until that call is made.

**Builds on:** nothing. **Hands to:** S2/S3/S4 a published module shape
(factory, ports, pack) they extend without changing existing surfaces
(exception: S2 adds the `email` boundary dep — the one sanctioned
shape change, pinned in the spec).

### S2 — `auth-email-flows`

**Unblocked 2026-07-22:** #146 merged to main; branch rebased onto it.
Merged surface verified against the spec's assumptions — one amendment:
`TemplateDef.render` may now be async (react-email support). Auth's
templates stay plain sync functions as pinned (avoids the `.tsx`
precompile deploy caveat); react-email remains an option consumers can
use for their own templates, not ours.

**Outcome:** Verification, password reset, and magic-link emails deliver
through the email module. `requireEmailVerification: true`. Magic-link
login passes e2e locally (link read back from the email module's outbox
port) and deployed. First module-depends-on-module proof.

**Contents:** `templates.ts` + `safeLink`/escaping · real send callbacks +
deterministic idempotency keys · `email` boundary dep on factory + service ·
embedded input gains `email` · `examples/auth` gains the email module
wiring · S2 test-plan items.

**Builds on:** S1. **Hands to:** S3 the complete zero-click auth loop.

### S3 — `auth-consumer-fk`

**Outcome:** `examples/storefront-auth` reworked into the real consumer:
shared database, `Profile.userId → auth:User` FK, signup → verification →
login → magic link → cross-service JWT hop → logout, e2e locally and
deployed. Proves DoD 3 and 4 and the deploy-time pack preflight against a
real multi-space migration.

**Contents:** spec § Examples/storefront-auth · README golden-path wiring
section (written against the working example) · S3 test-plan items.

**Builds on:** S2.

### S4 — `auth-embedded`

**Outcome:** `./embedded` export ships with service-parity integration
tests; README embedded + SPA-alternative sections complete.

**Contents:** spec § Embedded export · parity tests · README remainder.

**Builds on:** S1 (S2's `email` input lands in whichever of S2/S4 merges
second — coordinate at pickup). **Parallel with:** S2, S3.

### ~~S5~~ → branched out: the `wired-egress` project

Will's call (2026-07-23): this outgrew the auth project. Design record
lives at `.drive/projects/wired-egress/` on branch
`claude/wired-egress-project` (spec, design notes, origin/cross-refs).
The superseded local draft remains at `slices/rpc-port-isolation/spec.md`
for history. Open dependency: the S3 sequencing decision (ship the
consumer example on flat dispatch vs wait for wired-egress slice 1) is
taken at S3 pickup, with the platform team's multi-port answer in hand.

## Sequencing

- Stack: S1 → S2 → S3.
- Parallel: S4 alongside S2/S3 once S1 merges.
- S1 starts immediately; nothing in it waits on #146.

## ADR-0041 adoption (decided 2026-07-24, Will)

PR #161 (ADR-0041) replaces a service's `params`/`secrets` maps and
`config()`/`secrets()` accessors with one Standard-Schema `input` and a
single `service.input()`; sourcing (`envParam`/`envSecret`) moves onto the
`provision(..., { input })` binding; a credential is a field typed
`secretString()`; port comes from `process.env.PORT`. The auth module was
built on the old model, and the rework added `mintedSecret()` as a source
inside it. Auth must migrate.

Two operator decisions:

1. **Migrate now, on #161's branch** — rebase S1 (`s1-rework`) onto
   `bot/claude/adr-input-schema`, do the input-model migration, then
   re-stack S2. Ready the moment #161 merges; re-verify against main then.
2. **Auth carries the minted-secret binding leaf.** `mintedSecret()`
   becomes a third binding-leaf marker (parallel to `envSecret`) that
   #161's new `input-serializer.ts` walk recognizes and turns into a minted
   platform secret + `$secret` pointer. Auth's PRs add that recognition to
   the new serializer — accepting that auth now edits #161's new file
   (merge coupling with #161 until it merges).

## Open items (recorded during S2, 2026-07-23)

- **Upstream PN change: contract must sign extension HEAD HASHES, not just
  versions (decided 2026-07-24, Will).** The correct pack-compatibility
  check reads the wired database's emitted app contract — its signed
  `extensionPacks` section — and asks "is my required head hash present?"
  Today that section carries only `{ kind, id, familyId, targetId, version }`
  (`ExtensionPackRef` → `PackRefBase`, no hash field), so the check isn't
  expressible and compose's current preflight compares a descriptor against
  itself (inert). Fix, at `~/Projects/prisma/prisma-next`: contract emit
  records each extension's `contractSpace.headRef.hash` in the
  `ExtensionPackRef` written into the composed contract. THEN compose's
  preflight becomes a trivial hash-presence check against the wired
  resource's contract. For PR #163 now: delete the inert head-comparison
  branch of `runPackPreflight` (keep the "pack not listed" branch); PN's own
  migrate/verify still catches real stale-head drift until the proper check
  lands. This supersedes the earlier "compare against on-disk refs/head.json"
  idea.


- **Latent break on a Prisma Next `0.16` bump: the config field flips.**
  Compose pins `@prisma-next/config-loader@0.15.0`, whose validated field
  is `extensionPacks` — which is what `pn-config.ts` reads. PN `0.16.0`
  renames it to `extensions` and rejects `extensionPacks`. The example
  config already writes `extensions: [authPack]`, which works today only
  because the pinned `0.15.0` `postgres/defineConfig` wrapper maps
  user-facing `extensions:` → validated `extensionPacks`. On a bump to
  `0.16`, `config.extensionPacks` becomes `undefined → []`, silently
  emptying both the deploy preflight's pack lookup AND the migration
  resource's `packHeadRefHashes` diff key (a pack upgrade would stop
  producing a distinct deploy step). Read `config.extensions ?? config.extensionPacks`,
  or track the rename, before bumping. Verified against installed 0.15.0
  vs the 0.16.0 source checkout.

- **Pre-commit hooks never fire in most linked worktrees (repo-wide,
  needs an operator decision).** The shared config sets a RELATIVE
  `core.hooksPath = .husky/_`, which is what husky writes and works
  per-checkout. But 8 of the 16 linked worktrees carry an ABSOLUTE
  `core.hooksPath` in their `config.worktree`, pinned to the main
  checkout — and `<main>/.husky/_` does not exist, so git finds no hook
  and runs nothing. Verified empirically with a discarded empty commit.
  Nobody bypassed anything; the checks were simply not wired. A single
  `pnpm install` in the main checkout regenerates `<main>/.husky/_` and
  restores pre-commit for all eight. Something in the worktree-creation
  path writes that absolute override — husky would not. Worth fixing at
  the source, not just regenerating.
- **Two accounts of the published testing bundle disagree — resolve
  before close-out.** The rework review recorded `externalizeEmailToSelf`
  as applying to `dist/auth/testing.mjs`; the rebase implementer reports
  that pass re-emits from an already-bundled artifact, so no
  `@internal/email` specifier survives to rewrite and the testing bundle
  carries its own copy of the email code. Both agree the behavior is
  correct today (the identity check that matters happens through
  `dist/auth/index.mjs`, which does externalize), so this is a question
  of which description is accurate, not a defect. Settle it by reading
  the built output before the claim is migrated into durable docs.
- **`composeServiceFetch`'s public prefix matches as a plain string.** A
  prefix that would swallow `/rpc/` now throws at composition time, but
  `/api/auth` still also matches `/api/authorize` — over-matching rather
  than shadowing. Fix is to match on a segment boundary. Deliberately left
  out of the un-publish change (review finding F17, second half).
- **Secret-slot key collisions after normalization (framework,
  follow-up).** A service with sibling secret slots named `x` and
  `x_MINTED` generates the same platform var name and Alchemy resource
  id; separately `configKey` uppercases, so `foo` and `FOO` already
  collide today. Unreachable from shipped code. Fix is one assertion that
  a service's secret-slot keys stay distinct after normalization,
  covering both classes — not a minted-specific guard.
- **Both deployed smokes are stale.** Neither `examples/auth`'s S1 smoke
  nor the S2 email smoke has run since the rework, which changed the
  secret's resource identity. Re-run both before either PR merges.

- **envParam value changes never reach running services (framework gap).**
  The Deployment lowering claims a new deployment "when any upstream value
  changes", but `EnvironmentVariable` attributes carry only `{id, key}` —
  the value never enters the diff, so changing an env param and redeploying
  is a no-op. Surfaced by the S2 deployed smoke (`AUTH_BASE_URL`). Fix needs
  a design decision (fold a value hash into deployment props, or derive
  `baseUrl` from the api service's own origin like `COMPOSER_*_ORIGIN`).
  Not an auth-project change — route to a framework ticket/design pass.
- **`AUTH_BASE_URL` chicken-and-egg on first deploy.** The platform assigns
  the api domain at first deploy, so the deployed smoke needs two passes
  (deploy with placeholder → read real URL → update var → roll the auth
  service). If S3 keeps this shape, script it as an explicit example step.
  Decide at S3 pickup.

## Close-out (required)

- [ ] Verify every Project-DoD item in `spec.md`.
- [ ] Migrate long-lived docs: spec's design content → module README +
      `docs/` (ADR if the pack-requirement/preflight mechanism deserves
      one — decide at close-out); design-notes learnings → gotchas.md
      where operational.
- [ ] Admin-path feedback (design-notes last section) handed to the
      admin-conventions design pass.
- [ ] Strip repo-wide references to `.drive/projects/auth-module/**`.
- [ ] Delete `.drive/projects/auth-module/`.

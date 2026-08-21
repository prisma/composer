# One-Click GitHub Deploys — Project Plan

## Summary

Three slices. S1 is pure Composer-side and starts immediately; S2 is the
pdp-control-plane install flow — buildable now (the App-permission question
resolved 2026-07-20), with rollout pending the product-team positioning
conversation; S3 is Console surface, scoped with them. The OIDC follow-up
(TML-3056) is in-tracker but explicitly post-v1.

**Spec:** [spec.md](spec.md) · **Design notes:** [design-notes.md](design-notes.md)

## Tracker

[Prisma Composer: One-Click GitHub Deploys](https://linear.app/prisma-company/project/prisma-composer-one-click-github-deploys-29acf2ee21e9).
Linear issues per slice at slice start, per repo convention. TML-3056 (OIDC)
already filed under this project.

## External dependencies

- ~~App permission strategy~~ — **resolved 2026-07-20** (App author): extend
  the existing App; email-based acceptance, graceful degradation, no forced
  reinstall. S2 gains a requirement: detect the installation's grant and
  refuse Composer setup until accepted.
- **Product team (Will, scheduled):** positioning (Composer flavor is
  opt-in/detected, not the default for new projects) and S3's Console scope.
  Neither blocks S2's build; both block S2's *rollout*.
- **S2 grounding task:** find pdp's existing open-a-config-PR flow and build
  on it (per the App author, one exists).
- **None for S1.**

## Slices

### S1 — Reusable deploy Action + workflow template

A published composite GitHub Action (checkout/setup assumed done by the
caller; runs build command + `prisma-composer deploy`/`destroy` with stage
derivation from the event) and the canonical workflow template the setup PR
will later inject: push → deploy `--stage`, PR-close + branch-delete →
`destroy --stage`, default branch → production, per-ref `concurrency`.
Documented in `deploying.md` as the recommended CI setup (supersedes the
hand-rolled snippet). Dogfood: datahub switches to it.

- **Builds on:** nothing. **Hands to:** S2 (the template it injects) and
  users immediately (the manual product).

### S2 — Install-time flavor in pdp-control-plane

At link time, Composer detection routes to: check the installation's
permission grant (refuse with "accept the updated permissions" if stale) →
mint service token → write Actions secret + variable → open the setup PR
with S1's template, entry/build prefilled from the repo. Built on pdp's
existing config-PR flow (locate it first). No runner/build-runner changes.
Rollout (not build) waits on the product-team positioning conversation.

- **Builds on:** S1's template; pdp's existing config-PR plumbing.
- **Hands to:** the one-click experience end to end.

### S3 — Console surface

Connected-repo state for Composer repos + link to workflow runs; anything
richer is scoped with the product team. Firmed after S2.

Sequencing: S1 now; S2 when unblocked; S3 last. S1 ∥ product-team
conversation.

## Follow-up (filed, post-v1)

- **TML-3056 — OIDC token exchange**: deletes the stored secret; needs the
  PDP token-exchange endpoint; the Action grows an OIDC mode.

## Close-out (required)

- [ ] Verify acceptance criteria in [spec.md](spec.md) § Project-DoD
- [ ] Migrate long-lived docs into `docs/` (deploying-guide rewrite lands
      with S1; any ADR this project turns out to need ships with its slice)
- [ ] Also delete the retired `.drive/projects/state-under-branch/`
      workspace if the decouple-CLI project hasn't already (its GH-app seed
      notes are superseded by this project)
- [ ] Strip repo-wide references to `.drive/projects/one-click-github-deploys/**`
- [ ] Delete `.drive/projects/one-click-github-deploys/`

# Purpose

Give a Composer user the Vercel-grade first experience — connect a GitHub
repo, merge one PR, and every push deploys with per-PR preview environments —
**without the platform ever executing user code**. The App's job narrows to
the two things a user should not do by hand: provisioning the deploy
credential, and wiring the preview-branch lifecycle into their CI.

# At a glance

Deploys run in the user's own GitHub Actions — the exact flow
`docs/guides/deploying.md` already documents for CI. The GitHub App makes it
one click: at install it links the repo to a Project (existing machinery),
mints a service token and writes it to the repo's Actions secrets, and opens a
**setup PR** adding a workflow that builds and runs
`prisma-composer deploy --stage <branch>` on push, `destroy --stage` on
PR-close/branch-delete, and production deploys from the default branch. The
merged workflow file is the explicit build declaration — a human reviewed the
prefilled entry path and build command, so nothing is guessed at deploy time
(ADR-0005 satisfied by construction).

Tracker: [Prisma Composer: One-Click GitHub Deploys](https://linear.app/prisma-company/project/prisma-composer-one-click-github-deploys-29acf2ee21e9).
Design record: [design-notes.md](design-notes.md).

# Non-goals

- **Platform-run builds for Composer repos.** The sandbox-as-CI plan (E2B
  runs the user's build; per-build scoped tokens) is superseded, not queued.
  It returns only if zero-config-without-CI becomes a product requirement.
- **Any change to the existing `prisma.compute.ts` experience.** The product
  team's zero-config flow keeps working untouched; the install flavor forks on
  Composer detection at link time.
- **OIDC token exchange** — slated as the follow-up that deletes the stored
  secret ([TML-3056](https://linear.app/prisma-company/issue/TML-3056/oidc-token-exchange-for-github-actions-deploys)),
  not part of v1.
- **Non-GitHub CI providers.**
- **Console build-log ingestion.** Build logs live in GitHub for v1; Console
  links out to workflow runs (S3 scopes what more, with the product team).

# Cross-cutting requirements

- **No guessing:** the setup PR's prefilled entry/build command are
  suggestions reviewed by a human before merge; the platform never infers
  them at deploy time.
- **The credential story must not regress the documented manual flow:** v1's
  stored workspace token is exactly what `deploying.md` tells users to set as
  CI secrets today. Anything weaker is rejected.
- **Teardown correctness rests on ADR-0034** (state in the stage's Branch) —
  the workflow's `destroy --stage` walks state (covers non-platform
  resources); platform-side branch teardown is the backstop.
- **Cross-repo work:** S1 in `prisma/composer`, S2 in
  `prisma/pdp-control-plane` (their review conventions apply there).

# Project-DoD

- [ ] A fresh Composer repo goes from App-install to a deployed production
      app plus a working per-PR preview (deploy on push, destroy on close)
      with the user's only manual step being reviewing/merging the setup PR.
- [ ] The credential never appears in chat, logs, or the workflow file — only
      in Actions secrets, written by the control plane.
- [ ] datahub dogfoods the S1 Action/template in place of hand-written CI.
- [ ] The existing compute-App flow demonstrably unaffected (their e2e or a
      manual link of a `prisma.compute.ts` repo behaves as before).
- [ ] An installation that has **not** accepted the new permissions gets a
      clear "accept the updated permissions" refusal when linking a Composer
      repo — never a half-configured link — and its Compute repos work
      unaffected.
- [ ] Product-team decisions recorded: positioning of the Composer flavor
      (opt-in vs default) and Console surface scope.

# Open questions

- ~~App strategy~~ — **resolved** (App author, 2026-07-20): extend the
  existing App; permission additions email existing installs and degrade
  gracefully, no forced reinstall. S2 detects missing grants and refuses
  Composer setup with an actionable message (see design-notes § 2).
- **Product team (Will, scheduled):** positioning only — Composer is *not*
  the default install flavor for new projects yet (confidence call);
  detection-triggered opt-in until that changes. Plus S3's Console scope.
- **S2 grounding:** locate pdp's existing open-a-config-PR flow (the App
  author says one exists) and reuse it; verify exact permission names
  against the manifest and GitHub's docs — not from memory.

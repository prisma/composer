# GitHub App: a second install flavor for Prisma Composer repos — what's settled, and the two calls that are yours

Context in three sentences: Prisma Composer is the TypeScript framework that
deploys multi-service apps onto Prisma Cloud; its contract is "the user
builds, the framework assembles," so unlike the Compute flow the platform
never runs a Composer user's build. We want Composer repos to get the same
one-click onboarding your GitHub App gives Compute repos — connect a repo,
get deploys and per-PR previews — but with the build and deploy running in
the **user's own GitHub Actions**, not in the build-runner/E2B pipeline.
Your existing `prisma.compute.ts` experience is untouched: at repo-link time
we detect a Composer repo and route to a different flavor; everything else
keeps working exactly as today.

What the Composer flavor does at install/link time (one-time, control-plane
side — **no build-runner or sandbox changes at all**):

1. Link the repo to its Project — your existing machinery
   (`linkProjectToScmRepo`, `ScmInstallation`, `ProjectScmRepo`), unchanged.
2. Mint a service token and write it into the repo's **Actions secrets**
   (plus the workspace id as an Actions variable), so the user never handles
   a credential.
3. Open a **setup PR** adding a workflow file (from a template we ship):
   build + `prisma-composer deploy --stage <branch>` on push,
   `destroy --stage` on PR-close/branch-delete, production deploys from the
   default branch. The user reviews the prefilled build command and entry
   path and merges — that merge is their explicit sign-off.

From then on GitHub Actions does the work; webhook traffic for Composer repos
needs nothing from the runner. (Longer-term we want to replace the stored
secret with GitHub OIDC token exchange — tracked separately as TML-3056 —
which would also interest the Compute flow.)

## Permissions — settled with the App's author, for your awareness

We discussed the mechanics with the App's author (2026-07-20): adding
permissions to the existing App does **not** force reinstallation — existing
installations get an email asking them to accept, and until they do the App
simply keeps its old grant and keeps working. So the plan is:

- **Extend the existing App** (no second App). New installations grant the
  full set up front.
- **Existing installations that haven't accepted yet degrade gracefully:**
  their Compute repos work exactly as before, and linking a *Composer* repo
  refuses with a clear "accept the updated permissions" prompt until they do.
  No half-configured state, ever.

He also flagged that pdp already has a flow that opens a config-setup PR on
the user's repo — our setup PR builds on that rather than inventing new
plumbing — and that if Composer ever became the primary path, retiring the
E2B build system would shed real maintenance burden for his team.

## Decision 1 — Positioning: where does the Composer flavor sit?

Our assumption, per Will: **Composer does not replace the existing flow as
the default for new projects yet** — confidence isn't there. The Composer
flavor triggers only when a linked repo is detected as a Composer app;
everything else gets your existing experience unchanged. What we'd like from
you: confirm that framing, and tell us how you want it presented in Console
(if at all) while it's in this opt-in state.

## Decision 2 — Console surface for CI-deployed repos

Composer builds won't appear in the build-runner's Build history — the build
ran in GitHub. Resources, branches, and deploy state all show in Console as
normal. Our proposed floor: the repo shows as connected, with a link out to
the repo's workflow runs. If you want more (e.g. surfacing workflow-run
status via the checks API), we'd scope that with you as its own slice.

## What we're doing meanwhile (not blocked on you)

The reusable GitHub Action and the workflow template ship first as a
documented, manual setup — the same flow our deploying guide already
describes, minus the automation. Your decisions gate only the one-click
automation (the secrets write + setup PR).

Tracker: <https://linear.app/prisma-company/project/prisma-composer-one-click-github-deploys-29acf2ee21e9>

— Will

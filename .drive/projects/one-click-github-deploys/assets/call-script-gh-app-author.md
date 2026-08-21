# Call script — GH App / mgmt-api author

## Context: the flow you built

Today the App is the whole deploy pipeline. A user installs from Console,
links a repo to a Project, and `triggerInitialDeployment` fires immediately —
before any push. From then on: push → webhook → build-runner → an E2B
sandbox clones the repo, **the platform builds the app** (`prisma.compute.ts`
/ compute-sdk), uploads the artifact, and the host finalizes through Foundry.
Env comes from the DB, not the repo. The user never writes CI and never
touches a credential — that zero-config experience is the product, and
nothing in this conversation changes it.

## Why Composer can't ride that pipeline

Composer's contract is the opposite of Compute's: **the user builds, the
framework assembles** — the framework never runs or infers the user's build.
And the deploy CLI isn't a packaging step; it *is* the provisioner — it
creates databases, services, versions, env vars against the Management API.
Running it inside the sandbox would mean putting a Management API credential
into an environment executing arbitrary repo code (any `postinstall` in any
PR), and the only credential type that exists is workspace-scoped and
long-lived. We spent a while on scoped-token / proxy designs; they're all
real platform machinery with long lead times, for a user base that — unlike
Compute's — already has CI by definition.

## What we assume Product will prioritize (correct us on the call)

1. The existing zero-config onboarding stays exactly as it is — no
   disruption, no risk to the install base.
2. One install story: a user clicks "Connect GitHub" in Console and the
   right thing happens, whichever kind of repo it is.
3. Console stays coherent — a connected repo shouldn't look broken just
   because its builds happen elsewhere.
4. No new operational surface for their team without a reason.

## How our design fits those priorities

Composer repos become a **second flavor behind the same install button**,
decided at link time. For those repos the App does install-time work only:

- mint a service token and write it into the repo's **Actions secrets** (the
  user never handles a credential — priority 1's experience, kept);
- open a **setup PR** adding a workflow that builds and runs
  `prisma-composer deploy` — per-PR previews, production from the default
  branch, destroy on PR close. The user reviews and merges; that's the one
  manual step, and it's also their explicit sign-off on the build command.

After that, GitHub Actions does everything. **No build-runner, sandbox,
dispatch, or Foundry involvement for Composer repos — the runner never even
hears about them.** Compute repos: zero change. The one visible difference:
build logs live in GitHub, not Console (resources, branches, and state still
show normally).

Later (filed, not part of v1): replace the stored secret with GitHub OIDC
exchange — the workflow trades GitHub's identity token for a short-lived,
project-scoped credential. Relevant to them because mgmt-api would own the
exchange endpoint.

## What we need from this call

**1. The App decision (blocks our S2).** Writing Actions secrets and opening
PRs takes permissions we believe the App doesn't hold (we'll verify exact
names against the manifest). Adding permissions to an existing App makes
every installation re-approve. So: extend the App and eat the re-approval
wave, or register a second "Prisma Composer" App? They own the install base
and the brand — their call. Useful follow-ons: have they shipped a
permission change before and what fraction re-approved; org-policy landmines
(orgs blocking App-authored PRs or secrets writes); if second App, who owns
registration and Console routing.

**2. The link-flow seams (shapes our S2; decides who builds it).** Walk
`linkProjectToScmRepo` together:

- Where does the flavor fork — an extension point, or do we change the
  interactor? Do they build it or review our PR?
- Detection: is "repo root has `prisma-composer.config.ts` at default-branch
  HEAD" acceptable, or would they rather an explicit choice in Console?
- We'd skip `triggerInitialDeployment` for Composer repos — does anything
  downstream assume a first Build row exists (metrics, activation nudges,
  Console states)?
- `handlePush` will see an active link and dispatch to the runner — where do
  they want the guard (a `ProjectScmRepo` field vs a handler check), and
  what should the webhook-event record say?
- Setup must be idempotently re-runnable (rewrite secret, reopen an
  unmerged PR) — anything that fights that?

**3. Token minting (the only hard mgmt-api dependency for v1).** Can the
control plane mint a workspace service token programmatically today, or is
that Console-only? What's the revocation path — and on unlink/uninstall,
which of their handlers should revoke the token and delete the secret? Bonus:
any roadmap for project-scoped tokens (cuts a leaked secret's blast radius
even before OIDC)?

**If time allows:** Console surface for CI-deployed repos (our floor:
"connected" badge + link to workflow runs — do they want checks-API status
ingestion, and who scopes it?); whether the connected-repo UI tolerates a
link with zero Build rows; anything else that assumes every linked repo
produces builds (we know the failure-email cron and activation
notifications); OIDC temperature check.

## Close

- Decision or decision-date on the App question.
- Named owner for the link-flow work.
- Confirmed mechanism for token minting.
- Send them the one-pager ([product-team-note.md](product-team-note.md)) and
  the tracker
  (<https://linear.app/prisma-company/project/prisma-composer-one-click-github-deploys-29acf2ee21e9>).

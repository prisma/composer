# Design — One-Click GitHub Deploys

The design record for
[Prisma Composer: One-Click GitHub Deploys](https://linear.app/prisma-company/project/prisma-composer-one-click-github-deploys-29acf2ee21e9).
Written for an implementer without prior context. The contract is §§ 1–3;
requirements it satisfies are § 4; history and rejected options are at the
end. Settled with Will Madden, 2026-07-20.

## The decision

Composer apps deploy from **the user's own GitHub Actions**, running the
already-documented CI flow (`docs/guides/deploying.md` § CI: set two
variables, build, run `prisma-composer deploy`). The platform never executes
a Composer user's code. The GitHub App's job is to make that setup one click:
at install time it links the repo, provisions the credential into the repo's
Actions secrets, and opens a **setup PR** containing the workflow. The user
reviews and merges that PR; from then on pushes deploy and pull requests get
preview environments.

Three deliverables, in build order:

1. a **reusable GitHub Action** (S1),
2. a **workflow template** that uses it (S1),
3. the **install-time automation** in pdp-control-plane that writes the
   credential and opens the setup PR (S2).

## 1. The runtime design: Action + workflow template

### Division of responsibility

- **The workflow file (user-owned, in their repo)** declares everything
  app-specific: when to build, the build command, the entry path, which
  events deploy. It is the *declaration surface* — a human reviewed and
  merged it, so nothing about the app is ever inferred at deploy time.
- **The Action (ours, versioned, reusable)** owns everything mechanical:
  deriving the stage name from the GitHub event, choosing
  `deploy`/`destroy`/`--production`, and invoking the CLI. Users get fixes
  by version bump, not by editing their workflow.

### The Action

A composite action (working name `prisma/composer-deploy`; final name and
hosting are S1 decisions — likely published from this monorepo). It assumes
checkout and toolchain setup already happened in the calling job.

Inputs:

| input | required | meaning |
| --- | --- | --- |
| `entry` | yes | path to the root module file, e.g. `module.ts` |
| `command` | no, default `deploy` | `deploy` or `destroy` |
| `stage` | no | explicit stage name; when absent, derived from the event (below) |
| `production` | no, default `false` | target production instead of a stage (destroy only; deploy targets production by *omitting* the stage) |
| `working-directory` | no, default `.` | where to run the CLI |

Environment contract (the caller provides; the Action only consumes):
`PRISMA_SERVICE_TOKEN` (secret) and `PRISMA_WORKSPACE_ID` (variable). The
Action never prints either.

Stage derivation when `stage` is not given:

| event | stage |
| --- | --- |
| `pull_request` (any type) | the PR's head branch name (`github.head_ref`) |
| `push` to the default branch | none — production |
| `delete` (branch) | the deleted branch's name (`github.event.ref`) |
| anything else | **error** — the Action refuses to guess |

Stage names are git branch names, which the CLI already validates
(`git check-ref-format`); the Action adds no naming rules of its own.

### The workflow template

One file, `.github/workflows/prisma-composer.yml`, with three jobs. The
trigger model is **PR-driven previews, push-driven production**:

| event | job | behaviour |
| --- | --- | --- |
| `pull_request` `[opened, synchronize, reopened]` | preview-deploy | build, then Action `deploy` (stage = PR head branch) |
| `pull_request` `[closed]` | preview-destroy | Action `destroy` (same stage; merged or not) |
| `push` to the default branch | production-deploy | build, then Action `deploy` with no stage → production |
| `delete` (branch) | branch-destroy | Action `destroy` (stage = deleted branch) — covers branches deleted without a PR |

Explicitly decided: a push to a non-default branch with no open PR deploys
**nothing**. Previews are a property of pull requests, not of branches.

Every deploy/destroy job carries
`concurrency: { group: prisma-composer-${{ github.event.pull_request.head.ref || github.ref }}, cancel-in-progress: false }`
so runs against one environment queue rather than interleave. (The deploy
state store also holds a per-stage advisory lock server-side — ADR-0010 — so
even a misconfigured workflow cannot corrupt state; the second deploy fails
fast instead.)

The template marks exactly two things for the user to confirm in the setup
PR: the **build command** (one `run:` step, prefilled from the repo's
`package.json` build script) and the **entry path** (prefilled `module.ts`
if present at the repo root). Prefills are suggestions; the human merge is
the sign-off. `destroy` jobs need no build step? **No — they do**: destroy
evaluates the same stack program as deploy and requires built artifacts (see
`deploy-cli.md` § Known limitations), so destroy jobs run the same build
step first. Do not "optimize" this away.

App-level secrets (the user's own `envParam`/`envSecret` values, e.g. Stripe
keys) are ordinary Actions secrets the user adds and passes as `env:` in
their workflow — the template includes a commented block showing how. On the
first deploy of a stage the CLI's preflight seeds the platform's per-stage
variables from that environment, exactly as it does from a laptop shell;
nothing new is needed.

## 2. The install-time design (pdp-control-plane)

Trigger: repo link, in the existing flow (`linkProjectToScmRepo` — the
Console-initiated GitHub App install with the signed nonce, unchanged). After
the link is created:

1. **Detect a Composer repo** — a deterministic marker: the presence of
   `prisma-composer.config.ts` in the repo root at the default branch's HEAD
   (fetched via the installation token). No marker → the existing Compute
   flow, untouched. Marker → this flavor, and the existing flavor's
   `triggerInitialDeployment` is **skipped** (the first deploy happens when
   the setup PR merges and Actions runs).
2. **Provision the credential** — mint a service token, write it to the
   repo's Actions **secret** `PRISMA_SERVICE_TOKEN`, and write the workspace
   id to the Actions **variable** `PRISMA_WORKSPACE_ID`. v1 scope is the
   workspace-scoped token — identical exposure to the manual flow the guide
   documents today (see § 5 for the OIDC end state).
3. **Open the setup PR** — a branch adding the workflow template, entry and
   build command prefilled by reading `package.json` and checking for root
   `module.ts` (prefill only; never executed, never trusted at deploy time).
   PR body explains what merging enables and where the credential lives.

Failure handling: each step is independently retryable; a link with a
missing secret or absent PR is repairable by re-running the setup (idempotent
find-or-write semantics — same discipline as the CLI's container resolution).

No other pdp component changes. **Not touched:** build-runner, the E2B
sandbox, `handlePush`/dispatch, the `Build` model, finalize. Webhook traffic
for Composer-linked repos does not dispatch builds.

### Permissions: extend the existing App, tolerate non-acceptance

Resolved with the App's author (call, 2026-07-20): adding permissions to the
existing App does **not** force reinstallation. Existing installations get an
email asking them to accept the new permissions; until they do, the App keeps
working with its old grant. So:

- **One App, extended** with the Actions-secrets/variables write and
  contents write permissions (verify exact permission names against the
  manifest at implementation time). No second App.
- **New installations** get the full grant up front — unaffected.
- **S2 must check the installation's granted permissions** (GitHub exposes
  them on the installation) before attempting Composer setup. Missing grant →
  refuse the Composer flavor with an actionable message ("accept the updated
  permissions, then re-link"), never a half-configured repo. The Compute
  flavor is untouched by a stale grant.

Prior art to build on, not invent (same call): pdp already has a flow that
**opens a PR on the user's repo with Prisma config setup**. The setup PR is a
small addition to that logic or a sibling of it — locate it during S2
grounding and reuse its plumbing (branch creation, PR authoring, permission
handling).

## 3. Teardown semantics

- Normal path: the workflow's `preview-destroy`/`branch-destroy` jobs run
  `prisma-composer destroy --stage <branch>`, which walks deploy state — so
  everything the deploy created is removed, **including resources outside
  Prisma Cloud** (Cloudflare, S3, …) if the app uses such extensions.
- Backstop: per ADR-0034, each stage's deploy state lives in a database
  inside that stage's Branch, so platform-side Branch deletion (Console,
  reclaim cron) removes state and platform resources even if the workflow
  never ran. The backstop covers platform resources only; the workflow path
  is the complete one.

## 4. Requirements this design satisfies

- **The platform never executes user code.** All build/deploy execution is
  in the user's CI under their credential. (This is what makes the design
  viable at all — see Alternatives.)
- **Nothing is guessed (ADR-0005).** Entry and build command live in a file
  a human merged; install-time prefill is a reviewed suggestion; the Action
  errors on events it cannot map rather than inferring.
- **No new configuration surface.** No new file format, no app settings in
  `prisma-composer.config.ts` (ADR-0017 stands); the workflow file is
  standard GitHub CI.
- **First-deploy configuration works unchanged.** The CLI seeds per-stage
  platform variables from the deploying shell's environment; a CI job *is*
  such a shell.
- **Concurrent deploys are safe twice over**: per-environment `concurrency`
  groups in CI, and the state store's per-stage advisory lock (ADR-0010)
  server-side.
- **Teardown is complete and double-covered** (§ 3), including non-platform
  resources — which no platform-side mechanism could ever reach, since only
  deploy state knows they exist.
- **Credential exposure does not regress.** v1 equals the documented manual
  flow (a workspace token in Actions secrets); the App merely writes it so
  the user never handles it.
- **The existing Compute App experience is untouched.** Flavor fork at link
  time; `prisma.compute.ts` repos see zero change.

## 5. Accepted costs and their mitigations

- **Requires GitHub Actions** and a merged setup PR. Users without CI are
  served by the existing Compute flow, not by Composer, unless that becomes
  a product goal (then see Alternatives).
- **Build logs live in GitHub, not Prisma Console.** Console still shows
  resources, branches, and state. S3 scopes the Console surface (floor:
  connected-repo state + link to workflow runs).
- **v1 stores a long-lived workspace-scoped token in repo secrets.**
  Follow-up
  [TML-3056](https://linear.app/prisma-company/issue/TML-3056/oidc-token-exchange-for-github-actions-deploys)
  replaces it with GitHub OIDC exchanged for short-lived project-scoped
  credentials — no stored secret at all.

## Alternatives considered

- **Platform-run builds (the original plan): fork pdp's build-runner/E2B
  sandbox to run the user's build + `prisma-composer deploy` inside the
  sandbox.** Rejected: the CLI is the provisioner, so the sandbox — which
  executes arbitrary user code — would need a Management API credential, and
  the only existing token type is workspace-scoped and long-lived; one
  malicious `postinstall` in one PR could read the credential for every
  project in the workspace. Fixing that needed new platform token machinery
  (or a proxy fronting the entire Management API), plus a large fork of the
  runner: Composer detection, kickoff/finalize bypass, a new sandbox
  program, supersede and first-deploy-config policies, data-model consumer
  fixes. This path also remains the only way to offer zero-config onboarding
  to users without CI — it is superseded, not forbidden, if that segment
  ever matters for Composer.
- **Workspace token in the sandbox as an interim.** Rejected outright: turns
  one compromised PR build into a workspace-wide incident, and interim
  credentials calcify.
- **Host-side proxy holding the credential, sandbox calls the proxy.**
  Viable but rejected with the sandbox plan itself: the proxy must
  faithfully front every Management API route the CLI and its providers
  touch, forever.
- **Declaring entry/build command in `prisma-composer.config.ts` or in
  repo-link settings** (needed only by the sandbox plan). Moot here — the
  workflow file is the declaration — and each was independently bad: the
  config file is forbidden app settings by ADR-0017; DB-side settings drift
  from the repo invisibly.

## Decision log

1. Deploys run in user CI; the platform never executes Composer user code
   (Will, 2026-07-20 — supersedes the sandbox plan).
2. The App's scope is credential provisioning + preview-lifecycle wiring
   (Will, same discussion).
3. The setup PR is the declaration surface; prefill is a suggestion, the
   merge is the sign-off.
4. Previews are PR-scoped, not branch-scoped; non-default-branch pushes
   without a PR deploy nothing (this doc, accepted by review of it).
5. OIDC is the credential end state, slated as TML-3056, not bundled into
   v1 (App author concurred: nice later, not critical path).
6. **Extend the existing App; no second App** (call with the App's author,
   2026-07-20). Permission additions notify by email and degrade gracefully —
   no forced reinstall — so the re-approval fear that motivated the two-App
   option is gone. S2 detects the grant and refuses Composer setup until
   accepted (decision 6a).
7. **Composer is not the default install flavor.** Product confidence isn't
   there yet (Will, same day); the Compute flow stays the default for new
   projects, Composer flavor triggers only on detection. Revisit when
   Composer matures — the App author noted that making Composer primary
   would eventually let pdp retire the E2B build system, which is a real
   maintenance burden they'd like shed. Strategic tailwind, not a v1 goal.
8. **Token approach confirmed by the App author** (programmatic minting +
   Actions secret at install). Direction overall validated — his framing:
   an improvement on what exists, consistent with the Terraform/Pulumi model
   where users own their builds.

## References

- `docs/guides/deploying.md` § CI — the manual flow this automates
- `docs/design/10-domains/deploy-cli.md` — CLI pipeline; destroy requires
  built artifacts (§ Known limitations)
- ADR-0005 (no guessing) · ADR-0010 (deploy lock) · ADR-0017 (config carries
  no app settings) · ADR-0024 (stages) · ADR-0034 (state lives in the
  stage's Branch)
- pdp-control-plane: `packages/interactors/src/scm/linkProjectToScmRepo.ts`,
  `packages/github/src/nonce.ts`
- [spec.md](spec.md) · [plan.md](plan.md) ·
  [assets/product-team-note.md](assets/product-team-note.md)

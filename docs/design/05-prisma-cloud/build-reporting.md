# Build reporting — how a deploy records itself on Prisma Cloud

Every `prisma deploy` against Prisma Cloud records itself on the platform as a
**Build**: that a run happened, how far it got, how it ended, and which platform
resources it touched. The Console shows these builds as deploy history, even
for apps the platform never built itself.

Reporting is observability. It never fails a deploy: every API call warns and
returns on failure, the CLI also swallows anything a reporter throws, and a
deploy that converged is a deploy that succeeded, whatever the platform was
told.

## The pieces and where they live

| Piece | Location |
| --- | --- |
| The `reporter` hook on the extension descriptor | [`core/src/control/app-config.ts`](../../../packages/0-framework/1-core/core/src/control/app-config.ts) (`ReporterDescriptor`, `RunReporter`) |
| Driving the hook through the deploy | [`cli/src/operations/execute-deploy-destroy.ts`](../../../packages/0-framework/3-tooling/cli/src/operations/execute-deploy-destroy.ts) |
| The reporting session, git identity, build API | [`lowering/src/builds/`](../../../packages/1-prisma-cloud/0-lowering/lowering/src/builds/) |
| Resource reporting at the state store | [`builds/state-store.ts`](../../../packages/1-prisma-cloud/0-lowering/lowering/src/builds/state-store.ts), wired in [`state/layer.ts`](../../../packages/1-prisma-cloud/0-lowering/lowering/src/state/layer.ts) |
| The extension's adapter | [`target/src/reporting/reporter.ts`](../../../packages/1-prisma-cloud/1-extensions/target/src/reporting/reporter.ts) |
| The JSON run report | [`cli/src/run-report.ts`](../../../packages/0-framework/3-tooling/cli/src/run-report.ts) |

## The reporter hook: begin, attach, finish

Core defines the vocabulary and knows nothing about Builds. The CLI drives the
lifecycle and makes no HTTP calls. The Prisma Cloud extension supplies the
implementation. This split is forced: the framework domain may import nothing
from Prisma Cloud (`architecture.config.json`), and the CLI is framework
tooling, so reporting can reach the CLI only through the extension descriptor —
the same seam that already carries `container`, `preflight` and `teardown`.

The CLI calls the hook three times:

1. **`begin`** — after the graph loads and **before** containers resolve.
   Creating the Project is the step that can leave one behind with nothing
   recording why (composer#103), so a session opened later would miss the
   failure it most needs to describe. `begin` creates or joins the Build and
   marks it `phase: deploy, state: running`.
2. **`attach`** — once the Project and Branch exist. It fills the Build's
   `projectId` and, for a named stage, `branchId`, and submits the declared
   application topology to the stage's Branch (the default Branch for the
   default stage). The topology's content hash rides the same update.
3. **`finish`** — on every exit path: success, structured failure, a thrown
   defect (`DEPLOY.UNEXPECTED`), and an interrupt. It sets the terminal
   `state` (`succeeded`, `failed` or `cancelled`), `failingStep` (Composer's
   error code, capped at 500 characters) and `errorMessage` (capped at 5000).

The session also hands the alchemy child its environment through
`childEnv()`: `PRISMA_BUILD_ID`, so reporting inside the apply finds the run.

The reporter installs no signal handlers. The CLI engine owns signals, and an
interrupt reaches the reporter as `cancelled` on the ordinary `finish` path.

## Why the session lives in lowering

The session reads git and the deploy shell's environment. The extension
package (`1-extensions/target`) ships into runtime surfaces, and its own
invariant tests forbid it to read `process.env` beyond a fixed list or to
import any `node:` builtin. So the session lives in
`0-lowering/lowering/src/builds/`, which already uses node builtins. The
extension keeps a few-line adapter supplying the one thing lowering cannot
know: how to read the project and branch ids out of its own container.

## How a run gets its Build

- **Join** when a build id is given. `--build-id` wins over `PRISMA_BUILD_ID`,
  because a flag was passed deliberately for that step; an empty string counts
  as unset on both. Joining never re-creates the build and never overwrites
  what its creator knows better: `source` and `externalLogUrl`.
- **Create** otherwise. Inside GitHub Actions with a complete run identity, the
  build is `source: "ci"`; otherwise `source: "cli"`. A deploy that reports
  nothing is invisible, so creating is a requirement, not a fallback.
- **No git, no Build.** `commitSha` and `branchName` are required by the
  platform. Composer prefers `GITHUB_SHA` and `GITHUB_HEAD_REF` /
  `GITHUB_REF_NAME`, and falls back to reading git. Outside a checkout it
  warns and reports no Build, because a placeholder value would stay in the
  workspace's history permanently. The topology is still submitted; it needs
  no repository.
- **`phase` is always `deploy`.** Composer never builds the user's code (the
  user builds; the framework only assembles), so `build` names a phase this
  tool never runs.

## Run identity

The platform deduplicates builds by a key derived from the GitHub run:
`github:<workspaceId>:<repositoryId>:<runId>:<runAttempt>`, with a unique
constraint on the row. But the platform reads no GitHub environment itself; the
run identity arrives in the request body.

So every reporter of one run must derive the identity from the same three
variables — `GITHUB_REPOSITORY_ID`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT` — or a
single run produces several builds. Three reporters share this: Composer
([`builds/run-identity.ts`](../../../packages/1-prisma-cloud/0-lowering/lowering/src/builds/run-identity.ts)),
the Prisma GitHub Action, and the platform's git webhook, which correlates
`workflow_run` events into the same row and usually reports first (marking the
build `queued` before any user code runs). Composer sends an identity only when
all three parts are present and are digits; a partial or malformed identity
yields none, since the key joins its parts with `:`.

Passing a build id down avoids the problem entirely. The derived identity is the
fallback, and it converges only because all three sides read the same
variables.

## Fill-only updates

`projectId`, `branchId`, `appId` and `deployedUrl` are fill-only on
`PATCH /v1/builds/{id}`: the first value sticks, re-sending the same value is a
no-op, and a different value is a 409. That is why `attach` is a separate call:
if the build's creator recorded a different project, Composer loses only those
fields, not the rest of the run's report.

The Build records `deployedUrl` (and so the app link) only when the run
deployed exactly one compute service with a public address. The column holds
one value, and picking one of several services would imply it was the app's
address. Multi-service apps lose nothing: every service is reported as a
resource.

## Resource reporting at the state store

Each platform resource is reported as Alchemy converges it. The interception
point is the state store, wrapped in `withResourceReporting`, because every
resource write passes through it whichever provider performed it. The deploy's
own report hook would not do: descriptors emit three entity kinds
(`postgres-database`, `bucket`, `compute-service`) against the platform's eight
resource types, and `deployment` — the type that makes the platform attach the
deployment to the build and record its app — is not an entity at all.

How it behaves:

- A report is sent only after a successful state write, never before. The
  platform returns 404 for a resource that does not exist yet.
- Reports are fired without blocking the apply, so a large deploy does not pay
  one round trip per resource. They are drained in the state layer's
  finalizer, before the deploy lease is released, with a 15-second backstop.
- A resource written twice in one run (creating, then created) is reported
  once.
- An adopted resource is not reported. Resolving something that already
  existed is not acting on it.
- The state layer reads `PRISMA_BUILD_ID`. When it is absent it uses the store
  unwrapped and reports nothing.

The mapping, keyed by upstream `alchemy/Prisma` type ids:

| Alchemy resource | Platform type |
| --- | --- |
| `Prisma.Project` | `project` |
| `Prisma.Database` | `database` |
| `Prisma.Connection` | `service_key` |
| `Prisma.Bucket` | `bucket` |
| `Prisma.App` | `app` |
| `Prisma.Deployment` | `deployment` (also attaches the deployment to the build and records the app) |
| `Prisma.EnvironmentVariable` | `config_variable` |
| `Prisma.BucketAccessKey` | not reported; no platform type corresponds |
| `ServiceKey`, `PgWarm`, any other extension's resource | not reported; not a platform resource |

| Terminal state status | Reported action |
| --- | --- |
| `created` | `created` |
| `updated` | `acted_on` |
| `deleting` | `deleted` |

Intermediate statuses (`creating`, `updating`, `replacing`) are skipped. The
platform's resource report is an idempotent upsert whose action never weakens.

The Project is created by container resolution, not by Alchemy, so it usually
has no resource row; the Build's `projectId` carries the association.

## The run report

`--report <path>` or `PRISMA_COMPOSER_REPORT_FILE` writes a versioned JSON file
with the app, its stage, its nodes and entities (including preview URLs), and
the failure cause. It is written on failure too. It is separate from the
internal summary the alchemy child hands the CLI, which is deleted after every
run so resource ids and URLs do not accumulate on disk. The Prisma GitHub
Action reads it to comment preview links on a pull request. It is
transitional: it can go once the Action reads the Build, topology and versions
from the platform.

## Invocation cases

| Case | `PRISMA_BUILD_ID` | What happens |
| --- | --- | --- |
| Laptop | absent | Creates a build, `source: "cli"`, no run identity. Not idempotent: each retry is a new build, and failed local commands create build records. |
| Generic CI on GitHub Actions | absent | Creates a build, `source: "ci"`, with a run identity. Idempotent per run attempt, and links the build to its repository. |
| Prisma GitHub Action | present | Joins. Never re-creates, never touches `source` or `externalLogUrl`. |
| Direct `alchemy deploy` of the generated stack file | absent | No CLI parent, so no build and no resource reports. |
| `destroy` | either | Not reported. |
| `prisma dev` | n/a | Never reports: local providers, no token. |
| Programmatic deploy | either | Behaves as the laptop or CI case, according to its environment. |
| Process killed | either | No terminal report; the build stays `running`. |

## Accepted gaps

- **`destroy` is not reported.** It is the only source of the `deleted`
  action, but `phase` has no teardown value and `source` cannot distinguish
  one, so a destroy would render as a deploy that deleted everything.
- **A killed process leaves the build `running` forever.** Nothing sweeps
  builds. An interrupt the engine catches is reported as `cancelled`; SIGKILL
  and a torn-down CI runner cannot be. CI cancellation is common, so this is
  the normal case, not a defect.
- **A failed apply reports `DEPLOY.ENGINE_FAILED` as its `failingStep`.** Every
  failure inside the alchemy child shares that code. The `errorMessage`
  carries the exit status and, when the child recorded one on its way out, the
  underlying cause.
- **`branchId` stays empty on a default-stage deploy.** Only a named stage's
  Branch is attached to the Build.

## Related

- [`alchemy-lowering.md`](alchemy-lowering.md) — the resources being reported,
  and the `logicalId` each platform row carries.
- [`pdp-data-model.md`](pdp-data-model.md) — the platform entities.
- [`../10-domains/deploy-cli.md`](../10-domains/deploy-cli.md) — the deploy
  pipeline the hook runs inside.
- [ADR-0005](../90-decisions/ADR-0005-users-build-the-framework-assembles.md)
  — users build their code; the framework only assembles it. Why `phase` is
  always `deploy`.
- The platform side: `services/management-api/routes/v1/builds/` in
  pdp-control-plane, and its branch-topology spec
  (`projects/branch-topology/spec.md`).

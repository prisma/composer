# Prisma provider: tests, docs, examples and conventions a Compute/Deployment refactor must respect

Repository: `wip/alchemy` (Alchemy). All paths below are relative to its root. Line numbers are from the checkout at `01792ec3` (2026-11-11).

Headline findings:

- The Management API is consumed through **distilled** (`@distilled.cloud/prisma/management`) by every resource file, including `Compute.ts`, `Deployment.ts`, `App.ts` and `EnvironmentVariable.ts`. The hand-written `src/Client.ts` remains for the exported operation helpers (`Operations.ts`) and some error types. So "patch distilled, never the consumer" applies. The `submodules/distilled` directory is **empty in this checkout** (not initialized), so the distilled Prisma service module could not be read.
- Most Prisma tests of Compute and Deployment are **hermetic unit tests against an in-memory fake Management API** that call `provider.reconcile` / `provider.diff` directly. That is exactly what AGENTS.md and the audit skill forbid. There is **no live test of `Prisma.Deployment` or `Prisma.EnvironmentVariable`**, and **no live test that redeploys `Prisma.Compute` with a changed artifact**.
- There is no `processes/` directory, no Prisma catalog, and no Prisma design or planning document in the repository.
- The clone is shallow with depth 1, so there is no usable history for `packages/prisma`. CHANGELOG.md and the blog are the only record.
- Generated API reference pages under `website/src/content/docs/providers/` are gitignored and not present in this checkout.

---

## 1. `packages/integration-tests/test/Prisma`

### How the suites test the Management API

There are three patterns.

**(a) Live account, through a stack.** `Test.make({ providers: Prisma.providers() })` plus `test.provider(...)`, `stack.deploy` / `stack.destroy`, and out-of-band checks through distilled, for example `getService({ serviceId })` and `getProject({ id })` from `@distilled.cloud/prisma/management` (`App.test.ts:4`, `Compute.live.test.ts:5`). Tagged `live`. These follow the AGENTS.md convention.

**(b) In-memory fake HTTP server: `fixtures/FakeManagementApi.ts`.** It is not recorded responses and not a live account. It is a fake `HttpClient` plus fake distilled `Credentials`, which answers requests from a caller-supplied dispatch function (`FakeManagementApi.ts:11-27`):

> "An in-memory Prisma Management API served over a fake `HttpClient`. ... The provider tests used to inject a fake `PrismaManagementClient`. Resource files calling generated distilled operations bypass that seam, so the fake moves one layer down and speaks the wire instead. Tests therefore exercise distilled's schema decoding and its status-to-tag matching, which the client-level fake never touched."

Its base URL is `https://api.prisma.test` (`:29`). It exports response builders `json`, `data` (`{ data }` envelope), `page` (`{ data, pagination }`), `noContent`, `failure`, `notFound`, `conflict`, `badRequest` (`:41-71`), and captures every request (`Captured`, `:32-39`). Suites build a dispatcher (`dispatchManagement` in `Compute.test.ts:216`, `clientBackedApi` in `Deployment.test.ts:82` and `DeploymentActions.test.ts:42`) that routes wire paths to client-shaped handler objects cast with `as unknown as PrismaManagementClient`. Note that the fake routes Deployment traffic at `/v1/services/{serviceId}/deployments` (`Deployment.test.ts:66-95`), while the pinned route contract names it `/v1/apps/{appId}/deployments` (`ManagementCoverage.test.ts:111`). The distilled client uses Prisma's "service" naming on the wire.

The suites that use the fake then call provider lifecycle methods directly, for example:

```ts
const provider = yield* Compute.Provider;
const error = yield* provider.reconcile({ id: "App", fqn: "App", instanceId: "000…", news: {…}, olds: undefined, output: undefined, session: undefined as never, bindings: [] })
```

(`Compute.test.ts:672-690`). Counts of direct `.reconcile(` calls: `Compute.test.ts` 58, `Resources.test.ts` 43, `Deployment.test.ts` 15, `ManagementLifecycle.test.ts` 12. `fixtures/StackContext.ts:5-6` exists for this purpose: "Placeholder `Stack` + `Stage` for suites that build a provider layer and drive its lifecycle operations directly instead of deploying a stack."

`ManagementLifecycle.test.ts` also runs the real engine over the fake: `Test.make({ providers: projectLayer(refusalCloud.fake) })` then `stack.deploy(...)` (lines ~518-540). The audit skill calls this a "fake-cloud engine test".

**(c) Fakes of the auth stores: `fakes.ts`.** `makeFakeProfileStore` and `makeFakeCredentialsStore` (`fakes.ts:7-44`) stub alchemy's `ProfileStore` and `CredentialsStore` for the auth-provider unit tests. They do not touch the Management API.

`lookup.ts` is not a fake. `expectFound` (`lookup.ts:28-66`) takes a `Resource.lookup(...)` output from a just-deployed resource, plans a second scratch stack (`Core.scratchStack(..., "PrismaLookupProbe")`) that feeds the lookup into a `Prisma.Project` `settings.value`, and compares the looked-up attributes to the deployed ones, skipping `updatedAt|status` (`:11`) and fields named in `ignore`. It retries 6 times every 5 seconds because "A just-created resource can read as missing for a few seconds" (`:34`, `:53`). It runs against the live account.

**How this squares with the convention.** It does not. AGENTS.md:847 says: "Exercise create, update, redeploy, and removal through the stack. **Do not mock HTTP or SDK responses, invoke provider lifecycle methods directly, or call extracted reconciliation helpers as a substitute for a deployment.**" The audit procedure (`.agents/skills/audit/procedure.md:63-67`): "No mocked HTTP/SDK/CLI responses, fake layers, direct lifecycle calls, or fake-cloud engine tests." and (`:72-73`) "If a suite already fakes what it claims to test, say so plainly". The only allowance is AGENTS.md:852: "Pure utility and engine unit tests remain appropriate for their own behavior; they do not replace live resource lifecycle coverage." The fake suites tag themselves `unit` and `local`, which keeps `pnpm lint:tests` green but does not make them conforming lifecycle coverage.

### Per-file summary

Kind tags: **U** = unit, **Lo** = local, **Li** = live. "Stack" means `test.provider` + `stack.deploy`. "Fake+direct" means FakeManagementApi plus direct lifecycle calls.

| File | Kind | Harness | Covers |
| --- | --- | --- | --- |
| `App.test.ts` (406 lines) | Li (`:20-26`) | Stack, live, distilled out-of-band | App create under fqn logical ID, rename converge in place, lost-state adoption by logical ID, interrupted create recovery, logical-ID collisions, branch attach by git name, region change refused, project change replaces, follows promoted default branch, drift repair (`:47-368`). Each test 180 s timeout. |
| `AuthProvider.test.ts` | U, Lo | `fakes.ts` stores | `PRISMA_SERVICE_TOKEN` then `PRISMA_API_TOKEN` for CI (`:55-69`). |
| `Bucket.test.ts` | Li | Stack | Bucket and BucketAccessKey lifecycle, logical IDs, replacement, key recovery. |
| `BucketBinding.test.ts` | U+Lo for key derivation (`:36`); Li fixture suite (`:280-292`) | `beforeAll(deploy(Stack))` / `afterAll(destroy)` | Bucket bindings inside deployed Compute hosts. |
| `BundlePaths.test.ts` | U, Lo | Pure | Compute bundle path normalization. |
| `Client.test.ts` (1527) | U, Lo | Fake `HttpClient.make` | The hand-written `PrismaClient`. The fake fixture was lifted from here. |
| `Compute.dev.test.ts` (281) | Lo | Stack with `Test.make({ providers, dev: true })` (`:11`) | Dev mode returns a local Compute with no token, same stack shape with Project, records `Connection.bind` env, resolves every owned resource shape without a token, starts a local command and passes env (`:14-220`). |
| `Compute.live.test.ts` (505) | Li | Stack, live; also Cloudflare providers (`:19-21`) | Deploy, fetch, destroy a Bun app with `destroyOldDeployment: true` (`:59-173`); static site (`:176`); `Prisma.rollbackApp` to the live deployment with `destroyOldDeployment: false` (`:345-441`); OTLP spans (`:444`). A manual cleanup tool gated on `ALCHEMY_RUN_LIVE_PRISMA_CLEANUP=true` and `PRISMA_CLEANUP_PROJECT_ID` (`:23-56`). Timeouts 600 s. **No case redeploys with a changed artifact or env**, so in-place deployment update, stop-but-keep of the previous deployment, and promotion of a second generation are not covered live. |
| `Compute.test.ts` (6941) | U, Lo (`:458`) | Fake+direct | 77 cases: URL readiness and health contract (`:461-656`); prop validation such as "rejects destroyOldDeployment when promotion is skipped" (`:669`), start/promote combos, branch inputs, ports, `skipCodeUpload` (`:669-1197`); diff: region or project change replaces, unchanged props update so artifacts can rehash (`:1056-1142`); read/adoption of latest deployment as `Unowned` (`:1230-1478`); new version on branch change (`:1713`); failure cleanup: deletes the created App, deletes the deployment when upload or start fails (`:2117-2319`); health failure blocks promotion, stable health failure rolls back, non-converging promote and rollback, terminal failed deployments, rollback recovery from persisted state (`:2434-3130`); artifact upload and bundling (`:3331-3600`); env sync through the environment variable API, rollback of partial env sync, foreign and system-managed env vars, binding env merge (`:3715-4714`); builds (`:4833-5119`); "reconciles deploy updates and destroys old deployments" (`:5358`), "creates a no-upload version for skipCodeUpload env updates" (`:5666`), promotion replay for endpoint drift (`:5805`), pending cleanup persisted when old-deployment destroy fails (`:5922`), ambiguous promotion commit (`:6075`); env deletion on destroy (`:6227-6762`); log tailing (`:6426`, `:6835`). Uses `withDefaultBranch` to adapt client-shaped fakes (`:68-96`). |
| `ComputeArchive.test.ts`, `ComputeBuild.test.ts`, `WebsiteArtifact.test.ts` | U, Lo | Pure / local processes | Archive layout, build commands, website artifacts. |
| `ComputeLifecycle.test.ts` (552) | U, Lo (`:98`) | Fake HTTP on exported helpers, no stack | `waitForDeploymentStatus` timing and failures, `destroyDeployment` (stop then delete, already stopping, already gone, server error), `destroyApp` cascade and bounded conflict retry, `destroyProjectApps` with pagination and truncated listing refusal (`:101-536`). |
| `Connection.test.ts`, `Database.test.ts` | Connection: U, Lo fake. Database: Li stack | | Connection and Database lifecycles. |
| `Deployment.test.ts` (2147) | U, Lo (`:117`) | Fake+direct (`deploymentProviderLive`, `:61-67`) | Upload safety: redacted signed URLs, byte limit, symlink refusal, file changed after validation, fixed Content-Length streaming (`:120-259`); delete on upload or start failure, ambiguous promotion commit (`:317-530`); read via canonical route, no adoption of an unrelated latest deployment on a cold read, Foundry version recovery (`:735-968`); **diff: "replaces when artifactPath contents change" (`:1027`), "replaces changed artifacts even when app is unresolved" (`:1067`), "replaces when the persisted App changes from an unresolved old prop" (`:1109`), "does not replace when artifact bytes are unchanged" (`:1148`)**; promotion replay (`:1188`); terminal failed replacement (`:1309`); stopping counts as delete in progress (`:1483`); prop validation (`:1568-1723`); start route (`:1750`); logs (`:1816`); **triggers: "records a redacted triggers fingerprint and replaces when a value changes" (`:1881`), "replaces when a plain triggers value changes" (`:1946`), "keeps a deployment recorded before triggers existed when nothing changed" (`:1966`), "replaces when triggers cannot be resolved while planning" (`:1986`)**. These replacement assertions are what the refactor to in-place update will invert. |
| `DeploymentActions.test.ts` (99) | U, Lo (`:60`) | Fake HTTP on internal helpers | `startDeploymentIdempotent` does not hide a start conflict for an unuploaded version, accepts a start conflict only after observing progress; `stopDeploymentIdempotent` accepts a stop conflict while teardown progresses (`:63-89`). Imports `internal/DeploymentActions.ts`. |
| `Hyperdrive.test.ts` | Li | Fixture suite | Cloudflare Hyperdrive in front of a Prisma connection. |
| `IsolatedProjectCompute.test.ts` (68) | Li (`:65`) | Stack | A Compute app whose `main` lives in an isolated project still boots, because the bootstrap's imports are bundled (`:16-21`). Health check retried 30 × 2 s, timeout 1,200 s: "One Prisma Compute deploy alone can take the full 600s." (`:63`). |
| `LogsClient.test.ts`, `PrismaLogs.test.ts`, `Refs.test.ts`, `Types.test.ts`, `PrismaEnvironment.test.ts`, `PrismaDevDatabase.test.ts`, `Operations.test.ts` | U, Lo | Pure | Log request builders, log parsing, refs, types, `PRISMA_API_URL` handling, dev database, operation helpers. |
| `Lookup.test.ts` | Li | Stack | A looked-up Project holds a declared Database; a lookup of a missing resource fails the plan. |
| `ManagementCoverage.test.ts` (247) | U, Lo | Pure | See section 2. |
| `ManagementLifecycle.test.ts` (1998) | U, Lo (`:272`, `:310`) | Fake HTTP, some direct calls, some `Test.make` over fake provider layers + `stack.deploy` | Database credential recovery, Project cold-adoption refusal, physical name recovery, default database add/replace, Database naming and region inherit, write-only env secret convergence, custom domains, source repository relink, branch promotion restore on destroy (`:233-1882`). |
| `Providers.test.ts` (293) | U, Lo (`:59`) | Dev providers layer | Auth registers without resolving credentials; **every resource type is registered with fixed `stables`** (`:85-160`): `Compute: ["appId"]`, `App: ["appId"]`, `Deployment: ["deploymentId"]`, `EnvironmentVariable: ["environmentVariableId"]`; dev providers are tokenless; `managementApi` rejects unknown profiles; log tailing. |
| `PublicSurface.test.ts` (393) | U, Lo | Pure | See section 2. |
| `Resources.test.ts` (5338) | U, Lo (`:662`) | Fake+direct (`dispatchManagement`, `:605`) | Connect binding env keys and runtime resolution; "classifies Prisma resource diffs as updates or replacements" (`:959`); read for adoption (`:1387`); 404 on delete is gone (`:1685`); greenfield reconcile of every resource (`:1850`); custom domains (`:2046-2268`); "starts a direct deployment only after observing status" (`:2319`); EnvironmentVariable: ignores branch overrides, refuses system-managed, live ownership check before delete, local validation (`:2435-2869`); updates mutable resources from observed state (`:2943`); Project/Database/Branch default protection (`:4279-4992`). |
| `SourceConventions.test.ts` (249) | U, Lo | Pure | See section 2. |
| `Website/*.test.ts` | `Vite.test.ts`, `Foldkit.test.ts`, `CustomDomainDns.test.ts` Li; `Frameworks.local.test.ts`, `Vite.local.test.ts` Lo (Vite.local also Li); `PropSurface.test.ts` U | Stack | Websites compose `Prisma.Compute` (`src/Website/FrameworkSite.ts:11`), so a Compute refactor reaches these. |
| `ORM/*` | Mixed | | Prisma ORM; not affected. |

Fixtures relevant to the refactor: `fixtures/artifact-v1.bin`, `artifact-v2.bin`, `artifact-same-version.bin`, `artifact-archive.bin` (used by Compute and Deployment unit tests), `fixtures/Live.ts` (`expectGone` with 8 × 1 s, `expectProjectGone`, `forgetState`, `patchStateAttr`, `failureOf`, `markCreating`), `fixtures/ManagementApiContract.ts` (route inventory pinned from `prisma/pdp-control-plane` at commit `4a71a1f3500c02c6d6914f86435c251f95fda536`, `:6-8`).

---

## 2. Convention-enforcing tests and checks

### `test/Prisma/SourceConventions.test.ts`

Scans every `.ts` under `packages/prisma/src` (recursively) after stripping strings and comments (`:102-129`). Forbidden patterns (`:10-31`):

- "raw filesystem/path/os imports": `node:fs`, `node:fs/promises`, `node:path`, `node:os`, `pathe`
- "async/await"
- "Effect.promise"
- "raw Promise constructor" (`new Promise`)
- "raw fetch" (`fetch(`)
- "Effect.orDie"
- "legacy create/update lifecycle handlers": `/\b(?:create|update)\s*:\s*Effect\.fn\b/`
- "explicit output undefined create/update branch": any `output === undefined`, `output !== undefined`, `undefined === output`, `undefined !== output` anywhere in source
- "bare process.cwd()"
- "explicit any"
- "double unknown cast" (`as unknown as`)

Exceptions are per file and per rule (`:56-69`): `internal/ArchivePlatform.ts`, `internal/ArtifactFile.ts` (fs and async), `ComputeArchive.ts`, `ORM/Contract.ts`, `ORM/Migrate.ts` (cwd), `ORM/ContractBuilder.ts` (double cast), `ORM/OrmClient.ts` (any), `ORM/Postgres.ts` (async, Effect.promise). "Keep exceptions scoped to both a file and a rule so other conventions still apply." (`:54-55`).

Documentation rules for the resources listed in `documentedResources` (`:33-46`: Branch, Bucket, BucketAccessKey, Compute, App, Deployment, Connection, CustomDomain, Database, EnvironmentVariable, Project, SourceRepository):

- The file `<Resource>.ts` contains `export interface <Resource>Props` (`:139`).
- It contains `export const <Resource> = Resource<`, except Compute, which must be `export const Compute: Platform<` (`:140-144`).
- That export has a JSDoc block containing `### ` and `**Example:**` (`:146-160`).
- Every property of `<Resource>Props`, and of the extra config interfaces (`Compute`: `ComputeBuild`, `ComputeDev`, `ComputeProps`, `ComputeStaticBuild`; `Connection`: `ConnectionEnvOptions`; `Database`: `DatabaseDev`, `:48-52`), has JSDoc (`:183-193`).
- Every attribute in the third type argument of `interface <Resource> extends ...` has JSDoc (`:195-207`). The check reads the attributes only when they are an inline type literal.
- `ComputeProps` and `DeploymentProps` must not have a prop named `artifact` and must have `artifactPath` (`:214-235`): "keeps raw artifact bytes out of persisted resource props".
- `Types.ts` contains `export type RedactedDeploymentEnvironmentValue = "[redacted]"` and `envVars?: Record<string, RedactedDeploymentEnvironmentValue>` (`:237-248`).

A new resource file is checked by the pattern scan automatically, but must be added to `documentedResources` by hand to get the doc checks.

### `test/Prisma/PublicSurface.test.ts`

- `Object.keys(Prisma)` equals the sorted `publicExports` list exactly (`:9-245`, `:297-312`). Adding, removing or renaming any root export (resource, provider, tagged error, operation helper) means editing this list. Currently listed Compute/Deployment-related exports include `Compute`, `ComputeProvider`, `ComputeDevProvider`, `isCompute`, `App`, `AppProvider`, `Deployment`, `DeploymentProvider`, `EnvironmentVariable`, `EnvironmentVariableProvider`, `MAX_DEPLOYMENT_ARTIFACT_BYTES`, the error tags `ComputeDeploymentRecoveryFailed`, `ComputeEnvironmentRollbackFailed`, `ComputeEnvironmentVariableNotOwned`, `ComputeEnvironmentVariableSystemManaged`, `ComputeNotReady`, `ComputeUrlTimeout`, `DeploymentConflict`, `DeploymentInvalidProps`, `DeploymentOperationFailed`, `DeploymentUnexpectedResponse`, `PrismaDeploymentDeleteFailed`, `PrismaDeploymentFailed`, and the helpers `waitForDeploymentStatus`, `waitForDeploymentUrl`, `destroyDeployment`, `destroyApp`, `destroyProjectApps`, `syncComputeEnvironment`, `readUploadArtifact`, `uploadArtifact`, `validateDeploymentArtifactBytes`, `promoteApp`, `rollbackApp`, `startDeployment`, `stopDeployment`.
- Every root `.ts` file in `packages/prisma/src` must be `index.ts` or appear in `publicPrismaDeepImports` (`:247-281`, `:354-367`): "keeps Prisma root modules intentionally classified". A new root module, for example a split-out `ComputeDeployment.ts`, fails this until listed. Internal helpers belong in `src/internal/`.
- Each deep import `@alchemy.run/prisma/<Module>` resolves and is non-empty (`:314-340`), and `compute.Compute.Type` is `"Prisma.Compute"` (`:331`).
- `removedPrismaDeepImports` = `ComputeApp`, `ComputeService`, `ComputeVersion`, `ComputeVersionObserve` must not resolve (`:287-292`, `:342-346`). These are remnants of an earlier split of Compute.
- `Credentials`, `PrismaDevDatabase`, `Refs` must not resolve as root deep imports (`:285`, `:348-352`).
- `package.json` `publishConfig.exports["./internal/*"]` is `null` (`:369-378`); `exports["."]` is `./src/index.ts`, `exports["./ORM"]` is `./src/ORM/index.ts`, `exports["./*"]` is `./src/*.ts` (`:380-392`).

### `test/Prisma/ManagementCoverage.test.ts`

- `canonicalComputeOperations` (`:9-27`): `listApps`, `getApp`, `createApp`, `updateApp`, `deleteApp`, `promoteApp`, `rollbackApp`, `listAppDomains`, `createAppDomain`, `listAppDeployments`, `createAppDeployment`, `getDeployment`, `deleteDeployment`, `startDeployment`, `stopDeployment`, `getDeploymentLogsRequest`, `getBuildLogsRequest` must be keys of `PrismaManagementClient` (type check) and exported from the package root (`:242-246`).
- `lifecycleResources` maps route groups to resources and asserts `resource.Type === "Prisma.<name>"` (`:29-151`, `:186-191`). Deployment owns `GET/POST /v1/apps/{appId}/deployments`, `GET/DELETE /v1/deployments/{deploymentId}`, `POST .../start`, `POST .../stop`, `GET .../logs` (`:107-119`). App owns `/v1/apps` CRUD (`:96-106`). EnvironmentVariable owns `/v1/environment-variables` CRUD (`:130-140`). `POST /v1/apps/{appId}/promote` and `/rollback` are "operation-only" routes (`:153-155`), not owned by a resource. Compute is not in the list: it owns no route group.
- Lifecycle plus operation-only routes must equal the 78 routes of the pinned contract, with no deferred routes and no `/__admin` routes (`:209-224`).

### Repository-wide checks

- `pnpm lint:tests` (`package.json:66`): `oxlint -c oxlint.tests.config.ts packages/alchemy/test packages/integration-tests/test packages/better-auth/test`, rule `alchemy-test/require-kind-tag` (`oxlint.tests.config.ts:11`, `scripts/oxlint/test-tags.ts:1-9`): "every alchemy-test test must carry one of the kind tags `unit`, `local` or `live`, on the test itself or an enclosing `describe`." Fixtures are ignored (`oxlint.tests.config.ts:9`). Part of `pnpm lint` (`package.json:65`), which CI runs (`.github/workflows/check.yml:63`).
- `pnpm lint` also runs `oxlint -c oxlint.config.ts` with type-aware Effect rules on source (`effecttsgo/*`, e.g. `catch-all-tag-dispatch-to-catch-tag`, `catch-if-tag-to-catch-tag`, `effect-fn-opportunity`, `crypto-random-uuid-in-effect`; `oxlint.config.ts:29-57` onward).
- `pnpm exports:check` (`package.json:34`, `scripts/sync-exports.ts:1-7`): fails if any package's export map is out of date, "or if package source or an example imports another package's internal". CI: `check.yml:87`. Fix with `pnpm exports:sync`.
- `pnpm docs:check-jsdoc` (`package.json:33`, `scripts/fix-api-jsdocs.ts:1-3`): metadata tags (`@resource`, `@product`, …) last in the block, and no legacy `@section` / `@example` tags. `prisma` is in its package list. CI: `check.yml:84`. Fix with `pnpm docs:fix-jsdoc`.
- `pnpm docs:check` (website build with diff-block and link checks). CI: `check.yml:97`.
- `pnpm lint:providers` (`scripts/lint-providers.ts:11-20`): fails if `providers()` ends up with `unknown` or `any` in its Layer requirements. CI: `check.yml:59`.
- `pnpm typecheck` / `pnpm exec tsrs -b`. CI: `check.yml:54`. Also `pnpm format:check` (`check.yml:48`).
- CI does **not** run any Prisma test suite. The only integration suites in `check.yml` are `test/Domain` and `test/Cli/ProviderCheckEnv.test.ts` (`:75-81`). Prisma tests run only on a developer machine.

---

## 3. Running the Prisma suites

From the repo root (AGENTS.md:1174-1196):

```sh
pnpm test:integration test/Prisma --profile testing
pnpm test:integration test/Prisma/Compute.live.test.ts --profile testing --retry 0
pnpm test:integration test/Prisma -t "triggers" --profile testing
pnpm test:integration test/Prisma --tags 'unit' --profile testing   # tag filter, packages/alchemy-test/src/cli.ts:62-64
```

`pnpm test:integration` runs `pnpm ensure:built && cd ./packages/integration-tests && bun alchemy-test` (`package.json:50`). Paths are relative to `packages/integration-tests`. Runner defaults: `--timeout 120000`, `--retry 2`, `--concurrency 32` (AGENTS.md:1224-1226). Per-test logs go to `packages/integration-tests/.alchemy/log/test/` (harden skill step 2). Default stage is `test_$USER`, or `test_$USER_<worktree>` in a linked worktree (AGENTS.md:1222).

Credentials:

- Profile: `alchemy profile edit --add Prisma`, stored at `~/.alchemy/credentials/<profile>/prisma-stored.json` (`website/src/content/docs/prisma/setup.mdx:39-41`). Use `--profile testing`.
- Environment: "In CI (`CI=true`), profiles are bypassed. Set `PRISMA_SERVICE_TOKEN` or `PRISMA_API_TOKEN`" (`setup.mdx:43-44`). `AuthProvider.test.ts:56-69` pins that order.
- Endpoint override: `PRISMA_API_URL`, preferred over `PRISMA_MANAGEMENT_API_URL` (`PrismaEnvironment.test.ts:54-64`).
- `scripts/with-fake-profiles.sh:53-54` sets a fake `PRISMA_SERVICE_TOKEN` for local-tag runs only; it does not redirect cloud APIs.
- Composer-side memory says the PDP token is in `~/.config/prisma-compose/deploy.env`; nothing in this repository refers to it.

No Prisma-specific test account setup exists in the repo: no helper, no standing project, no entitlement flag. Each live test creates its own `Prisma.Project` with `createDatabase: false` and destroys it. Env flags in the suites: `ALCHEMY_RUN_LIVE_PRISMA_CLEANUP`, `PRISMA_CLEANUP_PROJECT_ID`, `PRISMA_CLEANUP_APP_ID`, `PRISMA_CLEANUP_DEPLOYMENT_ID` (manual cleanup tool, `Compute.live.test.ts:23-36`), `NO_DESTROY` (`BucketBinding.test.ts:292`, `Hyperdrive.test.ts:53`), `DEBUG` (log level). The cleanup hint at `Compute.live.test.ts:148` says `pnpm test test/Prisma/...`, which is stale; it should be `pnpm test:integration`.

Timeouts in use: App, Bucket, Database logical-ID cases 180 s; Compute live 600 s; IsolatedProjectCompute 1,200 s; Hyperdrive 300 s; static site 120 s. These exceed the speed doctrine's "Per-test timeout ≤ 90–120s" (AGENTS.md:153) and are justified by Prisma Compute deploy times (`IsolatedProjectCompute.test.ts:63`).

Leak cleanup: `pnpm nuke` / `pnpm clear:state --profile testing` (AGENTS.md:1207-1210). `stacks/src/nuke.ts:13,33` includes `Prisma.providers()`. Scoped census: `pnpm nuke --profile testing --include 'Prisma.*' --dry-run --no-input` (harden skill step 1).

---

## 4. Docs

### Hand-written hub: `website/src/content/docs/prisma/`

| Path | Title | Content |
| --- | --- | --- |
| `index.mdx` | Prisma | Hub: Prisma Postgres plus Compute, quick example with `Prisma.Compute`. |
| `what-is-prisma.mdx` | What is Prisma? | Concepts: workspace, project, Postgres, connection, branch, Compute apps (`:73-83`), deployments (`:85-89`), buckets. |
| `workspaces-and-tokens.mdx` | Workspaces and tokens | Workspace, service token, per-app connections. |
| `setup.mdx` | Setup | Service token, profile, CI env vars. |
| `tutorial/part-1.mdx` … `part-4.mdx` | Your First Project; An HTTP API; Query Postgres; A Vite Frontend | Part 2 deploys an Effect-native `Prisma.Compute` with `destroyOldDeployment: true` (`part-2.mdx:34`, `:118`). Only four parts; the skill's bar is five. |
| `compute/apps.mdx` | Apps | `Prisma.Compute` for framework builds, static sites, Effect-native apps, `Prisma.CustomDomain`, local dev. |
| `compute/deployments.mdx` | Deployments | The deployment lifecycle (quoted below). |
| `data/postgres.mdx`, `data/branches.mdx`, `data/connections.mdx`, `data/buckets.mdx`, `data/drizzle-postgres.mdx` | Postgres; Branches; Connections; Buckets; Drizzle Postgres on Prisma Compute | Data resources. |
| `frontend/websites.mdx` + 14 framework pages (`astro`, `foldkit`, `nextjs`, `nuxt`, `octane`, `react-router`, `solidstart`, `static-site`, `sveltekit`, `tanstack-start`, `vinext`, `vite`, `vocs`, `waku`) | Websites, one per framework | `Prisma.Website.*`, which builds on Compute. |
| `guides/cloudflare-workers.mdx` | Connect from Cloudflare Workers | Connect binding or Hyperdrive. There is a `guides/` directory, which docs.md says the hub should not have. |

Sidebar wiring: `website/astro.config.ts:1711-1773`. llms: `website/scripts/generate-llms-txt.ts:243-264` ("Prisma — Compute" covers `prisma/compute`).

Pages describing Compute: `index.mdx`, `what-is-prisma.mdx`, `compute/apps.mdx`, `compute/deployments.mdx`, `tutorial/part-2..4`, the frontend pages. Deployments: `compute/deployments.mdx`, `what-is-prisma.mdx:85-89`. Apps: `compute/apps.mdx` (it means Compute, not `Prisma.App`). Environment variables: only `compute/apps.mdx:40-44` (system-managed `DATABASE_URL`) and `compute/deployments.mdx:72-112`. **No hub page shows `Prisma.App` or `Prisma.EnvironmentVariable`.** `Prisma.Deployment` appears only in `deployments.mdx:86-107`.

What the docs promise (`compute/deployments.mdx`):

- `:7-12`: "When the artifact or deployment configuration changes, `Prisma.Compute` creates a new generation and walks it through a fail-closed sequence: upload the artifact, start the candidate, verify its preview health endpoint, promote it, confirm the app reports it as latest, verify the stable endpoint — and only then touch the previous deployment."
- Health checks, `:34-36`: "`healthCheck.path` gates promotion. If the candidate never becomes healthy, alchemy attempts to destroy it without changing the stable deployment."
- Rollback, `:47-53`: "When promotion succeeds but the stable endpoint fails verification, alchemy attempts to restore the previous deployment. ... If recovery cannot converge—or no safe rollback target exists—alchemy fails the deploy, preserves the generations needed for recovery, and retries recovery before making further cloud changes. Terminally failed deployments are never restarted or selected as rollback targets."
- Old-generation cleanup, `:57-59`, `:69-70`: "By default the previous deployment is kept (stopped) after a successful promotion. `destroyOldDeployment: true` deletes it once the replacement is fully promoted and healthy" and "If cleanup fails, alchemy records the pending action in state and retries it before creating another generation."
- Env-only redeploys, `:74-76`: "`skipCodeUpload: true` creates the next deployment from the currently promoted artifact. It requires an existing promoted deployment and is useful when only environment variables changed".
- Low-level `Prisma.Deployment`, `:88-97`: "The low-level `Prisma.Deployment` resource owns no environment variables, so it cannot see an env-value change on its own. Prisma also snapshots environment variables into a deployment when the deployment is created ... Declare the values the deployment must be recreated for with `triggers`. When the resolved value changes, the next deploy replaces the deployment (create-before-delete) even though the artifact is unchanged". And `:109-112`: "The values are folded into the deployment fingerprint as a salted hash and persisted `Redacted` ... `Prisma.Compute` needs no equivalent — it owns `env` and already folds those values into its own fingerprint."
- No-op, `:116-119`: "when the built artifact and configuration are unchanged, reconcile reuses the same healthy deployment instead of creating a new generation — repeat deploys converge to exactly one active deployment."
- `what-is-prisma.mdx:87`: "Each change to an app becomes a **deployment**. The new deployment starts next to the old one, must pass its **health check**, and only then takes traffic. If it fails after taking over, Alchemy restores the one before."

### Generated API reference: `website/src/content/docs/providers/Prisma/`

Not present: the directory is gitignored (`website/.gitignore:10`, `src/content/docs/providers/`), and the audit procedure says "The generated pages under `website/src/content/docs/providers/` are gitignored — remove any a contributor committed." (`procedure.md:136-138`). `pnpm docs:gen` would write one page per JSDoc-tagged export in `packages/prisma/src` (`scripts/generate-api-reference.ts:117-119`): `@resource` App, Branch, Bucket, BucketAccessKey, Compute, Connection, CustomDomain, Database, Deployment, EnvironmentVariable, Postgres, Project, SourceRepository, ORM Contract, ORM Migrate, and 14 `Website/*`; `@binding` Connect, ReadBucket, WriteBucket, ReadWriteBucket, ORM Postgres. The hub links `/providers/prisma/compute`, `/providers/prisma/deployment`, `/providers/prisma/customdomain` (`deployments.mdx:128-129`, `apps.mdx:157-158`).

What the source JSDoc (and so the generated pages) says about the low-level resources and when to pick them:

- `Deployment.ts:197-213`: "A Prisma deployment owned by an App. This is the low-level resource: it can upload or reuse an artifact, start it, and promote it, but it does not provide `Prisma.Compute`'s preview/stable health checks or automatic rollback. Prefer `Prisma.Compute` for production application deployments." It also says that after a crash that loses state, Alchemy "deliberately does not adopt the App's latest deployment". Examples use `app: app.appId` with `skipCodeUpload` or `artifactPath`, `start: true`, `promote: true` (`:215-232`). `triggers` JSDoc: "when any resolved value changes, a replacement deployment is planned (create-before-delete) even if the artifact is unchanged — the same contract as `AWS.ApiGateway.Deployment.triggers`" (`:108-122`). Attributes include `artifactHash` and `triggersHash` (`:175-183`).
- `App.ts:143-151`: "A Prisma App, the long-lived application configuration that owns deployments. ... Use `Prisma.Compute` for the usual build, deployment, health-check, and promotion workflow; use `App` directly when managing standalone `Prisma.Deployment` resources." It documents `App.lookup` (`:168-176`).
- `EnvironmentVariable.ts:116-145`: "A Prisma compute environment variable. Values are write-only in Prisma. Alchemy stores them as `Redacted` values and reapplies the desired value to repair drift." Examples for a project-level production variable and a preview branch override. No guidance on when to use it instead of `Compute.env`.
- `Compute.ts:679-688`: Prisma's create-deployment API "exposes neither an idempotency key nor a caller-defined recovery key"; Alchemy "does not guess that the App's latest deployment is owned". Sections: Deploying an App, Bundling & Tree-shaking, Runtime Bindings, build and artifact examples ("Build before upload and replace old versions" at `:768`), Deployment Health (`:819`), Local Development (`:834`). Props: `skipCodeUpload` "Create the next deployment by reusing the previous code artifact" (`:498-503`), `start` (default true), `skipPromote` (default false), `destroyOldDeployment` "Delete the previously promoted deployment after the new one is promoted. @default false" (`:517-522`). Validation messages: "destroyOldDeployment cannot be combined with skipPromote because the previous deployment stays active when promotion is skipped." (`:1222`), "start: false requires skipPromote: true ..." (`:1228`).

---

## 5. Examples and stacks using the Prisma provider

| Directory | Prisma resources used | Test |
| --- | --- | --- |
| `examples/prisma-compute-effect` | Compute (class form `Prisma.Compute<Api>()`, `src/Api.ts:12`, `destroyOldDeployment: true` at `:28`), Project, Postgres, Connection, Connect, ConnectBinding | none |
| `examples/prisma-tanstack-start` | Compute (`alchemy.run.ts:93`, `destroyOldDeployment: true` at `:133`), Project, Postgres, Database, Connection, CustomDomain | none |
| `examples/prisma-tutorial` | Compute (`src/Api.ts`, `destroyOldDeployment: true` at `:19`), Project, Postgres, Connection, Connect, ConnectBinding, Website.Vite | `test/integ.test.ts` |
| `examples/prisma-website-{astro,foldkit,nextjs,nuxt,octane,react-router,solidstart,static,sveltekit,tanstack-start,vinext,vite,vocs,waku}` | One `Prisma.Website.<Framework>` each (`static` uses `Website.StaticSite`), which composes Compute | `test/integ.test.ts`; vinext also `test/dev.test.ts` |
| `examples/cloudflare-neon-prisma`, `examples/cloudflare-neon-prisma-psl` | Prisma ORM only (`Prisma.Contract`, `Prisma.Migrate`) | `test/integ.test.ts` |
| `stacks/src/nuke.ts` | `Prisma.providers()` only (`:13`, `:33`) | n/a |

No example uses `Prisma.App`, `Prisma.Deployment` or `Prisma.EnvironmentVariable`. All Prisma examples are registered in the root `tsconfig.json` (`:377-503`), but none is in the default list of `scripts/test-examples.ts` (`:39` onward has no Prisma entry), so `pnpm test:examples` does not run them unless named.

---

## 6. Checklist for a refactor of this size

### Reconciler doctrine (AGENTS.md:394-442)

- [ ] One observe → ensure → sync → return flow. "A reconciler MUST work correctly for all three combinations. It MUST NOT branch the body on `output === undefined`" (`:406`). "**Do not write `if (output === undefined) { /* create body */ } else { /* update body */ }`.**" (`:429`). `SourceConventions` rejects any `output === undefined` text in `packages/prisma/src`.
- [ ] "**Observation > assumption.** Cloud state is authoritative. `olds` is at most a hint" (`:422`). "`output` is treated as a cache for stable identifiers ... NOT a guarantee that the resource still exists." (`:424`)
- [ ] "**Each sync step is independently idempotent.** Crash mid-reconcile, re-run, you converge." (`:423`)
- [ ] Conflict and not-found style errors are caught as races (`:425`).
- [ ] Diff: "You should almost never use `no-op` in the Diff. ... Usually you want diff to return `undefined` or `void` to let the engine apply the default update logic." (`:386`). Narrow `Input<Props>` with `isResolved(news)` before property access, and never declare `Input<T>` in Props (`:181`). Moving `Prisma.Deployment` from replace-on-artifact-change to update-in-place means `diff` stops returning `replace` for artifact and `triggers` changes and the stable `deploymentId` (`Providers.test.ts`) must be revisited: the platform deployment ID changes on each new version while the resource identity stays.
- [ ] Known engine bug: "a deploy that *replaces* a resource while simultaneously *removing* its old dependency deadlocks" (`:155`). Relevant if Compute's composition changes which children exist across a deploy.
- [ ] Block until ready (alchemy-provider SKILL.md:390-395). Identity changes replace (`:396-398`). "Missing is not forbidden. Only a typed not-found tag means 'gone'." (`:399-402`). Lists paginate and fail loudly (`:403-405`). `read` and `delete` work when `olds` or parts of `output` are missing (`:415-418`). Implement `list` for nuke with `nuke: { dependsOn: [...] }` (`:428-430`).

### Typed errors (AGENTS.md:893-964)

- [ ] "Every error a distilled operation can produce in practice MUST be a tagged error in that operation's **type-level** error union." (`:895`)
- [ ] "**When you hit an unmatched error** ... the fix is ALWAYS a distilled patch, never a catch in alchemy" (`:897`). Use a meaningful resource-specific tag.
- [ ] Forbidden: `unknown`-typed `_tag` predicates, widening casts to duck-typed tags, catching the catch-all HTTP error by status (`:937-949`). "If `Effect.catchTag("SomeTag", ...)` fails to typecheck, that is the signal that distilled's union is missing the error — patch distilled" (`:964`).
- [ ] review.md §3: no `"Forbidden"` in a not-found path, no message string matching, no hand-written HTTP outside presigned URLs (the artifact upload URL qualifies, with a comment saying so), no `Unknown*Error`/`HttpError` handling, no list that swallows errors.
- [ ] Audit procedure: "tagged errors, never `Effect.fail(new Error(...))`" (`procedure.md:87`). Note that `Compute.test.ts:694` currently asserts `expect(error).toBeInstanceOf(Error)` for a validation failure.

### Effect rules

- [ ] "Do not use `Effect.orDie` in the lifecycle operations since this will crash the whole IaC engine." (AGENTS.md:768). Enforced on all of `packages/prisma/src` by `SourceConventions`.
- [ ] "**Never use `async`/`await`, raw `Promise`, `node:fs/promises`, `node:fs`, `node:os`, or `pathe` directly in resource code.**" (`:772`). Use `FileSystem.FileSystem`, `Path.Path`, `HttpClient`, `Effect.sleep`, `Config`. Wrap sync Node APIs in `Effect.sync` (`:785`). "Environment variables are configuration: read them through `effect/Config`, never `process.env`" (`:794`). "This applies to **lifecycle operations, helpers, AND tests**." (`:796`)
- [ ] review.md §2: no nested `f(yield* x)`; `orDie` only in credential and layer wiring; no `Effect.promise` / `catchCause`; no `as unknown as` / `as any`.
- [ ] Bounded retries: "`times ≤ 8–10`, total backoff under ~45–60s" (AGENTS.md:154). Poll with `Effect.repeat` and a `Schedule`, never `while (Date.now() < deadline)` (`:1103`).

### JSDoc and generated docs

- [ ] "**Never edit the generated markdown files** under `website/src/content/docs/providers/{Cloud}/`." (AGENTS.md:189). Edit JSDoc, run `pnpm docs:check-jsdoc` then `pnpm docs:gen`.
- [ ] Every Prop and Attribute has JSDoc with `@default` (`:245-263`); `SourceConventions` enforces this for listed resources.
- [ ] Resource JSDoc uses `### <Section>` and `**Example:** <Title>`; "Keep all API-generator metadata tags ... together at the very end of the JSDoc block. Do not put prose, sections, or examples after them" (`:232-235`). Non-example `###` prose headings end with `<!-- api-prose -->` (`:273`).
- [ ] docs.md "Every page": "Every prop and attribute has JSDoc with its unit, allowed values, `@default`, and whether changing it replaces the resource." Long tail: "A `:::caution` for each prop whose change replaces the resource". A runtime such as Compute should reach "ten or more examples" (docs.md:50); Compute has 10 `**Example:**` blocks now.
- [ ] Hub pages to update: `compute/deployments.mdx` (the `triggers` section and its "replaces the deployment (create-before-delete)" claim, the "creates a new generation" framing, "kept (stopped)" default), `compute/apps.mdx` ("One resource covers the whole path"), `what-is-prisma.mdx:85-89`. Code on hub pages must come from tested examples or JSDoc (docs.md:151-153); whole files with a `// path` first line (`:154-157`); second person, no narrating internals (`:162-166`); "Docs-only PRs get a `docs(<scope>):` title" (write-docs SKILL.md:68).
- [ ] write-docs voice: "Never write about the page itself." (`:128`).

### Tests

- [ ] "Tag every test with its kind — `unit` ..., `local` ... or `live` ... alongside `provider:<cloud>` / `provider:<cloud>:<service>`. `pnpm lint:tests` enforces it." (AGENTS.md:845). Prisma uses `provider:prisma:compute`, `provider:prisma:deployment`, `provider:prisma:app`, `provider:prisma:environmentvariable`.
- [ ] "Start and end `test.provider` cases with `stack.destroy()`. ... Use deterministic resource identities and verify deletion through the cloud API." (`:846`)
- [ ] "Exercise create, update, redeploy, and removal through the stack. **Do not mock HTTP or SDK responses, invoke provider lifecycle methods directly, or call extracted reconciliation helpers as a substitute for a deployment.**" (`:847`)
- [ ] "For a partial-update regression, configure non-default neighboring settings, exercise the update, and verify that unrelated settings remain unchanged. Ensure the relevant update path actually runs." (`:849`). Directly applicable: a new-artifact deploy must prove the previous deployment is stopped and kept, and the new one promoted.
- [ ] "Do not extract one-off reconciliation functions or modules solely to make them directly testable." (`:850`)
- [ ] "Never use `Date.now()`, UUIDs or other random values when constructing the physical name of a resource." (`:865`)
- [ ] "Every resource has its own test file ... Deploying a resource as a dependency inside another resource's test does not count" (alchemy-provider SKILL.md:700-703). Today `Deployment.test.ts` is fake-only and `EnvironmentVariable` has no file; if Compute composes them, their own live suites are expected.
- [ ] "Assertions can fail. No always-true checks, no lists of acceptable tags, no early `return`" (SKILL.md:721-722).
- [ ] Audit: "A new one-off test file — especially one with mocks — fails the audit." and "Prove it fails on main" (`procedure.md:59-61`, `:144-154`): "an identical redeploy plans a no-op and never reaches `reconcile`".
- [ ] Every `Effect.retry`/`repeat` bounded; `exclusive` for process-global mutation (AGENTS.md:1240).
- [ ] Leaks: "Lifecycle tests ... must not silently adopt or directly delete leaked resources from earlier runs." (AGENTS.md:1212-1214). "A green test that leaves resources behind is a provider bug." (SKILL.md:881-882)
- [ ] Harden loop: two consecutive green runs with a clean census (`harden/SKILL.md:10-11`); root-cause order "Provider bug ... distilled patch ... test ... timeouts last" (`:40-50`); "Never widen a permission to make a test pass." (`:55`)
- [ ] Update the pinned convention tests in the same change: `PublicSurface.test.ts` export and module lists, `SourceConventions.test.ts` `documentedResources`, `Providers.test.ts` `expectedStables`, `ManagementCoverage.test.ts` route ownership.

### Package exports

- [ ] "Run `pnpm exports:sync` after adding or removing a directory; CI runs `pnpm exports:check`. Name a module nobody outside the package should import `internal.ts`, or put it under an `internal/` directory" (AGENTS.md:109). Prisma resolves `./*` to `./src/*.ts`, so a new root file is a public deep import and must be listed in `PublicSurface.test.ts`.
- [ ] review.md §1: `pnpm exports:check`, `pnpm lint:providers`, core untouched (`git diff origin/main --stat -- packages/alchemy/src` empty), no imports of another package's `internal`.
- [ ] Shared-file discipline for `Providers.ts` and `index.ts`: single minimal insertions (AGENTS.md:137).

### Pull requests

- [ ] "**Title**: Use conventional commit format (e.g. `fix(website): mobile theme metas`, `feat(aws/s3): add bucket lifecycle rules`)." (AGENTS.md:1369). Breaking changes carry `!` (e.g. `feat(prisma-cloud)!: …` in the Composer repo; the release-blog skill keys off "`!` in the title, or `Breaking`/`[!CAUTION]` in the body", `release-blog/SKILL.md:39`).
- [ ] "NEVER use `#` or `##` in the PR description. The smallest heading allowed is `###`. The PR description must NOT begin with its own title heading" (`:1370`). Summary is plain prose at the top (`:1407`).
- [ ] "**Prefer code snippets over prose.**" (`:1373`). Audit procedure: "Rewrite the description to show the developer experience", "For a fix or a changed API, a before/after `diff` of the user's code", "check every API signature in a snippet against the source" (`procedure.md:212-223`).
- [ ] "**Never include a 'Test plan', 'Testing', or checklist of TODOs.**" (AGENTS.md:1375)
- [ ] Draft rule: "If there are outstanding steps, manual testing required, or review items, DO NOT leave a comment on the PR and DO NOT include them in the PR description. Instead: 1. Mark the PR as **draft**. 2. Tell the user ... what is outstanding." (`:1390-1392`)
- [ ] Use `--body-file`, never an inline heredoc (`:1395-1404`).
- [ ] alchemy-provider SKILL.md:924-927: "Don't show a binding running in a host unless a test deploys it that way." and review.md §8 "no snippet claims behavior no test proves".
- [ ] Audit: "Leave every PR with CI passing." Run `pnpm exec tsrs -b`, `pnpm lint`, `pnpm format:check`, `pnpm docs:check-jsdoc` and `pnpm exports:check` before pushing (`procedure.md:180-185`). A distilled patch goes in its own distilled PR, and the submodule points at distilled `main` (`procedure.md:111-117`).

### Changelog and release blog for breaking changes

- [ ] CHANGELOG.md is generated from PR titles (changelogen, `.github/workflows/release.yml:114`) into `### 🚨 Breaking Changes`, `### 🚀 Features`, `### 🐞 Bug Fixes`, grouped by scope (`- **prisma**:`). Do not hand-edit it.
- [ ] Release blog: "Put breaking changes in a `:::caution` callout at the top." (AGENTS.md:1448). release-blog SKILL.md:85: "`:::caution` with **Breaking changes** at the top. Each item says what to do, with a `diff` snippet when code changes, and links its section below." Unmarked breaks are caught by words like "renamed", "removed", "replaces", "is gone", "now requires" in PR bodies (`:39-44`). Give the PR body a migration diff so the blog can copy it.

### Distilled

- [ ] "**Patch the SDK, never the consumer**" (AGENTS.md:130). Patches go under `submodules/distilled/packages/prisma/patches/...` for the OpenAPI-sourced provider, patching "the **OpenAPI document** upstream of the smithy conversion" (`:885`). Regenerate only that package (`pnpm generate <pkg>` in the submodule, SKILL.md:873). "Never run `pnpm` inside `submodules/distilled`" for oxfmt/tsrs (harden SKILL.md:136-142).

---

## 7. Processes, catalogs, design docs, and the API client

- `processes/` does not exist (`ls processes` → "No such file or directory"; `git ls-files | grep '^processes'` → nothing). AGENTS.md:1138 also points at `@processes/AWS.md`, which does not exist either. There is no `processes/Prisma/catalog/` and no `INDEX.md`, so review.md §0 coverage checks cannot run for Prisma.
- Design or planning documents: searching tracked `.md`/`.mdx` outside `website/` for files mentioning Prisma, Compute and Deployment returned only `CHANGELOG.md`, `examples/prisma-tanstack-start/README.md` and `examples/prisma-website-vinext/README.md`, none of which is a design document. `packages/prisma` has only `README.md` (69 lines, user-facing), `package.json`, `scripts/build.ts`, `tsconfig.json`; no `skills/` directory.
- API client: every resource file imports operations from `@distilled.cloud/prisma/management` and `Retry` from `@distilled.cloud/prisma`: `App.ts:1,8`, `Compute.ts:1,18`, `Deployment.ts:1,6`, `EnvironmentVariable.ts:1,9`, `ComputeLifecycle.ts:8`, `internal/DeploymentActions.ts:2`, `internal/AppPromotion.ts:5`, `internal/DeploymentObserve.ts:1`, and the other resources. `package.json:82` depends on `"@distilled.cloud/prisma": "workspace:*"`, linked to `submodules/distilled/packages/prisma` (`packages/prisma/tsconfig.json:17`, `pnpm-lock.yaml:12685`). The hand-written `src/Client.ts` (1,175 lines, `HttpClientRequest`-based) backs `Operations.ts:2` (the exported `listApps`, `promoteApp`, `rollbackApp`, … helpers) and supplies `PrismaApiError`, `isConflict` (re-exported by `ComputeLifecycle.ts:18`). So the rule applies to the resources. The submodule is pinned at `83e119cc026f84436d94036cbcaf91d37e2b9313` (`git ls-tree HEAD submodules/distilled`) but is not initialized in this checkout, so its Prisma service module and existing patches could not be inspected. CHANGELOG.md:898 records the earlier move: "Consume @distilled.cloud/prisma-postgres instead of the hand-rolled client" (beta.78).

---

## 8. Recent history

`git rev-parse --is-shallow-repository` → `true`; `git rev-list --count HEAD` → `1`. The clone has depth 1, and I did not fetch. The only commit is `01792ec3 apostoli 2026-11-11 fix(cloudflare/workers): report a Preview's Durable Object namespaces so its containers attach (#3085)`, so `git log -- packages/prisma` shows nothing specific to Prisma.

Prisma entries in CHANGELOG.md, with section, show the title style and the people changing the package:

| Release | Section | Entry |
| --- | --- | --- |
| beta.85 (`:251-253`) | Bug Fixes | "Custom domains attach to apps on any branch" by Will Madden and Sam Goodwin (#2696); "Update @prisma/dev to ^0.25.2" by Aman Varshney (#2730) |
| beta.84 (`:426`) | Bug Fixes | "Raise compute upload cap to 768 MiB" by Aman Varshney (#2257) |
| beta.82 (`:546`) | Features | "Identify App, Database, and Bucket by logicalId" by Kristof Siket and Sam Goodwin (#1849) |
| beta.82 (`:680-684`) | Bug Fixes | "Don't fail a replacement while the old deployment drains" by Kristof Siket (#1920); "Migrate prisma-tanstack-start to Prisma ORM v8 and ungate live Prisma tests" by Sam Goodwin (#2038); "Inherit database region from the project's default region" (#2026); "Publish prisma peer dependencies as version ranges" by Will Madden (#2154) |
| beta.80 (`:760`, `:827`, `:849`) | Features / Bug Fixes | "Add Effect-native Prisma ORM v8 support" (#1198); "Default dev commands to development mode" (#1703); "Add Website framework support" (#1683) |
| beta.78 (`:897-898`) | Features | "Consume @distilled.cloud/prisma-postgres instead of the hand-rolled client" by Will Madden and Sam Goodwin (#1290); "Deploy static apps with Compute" by Aman Varshney and Sam Goodwin (#1208) |
| beta.73 (`:1208`) | Features | "Object storage (resources + bindings), locked Postgres state backend, Deployment.redeployOn" by Will Madden (#1061) |
| beta.67 (`:1428`) | Bug Fixes | "Align provider with management api" by Aman Varshney (#1012) |
| beta.66 (`:1466-1467`) | Features | "Add Prisma provider" by Aman Varshney and Sam Goodwin (#416) |

No Prisma entry has ever been listed under "🚨 Breaking Changes" in CHANGELOG.md. There is no CHANGELOG entry for `triggers` or `destroyOldDeployment`. `Deployment.redeployOn` (beta.73) is the old name; the source now has only `triggers` (`grep redeployOn packages/prisma/src` finds nothing), and the rename was not announced as breaking.

Blog posts that mention Prisma: `2026-07-30-beta-66.md:239` (provider launch), `2026-08-06-beta-70.md:523` ("Prisma provider aligned with the management API"), `2026-08-25-beta-75.md:720-729` ("Prisma: object storage, locked Postgres state, and deploy triggers ... `Deployment.triggers` to force a redeploy when an opaque key/value (e.g. a rotated secret) changes"), `2026-09-17-beta-78.md:52-55` (inside the breaking-changes callout: "**`Prisma.Database` branch props are no longer nullable** ([#1582](...)) — Prisma's API now attaches every database to a Branch. Omit both `branchId` and `branchGitName` to use the project default."), `2026-09-29-beta-80.md:448` (Prisma ORM v8), `2026-10-22-beta-84.md:66-70` (breaking: "**Prisma and Neon env values use the runtime wire format**"), `2026-10-12-beta-83.md:620`. Pattern for a Prisma breaking change: one bold bullet in the `:::caution` **Breaking changes** callout, naming the API, citing the PR, and saying what to do. beta-85 (`2026-11-01-beta-85.mdx:33-66`) shows the current format, with `diff lang="typescript"` blocks for code changes.

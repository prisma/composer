# Prisma low-level primitives and shared helpers: inventory

Repository: `wip/alchemy`, package `packages/prisma` (`@alchemy.run/prisma`). All paths below are relative to `packages/prisma/src/` unless stated otherwise. Line numbers are from the checkout at the time of reading.

Scope: `App.ts`, `EnvironmentVariable.ts`, `Deployment.ts`, `ComputeLifecycle.ts`, `Operations.ts`, `PrismaEnvironment.ts`, `Branch.ts`, `CustomDomain.ts`, and every file in `internal/`. `Compute.ts` was read only to compare (mainly `ProviderLive`, lines 2175-2770, and the helpers it calls).

A note on API names. `App`, `EnvironmentVariable`, `Deployment`, `Branch` and `Compute` call the generated distilled SDK (`@distilled.cloud/prisma/management`), where an App is a "service" (`getService`, `createService`, `createServiceDeployment`, `createServicePromote`, `createServiceRollback`, `deleteService`). `CustomDomain` and `Operations.ts` still use the older hand-rolled client in `Client.ts`, whose routes say `/v1/apps/...` (`Client.ts:1022-1075`). The distilled submodule is not checked out in this worktree (`submodules/distilled` is empty), so I could not confirm the distilled HTTP routes. Error messages in the code name `/v1/services/{id}`, `/v1/services/{id}/rollback` and `/v1/deployments/{id}` (for example `Compute.ts:2315`, `Compute.ts:2429`, `ComputeLifecycle.ts:128`).

---

## 1. App (`App.ts`)

Type `"Prisma.App"`. Binding contract: `never` (`App.ts:129`). Lookup key: `AppLookup { appId }` (`App.ts:138-141`).

### Props (`App.ts:54-86`)

| Prop | Type | Default | Change behaviour |
|---|---|---|---|
| `project` | `string \| Project` | required | Concrete id change: **replace** (`App.ts:303-309`). |
| `displayName` | `string?` | `createPhysicalName({ id })` (`App.ts:209-210`) | **update** (`updateService` with `displayName`). |
| `regionId` | `PrismaRegionId?` | omitted from `createService`, so the API picks (doc says project default, else `us-east-1`) | Change **fails diff** with `AppInvalidProps` ("region is immutable"), not a replace (`App.ts:310-317`). |
| `branchId` | `string?` | project default branch | **update** (`updateService` with `branchId`). Mutually exclusive with `branchGitName` (`App.ts:278-282`). |
| `branchGitName` | `string?` | project default branch | **update**. |
| `logicalId` | `string?` | the resource FQN (`App.ts:402`) | **update** (`App.ts:318-323`). |

`null` for `branchId` / `branchGitName` is rejected (`App.ts:283-288`): an App must always be attached to a branch.

### Attributes (`App.ts:91-128`, built by `attrsFrom` at `App.ts:252-262`)

`appId`, `name`, `projectId`, `regionId`, `branchId: string | null`, `latestDeploymentId: string | null`, `appEndpointDomain: string`, `createdAt`, `logicalId: string | null`.

Stable properties: `["appId"]` (`App.ts:296`).

### diff (`App.ts:298-356`)

1. If `news` is not a plain object (an unresolved Output), return `undefined`.
2. If `output.appId` is a `dev:` id, return `update`.
3. Concrete project id changed: `replace`.
4. Resolved `regionId` differs from `output.regionId ?? olds.regionId`: fail with `AppInvalidProps`.
5. Resolved `logicalId ?? fqn` differs from `output.logicalId` (or `olds.logicalId ?? fqn` when no output): `update`.
6. If `displayName` / `branchId` / `branchGitName` are not all resolved: `undefined`.
7. No `output`: deep-compare desired against `olds`; differ means `update`.
8. `output.name !== displayName`: `update`.
9. Resolve the desired branch with `desiredBranchId` (this **calls the API at plan time**: `getProjectBranches`). Unresolved branch or `output.branchId` mismatch: `update`; otherwise `undefined`.

### read (`App.ts:365-397`)

1. If `output.appId` is concrete: `getService({ serviceId })`, `NotFound` becomes `undefined`.
2. Otherwise search the project: `findAppByLogicalId(projectId, olds.logicalId ?? fqn, olds)` (`App.ts:230-239`), which resolves the branch and calls `getServices({ projectId, logicalId, branchId })`.
   - A match is "proven owned" only when `olds.displayName` is undefined and the App's name equals the generated physical name for this instance (`App.ts:377-379`).
   - With an explicit `logicalId`, there is no further fallback (`App.ts:385`).
   - With a derived logical id, fall back to `findApp` by display name on the desired branch (`App.ts:212-228`); more than one match fails with `AppConflict`.
3. Return the attributes, wrapped in `Unowned(...)` unless found by `appId` or proven owned (`App.ts:396`).

Read by `appId` does not check project or region identity.

### lookup (`App.ts:357-363`)

`getService({ serviceId: appId })`; `NotFound` returns `undefined`.

### reconcile (`App.ts:398-487`)

1. `validateAppProps` (mutually exclusive branch fields, no `null`).
2. Resolve `projectId`, `displayName`, `logicalId = news.logicalId ?? fqn`.
3. `desiredBranchId(projectId, news)`. Unresolved fails with `AppOperationFailed` ("no default branch" or "no branch named").
4. Observe: if `output.appId` is concrete, `getService`; `NotFound` means missing.
5. Ensure: if missing, `createService({ projectId, displayName, branchId, regionId?, logicalId })` with `Retry.none` (`App.ts:420-449`). On `Conflict`:
   - if an App with this logical id exists on the branch: fail `PrismaAppLogicalIdTaken`;
   - else if `findApp` by display name returns the App whose id equals `output.appId`: continue with it;
   - else fail `AppConflict`.
6. `ensureAppImmutableIdentity(app, projectId, news.regionId ?? output.regionId ?? app.region.id)` (`App.ts:452-456`).
7. If the name differs or `branchNeedsSync` (`App.ts:264-274`) is true: `updateService({ serviceId, displayName, branchId })`.
8. If `app.logicalId !== logicalId`: when one is set, `updateService({ logicalId: null })` first (the API refuses to rebind), then `updateService({ logicalId })`. A `Conflict` becomes `PrismaAppLogicalIdTaken`. This is done after the branch move because "the API refuses logicalId in the same request as a branch move" (`App.ts:472-473`).
9. Post-condition check: name and branch must match, else `AppUnexpectedResponse` (`App.ts:481-485`).
10. Return `attrsFrom(app)`.

No retries other than the distilled default retry policy (create opts out). No waits.

### delete (`App.ts:488-501`)

1. `dev:` id: return.
2. `getService`; `NotFound`: return.
3. Project or region differs from state: fail `AppConflict`.
4. `destroyApp(output.appId)` (`ComputeLifecycle.ts:259-289`): `deleteService` up to 5 attempts; `NotFound` counts as deleted; `Conflict` sleeps `250ms * 2^attempt` (250, 500, 1000, 2000 ms) then retries; on the fifth `Conflict` the error propagates.

What happens to deployments: nothing is stopped first. The comment says "The canonical App delete endpoint cascades its deployments" (`ComputeLifecycle.ts:257`). If the platform answers `Conflict` while deployments drain for longer than about 3.75 seconds, delete fails with a raw `Conflict`; it is **not** mapped to `Provider.DeleteInProgress` (contrast `Deployment.delete`, below).

### list (`App.ts:297`)

`listApps()` with no filter: every App visible to the token. This is the single nuke enumerator for Apps and their deployments (`Deployment.ts:492-494`, `Compute.ts:2181-2183`).

### appEndpointDomain and latestDeploymentId

- `appEndpointDomain: string` comes from the App record itself, so it is known as soon as `createService` returns, before any deployment exists (`App.ts:259`, `internal/Observed.ts:92`).
- `latestDeploymentId` is a snapshot from the App's last reconcile or read. Nothing in `App.diff` reacts to it, so after a `Deployment` promotes, the App's attribute stays stale until the App is reconciled or refreshed again.

### Local provider (`App.ts:506-517`)

`devProvider(App, ["appId"], ...)`: `appId: "dev:app:<id>"`, `name: displayName ?? id`, `regionId ?? "us-east-1"`, `branchId ?? null`, `latestDeploymentId: null`, `appEndpointDomain: "localhost"`, `createdAt: "1970-01-01T00:00:00.000Z"`, `logicalId ?? fqn`. Registered with `ProviderLayer.dual` (`App.ts:519-523`).

---

## 2. Deployment (`Deployment.ts`)

Type `"Prisma.Deployment"`. Binding contract: `never`. No lookup.

### Props (`Deployment.ts:69-147`)

| Prop | Type | Default | Change behaviour |
|---|---|---|---|
| `app` | `string \| App` | required | Concrete id change: **replace**. Note the type does not accept `Compute`. |
| `portMapping` | `{ http?: number \| null }?` | omitted from the create call | Deep change: **replace**. `http` must be an integer 1-65535; `null` resets to 8080 (`Deployment.ts:584-594`). |
| `skipCodeUpload` | `boolean?` | `false` | Change: **replace**. |
| `artifactPath` | `string?` | none | Path string change: **replace**. File content change (hash): **replace**. |
| `artifactContentType` | `string?` | `"application/octet-stream"` | Change: **replace**. |
| `start` | `boolean?` | `false` (but `promote` implies start: `news.start ?? news.promote ?? false`, `Deployment.ts:706`) | **update**. |
| `promote` | `boolean?` | `false` | **update**. `promote: true` with `start: false` is rejected (`Deployment.ts:605-609`). |
| `triggers` | `Record<string, unknown>?` | none | Fingerprint change: **replace**. |

Exactly one of `artifactPath` or `skipCodeUpload: true` is required (`Deployment.ts:595-604`).

### Attributes (`Deployment.ts:152-192`, `attrsFrom` at `Deployment.ts:283-301`)

`deploymentId`, `appId`, `foundryVersionId`, `status: string | undefined`, `previewDomain: string | null | undefined`, `artifactHash?: string`, `triggersHash?: Redacted<string>`, `appEndpointDomain: string | undefined` (set only when this reconcile promoted, else carried from `output`), `createdAt`.

Stable properties: `["deploymentId"]` (`Deployment.ts:491`).

### diff: exactly when it returns what (`Deployment.ts:495-561`)

In order:

1. `news` unresolved Output: `undefined`.
2. `output.deploymentId` is `dev:`: `update`.
3. `output.status === "failed"`: **replace** ("Foundry's failed status is terminal", `Deployment.ts:500-506`). This depends on the status in `output`; whether the engine refreshes `output` through `read` before `diff` on a normal deploy is engine behaviour I did not verify.
4. `triggersChanged(news.triggers, output.triggersHash)` is true: **replace**. This check runs before step 5 on purpose, because a deferred diff would fall back to an update that keeps the running deployment (`Deployment.ts:507-512`).
5. If `portMapping`, `skipCodeUpload`, `artifactPath`, `artifactContentType` are not all resolved: `undefined` (engine default, an update).
6. Compute `newArtifactHash = artifactHashOf(...)` (this **reads and SHA-256-hashes the whole artifact file at plan time**, `Deployment.ts:391-401`). **Replace** when any of these holds: concrete app id changed; `portMapping` deep-differs from `olds.portMapping` (both default `{}`); `skipCodeUpload` differs (default `false`); `artifactPath` string differs; `artifactContentType` differs; `newArtifactHash` is defined and differs from `output.artifactHash`.
7. If `start` / `promote` are not resolved: `undefined`.
8. If `start` or `promote` is true: **update, on every deploy**, so reconcile re-asserts the lifecycle state and repairs external stops and routing drift (`Deployment.ts:549-553`).
9. If `start` or `promote` changed from `olds` (both false now): `update`.
10. Otherwise `undefined` (no change).

### triggers and the fingerprint

- Hash: `sha256Object({ salt: "alchemy/Prisma.Deployment/triggers/v1", triggers: unwrapRedacted(triggers) ?? null })` (`Deployment.ts:408-425`). `unwrapRedacted` recursively unwraps `Redacted` values in arrays and objects (`Deployment.ts:410-419`).
- Stored as `triggersHash: Redacted.make(hash)` (`Deployment.ts:621-624`); undefined when `triggers` is unset.
- `triggersChanged` (`Deployment.ts:443-451`):

  ```ts
  if (triggers === undefined || recorded === undefined) return false;
  if (!isResolved({ triggers })) return true;
  return (yield* triggersHashOf(triggers)) !== recorded;
  ```

  So: removing `triggers` never replaces; the first deploy that adds `triggers` records the hash through an update; an unresolved `triggers` value is treated as changed (replace) once a hash is recorded.
- The JSDoc states why it exists: Prisma snapshots environment variables into a deployment at creation, so a variable change reaches the app only through a new deployment (`Deployment.ts:116-119`).

### read (`Deployment.ts:562-582`)

1. `dev:` deployment id: `undefined`.
2. `appId` = `output.appId` if concrete, else `resolveAppId(olds.app)`.
3. If `output.deploymentId`: `observeDeployment` (`getDeployment`); `NotFound` becomes `undefined`.
4. Else `findDeployment(appId, output.foundryVersionId)` (`Deployment.ts:265-281`): lists all App deployments (`getServiceDeployments`, pages of 100) and matches on `foundryVersionId`; more than one match fails `DeploymentConflict`. With no persisted `foundryVersionId`, nothing is found. The JSDoc explains this is deliberate: it never adopts "the App's latest deployment" (`Deployment.ts:205-210`).
5. If found by id: `ensureDeploymentMembership(appId, deployment)`.
6. Return `attrsFrom(deployment, appId, output)`. Never `Unowned`.

### reconcile (`Deployment.ts:583-745`)

1. Validate `portMapping.http`, artifact/skip exclusivity, promote vs `start: false`.
2. `readUploadArtifact({ artifactPath, output: "file" })` (`Deployment.ts:331-359`): resolves the path, `inspectArtifactFile` (regular file, not a symlink, non-empty, at most 768 MiB, SHA-256 computed while streaming, `internal/ArtifactFile.ts:158-187`).
3. `artifactHash` = `sha256Object({ artifact: file.sha256, contentType })`, or `output.artifactHash` when no file (skip-upload).
4. `triggersHash` as above.
5. `appId = resolveAppId(news.app)`.
6. Observe: if `output.deploymentId` is concrete, `observeDeployment`; `NotFound` means missing.
7. If found: `ensureDeploymentMembership(appId, deployment)`; status `failed` fails `DeploymentOperationFailed` ("must be replaced before reconcile").
8. Ensure: if missing:
   1. `createServiceDeployment({ serviceId: appId, portMapping?, skipCodeUpload? })`, `Retry.none`. Record `createdDeploymentId`.
   2. Artifact present but no `uploadUrl`: destroy the created deployment, fail `DeploymentOperationFailed`.
   3. `uploadArtifact(uploadUrl, artifact, contentType)` (`Deployment.ts:453-484`): size check, URL must be credential-free HTTPS, then `executeArtifactUpload` (PUT, 15-minute timeout, `internal/ArtifactUpload.ts`). Failure: destroy the created deployment and fail.
   4. `observeDeployment(created.id)`; `NotFound` is replaced by a synthetic `{ status: "new", previewDomain: null }`; other errors destroy and fail.
9. Start, when `start ?? promote ?? false` (`Deployment.ts:706-731`):
   - If status is neither `running` nor `provisioning`: `startDeploymentIdempotent` (`createDeploymentStart`; a `Conflict` is accepted when the deployment is now `running` or `provisioning`). If start returned a body, wait for `running` and take `previewDomain` from the **start response**.
   - Then (or otherwise) `waitForDeploymentStatus(id, "running")` with **default options** (120 s timeout, 1 s poll). A `failed` status raises `PrismaDeploymentFailed`.
   - Any error in this block: `cleanupCreatedDeploymentOnFailure` destroys the deployment only if this reconcile created it; a pre-existing deployment is left alone.
10. Promote, when `promote` (`Deployment.ts:732-738`): `promoteAppObserved(appId, deployment.id)` with **default options** (60 s observation). Promotion is replayed every deploy even if the App already points here, because it "also repairs provider routing and custom-domain assignment drift". Promotion failure is **not** wrapped in the created-deployment cleanup, so a deployment created in this reconcile survives a failed promotion (see section 9).
11. Return attributes with `artifactHash`, `triggersHash`, `appEndpointDomain` (from promotion, else `output.appEndpointDomain`).

### start, promote, skipCodeUpload

- `start`: start the deployment and wait until `running`. No HTTP check of any URL.
- `promote`: implies start; calls `promoteAppObserved` (section 5), which promotes, then polls `getService` until `latestDeploymentId` equals this deployment; on a lost or failed promote response it checks the App, then calls `createServiceRollback` targeting this deployment as a repair, then observes again.
- `skipCodeUpload: true`: passed to `createServiceDeployment`; no upload. The JSDoc says it reuses the App's currently promoted artifact and "requires an existing promoted deployment" (`Deployment.ts:80-84`), but **reconcile does not check that** (Compute does, in `ensureSkipCodeUploadCanFork`, `Compute.ts:1844-1852`). For skip-upload, `artifactHash` is carried from `output`, so the diff cannot see a change in the forked artifact.

### Failed deployments

- A deployment that fails while being waited on in this reconcile, and that this reconcile created, is stopped (if needed) and deleted by `destroyDeployment`; reconcile then fails.
- A pre-existing deployment observed as `failed` makes reconcile fail; diff turns `output.status === "failed"` into a replace (create-before-delete through the engine).

### delete (`Deployment.ts:746-765`)

1. `dev:` id: return.
2. `observeDeployment`; `NotFound`: return.
3. `ensureDeploymentMembership(output.appId, deployment)`.
4. `destroyDeployment(deploymentId)` with default options (section 5): stop if `running` / `provisioning`, wait for `stopped` (120 s), then `deleteDeployment`.
5. A `PrismaDeploymentWaitTimeout` becomes `Provider.DeleteInProgress` ("Prisma Compute drains open connections before it stops a deployment, and only a stopped deployment can be deleted").

Delete does not check whether the deployment is the App's promoted deployment. Destroying a promoted `Deployment` (or replacing it with one that has `promote: false`) stops the App's live deployment.

### Previous promoted deployment

Nothing in `Deployment` stops or removes the previously promoted deployment. The only removal is the engine deleting the old generation of the same `Deployment` resource after a replacement. A separate `Deployment` resource that previously held the endpoint keeps running.

### Health checks

None. The doc says so: "it does not provide `Prisma.Compute`'s preview/stable health checks or automatic rollback" (`Deployment.ts:200-203`).

### Other

- `list` returns `[]` (`Deployment.ts:494`): App deletion cascades, and App is the nuke enumerator.
- `tail` streams `tailDeploymentLogs(deploymentId)` (`Deployment.ts:766-767`).
- Exports used by Compute: `readUploadArtifact`, `uploadArtifact`, `validateDeploymentArtifactBytes`, `MAX_DEPLOYMENT_ARTIFACT_BYTES = 768 * 1024 * 1024`.

### Local provider (`Deployment.ts:772-783`)

`deploymentId: "dev:deployment:<id>"`, `appId` from `news.app` (string or `.appId`), `foundryVersionId: "dev:foundry-version:<id>"`, `status: "new"`, `previewDomain`, `artifactHash`, `triggersHash`, `appEndpointDomain` all `undefined`. Nothing runs locally.

---

## 3. EnvironmentVariable (`EnvironmentVariable.ts`)

Type `"Prisma.EnvironmentVariable"`. Binding contract: `never`. No lookup.

### Props (`EnvironmentVariable.ts:43-65`)

| Prop | Type | Change behaviour |
|---|---|---|
| `project` | `string \| Project` | Concrete change: **replace**. |
| `branchId` | `string?` | Change vs `olds.branchId`: **replace**. Omit for a project-level template. |
| `class` | `"production" \| "preview"` | Change: **replace**. |
| `key` | `string` | Change: **replace**. |
| `value` | `Redacted<string>` (required, must be `Redacted`) | Any resolved value: **update on every deploy**. |

### Attributes (`EnvironmentVariable.ts:70-111`)

`environmentVariableId`, `projectId`, `branchId: string | null`, `class`, `key`, `value: Redacted<string>`, `valueKid`, `isManagedBySystem`, `createdAt`, `updatedAt`. Stable: `["environmentVariableId"]`.

### Scope model

- Scope is (project, class, branch, key). `branchId: null` is a project-level template; a branch id is a branch override.
- Branch overrides must use `class: "preview"` (`EnvironmentVariable.ts:367-371`). A project-level `preview` template (no branch) is allowed.
- Reconcile does not check that `branchId` belongs to `project`.

### diff (`EnvironmentVariable.ts:312-337`)

Unresolved `news`: `undefined`. `dev:` id: update. Project / branch / class / key change: replace (compared against `olds`, not `output`). Otherwise any resolved `value`: update, because "the Management API never returns plaintext, so equality with `olds` cannot prove the live secret is still correct" (`EnvironmentVariable.ts:329-335`).

### read (`EnvironmentVariable.ts:338-365`)

By id (`getEnvironmentVariable`), else `findVariable(projectId, class, key, branchId)` (`getEnvironmentVariables` filtered by project, class, key, branch, then exact `branchId` match; more than one match fails `EnvironmentVariableConflict`). The value in the result is `output.value ?? Redacted.make("")`: a cold read never copies the desired value, so adoption does not pretend the cloud already holds it. Found without an id: `Unowned`.

### reconcile (`EnvironmentVariable.ts:366-427`)

1. Branch override must be `preview`.
2. `validateEnvironmentVariableWrite`: key matches `^[A-Z_][A-Z0-9_]*$`, at most 256 chars; value non-empty and at most 8 KiB in UTF-8 (`EnvironmentVariable.ts:151-178`).
3. Observe by `output.environmentVariableId` only. Reconcile does **not** search by natural key; an existing variable without state is only taken over through `read` plus adoption.
4. Missing: `createEnvironmentVariable({ projectId, branchId?, class, key, value })`, `Retry.none`. `Conflict` fails `EnvironmentVariableConflict` ("appeared after the adoption check").
5. `ensureVariableIdentity` (project, branch, class, key must match, `EnvironmentVariable.ts:271-289`).
6. `ensureUserManagedVariable`: `isManagedBySystem` fails `PrismaEnvironmentVariableSystemManaged`. This runs after a create, too.
7. Not created this run: `updateEnvironmentVariable({ envVarId, value })`.
8. Return attributes with the desired `value`.

### Existing variables and system-managed variables

- An existing variable without state: `read` finds it and returns `Unowned`, so the engine refuses unless `--adopt`. A variable that appears between read and create: create `Conflict`, which fails.
- System-managed variables are excluded from `list` (`EnvironmentVariable.ts:301-303`), refused by reconcile, and skipped (with a `session.note`) by delete (`EnvironmentVariable.ts:443-452`).

### Secrets and state

The plaintext is sent only in create and update calls (`Redacted.value(value)`). State holds `value` as `Redacted` (the props JSDoc says the engine redacts it before persisting, `EnvironmentVariable.ts:61-63`) plus `valueKid`. `list` returns `Redacted.make("")` placeholders.

### delete (`EnvironmentVariable.ts:428-456`)

`dev:`: return. `getEnvironmentVariable`; `NotFound`: return. Identity check (mismatch fails). System-managed: skip with a note. `deleteEnvironmentVariable`, ignoring `NotFound`.

### Relationship to deployments

None in code. A value change updates the platform record but does not reach a running deployment. The `Deployment.triggers` JSDoc tells users to pass the value there.

### Local provider (`EnvironmentVariable.ts:461-473`)

`environmentVariableId: "dev:environment-variable:<id>"`, `value: news.value`, `valueKid: "dev:value-kid:<id>"`, `isManagedBySystem: false`.

---

## 4. Branch and CustomDomain (supporting resources)

### Branch (`Branch.ts`)

- Props: `project`, `gitName?` (default generated physical name), `isDefault?` (default false; `false` never demotes). Attributes include `role: "production" | "preview"` and `previousDefaultBranchId`.
- diff: project or `gitName` change replaces; `isDefault: true` while output is not default updates (`Branch.ts:280-307`).
- reconcile: refuses to create unless the project has exactly one default branch, records it as `previousDefaultBranchId`, `createProjectBranch` with `Retry.none`; promotion via `updateBranch({ isDefault: true })` with checks (`Branch.ts:334-403`).
- delete: refuses production-role branches; restores the previous default before deleting a default branch; `deleteBranch` retried on `Conflict` (exponential from 500 ms, 6 times) because "a member deleted moments ago (e.g. an App) can still count as live" (`Branch.ts:478-489`).
- Branch does not reference Apps or deployments. Its `role` is what `Compute` reads to choose the environment-variable class (`Compute.ts:1921-1940`).
- Has its own `listBranches` (`Branch.ts:174-196`), a third copy (see section 5).

### CustomDomain (`CustomDomain.ts`)

- `type AppReference = string | App | Compute;` (`CustomDomain.ts:46`), `app: AppReference` (`CustomDomain.ts:52`). It reads the id with `typeof app === "string" ? app : app?.appId` (`CustomDomain.ts:169`), so it relies only on an `appId` attribute.
- diff: an app id or hostname change **fails** with `CustomDomainInvalidProps` (no replace). `status === "failed"` updates (one retry per reconcile).
- reconcile: get by id or find by hostname on the App; an existing domain without state fails `PrismaCustomDomainAdoptionRequired`; waits for authoritative DNS CNAME before create; `createAppDomain` retried 6 times on "DNS is not configured"; `retryCustomDomain` for failed domains.
- Uses the hand-rolled `PrismaClient` (`Client.ts`), not distilled.

---

## 5. Helpers: signatures, behaviour, callers

Callers were found by import (`grep` of every `from "./internal/..."` and `"./ComputeLifecycle.ts"`).

### `ComputeLifecycle.ts` (re-exported publicly from `index.ts:11`)

| Helper | Signature | What it does | Callers |
|---|---|---|---|
| `waitForDeploymentStatus` | `(deploymentId, targetStatus: "running" \| "stopped", options?: { timeoutSeconds?, pollIntervalMs? })` (`:145`) | Polls `getDeployment` every `pollIntervalMs` (default 1000) until the status matches; `failed` raises `PrismaDeploymentFailed`; deadline (default 120 s) raises `PrismaDeploymentWaitTimeout`; bad options raise `PrismaDeploymentWaitInvalidOptions`. Each observation is bounded by the remaining time. | Deployment (`:717`, `:725`, defaults), Compute (`:2371`, `:2599`, with `effectiveNews`), `destroyDeployment`. |
| `destroyDeployment` | `(deploymentId, options?)` (`:204`) | `getDeployment` (`NotFound` returns `deleted: true`). If `running`/`provisioning`, `stopDeploymentIdempotent`; if `running`/`provisioning`/`stopping`, wait for `stopped`. Then `deleteDeployment` (ignore `NotFound`); other errors become `PrismaDeploymentDeleteFailed` with manual routes. Returns `{ deploymentId, previousStatus, stopped, deleted }`. | Deployment (cleanup `:645`, delete `:753`), Compute (`:2365`, `:2434`, `:2520`). |
| `destroyApp` | `(appId, options?: WaitForDeploymentStatusOptions & { keepApp? })` (`:259`) | `deleteService` with 5 attempts, `Conflict` backoff 250 ms * 2^n. `options` other than `keepApp` are unused. | App delete (`:500`), Compute delete (`:2764`) and created-App cleanup (`:2310`), `destroyProjectApps`. |
| `destroyProjectApps` | `(projectId, options?: ... & { keepProject?, keepApp? })` (`:296`) | Lists Apps in the project (404 means gone), `destroyApp` each, then `deleteProject` with 5 attempts; on `Conflict` or `BadRequest`, re-clean Apps and retry. | Project delete (`Project.ts:721`). |
| `toDeploymentUrl` | `(domain?: string \| null)` (`:383`) | Prefixes `https://` unless already a URL. | Compute only. |
| `isConflict` | re-export from `Client.ts` (`:18`) | | — |
| Error classes | `PrismaDeploymentWaitTimeout`, `PrismaDeploymentWaitInvalidOptions`, `PrismaDeploymentFailed`, `PrismaDeploymentDeleteFailed` | | Deployment catches `PrismaDeploymentWaitTimeout` in delete. |

### `internal/AppPromotion.ts`

| Helper | Signature | What it does | Callers |
|---|---|---|---|
| `waitForAppDeploymentTarget` | `(appId, deploymentId, options?: { timeoutSeconds?, pollIntervalMs? })` (`:43`) | Polls `getService` until `latestDeploymentId === deploymentId` (default 60 s, 1 s). Request errors are remembered, not fatal. Timeout raises `AppDeploymentTargetTimeout`. Returns the App record. | Compute directly (`:2415`, `:2644`), and `promoteAppObserved`. |
| `promoteAppObserved` | `(appId, deploymentId, options?)` (`:108`) | 1. `createServicePromote`. 2. Success: wait for the App to report the target; failure of that wait raises `AppPromotionNotConverged`. Returns promote body plus `appEndpointDomain`. 3. Promote failed: `getService`; if it already points at the target, success. 4. Else `createServiceRollback({ serviceId, deploymentId })` as a repair, then wait (or a single `getService` if the rollback call failed). 5. Converged: success; else `AppPromotionNotConverged` carrying every error. Never deletes anything. | Deployment (`:736`, default options), Compute (`:2621`, with `effectiveNews`, so Compute's `timeoutSeconds` default 120 also applies to the promotion wait). |

### `internal/DeploymentActions.ts`

| Helper | What it does | Callers |
|---|---|---|
| `startDeploymentIdempotent(deploymentId)` (`:26`) | `createDeploymentStart`; returns the start response body. `Conflict` is accepted (returns `undefined`) when `getDeployment` shows `running` or `provisioning`. | Deployment (`:715`), Compute (`:2597`). |
| `stopDeploymentIdempotent(deploymentId)` (`:32`) | `createDeploymentStop`; `Conflict` accepted when status is `stopped` or `stopping`. | Compute (`:2368`), `destroyDeployment`. |

### `internal/DeploymentIdentity.ts`

`ensureDeploymentMembership(appId, deployment: { id, foundryVersionId }, knownLatestDeploymentId?)` (`:15`). Returns immediately when `knownLatestDeploymentId === deployment.id`. Otherwise lists every App deployment (`getServiceDeployments`, no `limit`) and requires exactly one entry with this id and the same `foundryVersionId`, else `DeploymentIdentityConflict`. Callers: Deployment (read `:579`, reconcile `:635`, delete `:752`; never passes the third argument), Compute (`:2232`, `:2363`, `:2508`; always passes `app.latestDeploymentId`).

### `internal/DeploymentObserve.ts`

`observeDeployment(deploymentId)`: `getDeployment(...).data`. Callers: Deployment, Compute, `ComputeLifecycle`, `DeploymentActions`.

### `internal/AppIdentity.ts`

`ensureAppImmutableIdentity(app, projectId, regionId)` (`:10`): fails `AppIdentityConflict` unless the App's project and region match. Callers: App (`:452`), Compute (`:1828`).

### `internal/CleanupFailure.ts`

`aggregateCleanupFailure(resource: "App" | "deployment", resourceId, route, originalError, cleanupError)` (`:19`): builds `PrismaCleanupFailed` with both errors and a manual `DELETE` route. Callers: Deployment (`:647`), Compute (`:2312`, `:2522`).

### `internal/Refs.ts`

`isInputObject`, `isPrismaDevId` (`value.startsWith("dev:")`), `concreteIdOf`, `concreteIdsChanged(old, new)` (true only when both are defined and differ), `unresolvedProjectIdOf` / `resolveProjectId`, same pairs for database, bucket and app (`unresolvedAppIdOf` / `resolveAppId` take `string | App`). Callers: every resource. `resolveAppId` / `unresolvedAppIdOf` are used by Deployment only; CustomDomain has its own copies that accept `Compute` too (`CustomDomain.ts:169-178`).

### `internal/Branches.ts`

`desiredBranchId(projectId, { branchId?, branchGitName? })` (`:46`): a concrete `branchId` is returned as is; `branchGitName` is looked up (more than one: `BranchesConflict`); otherwise the single default branch. Returns `{ resolved: true, id } | { resolved: false }`. Callers: App, Bucket, Database. **Not Compute**, which has its own `desiredComputeBranchId` (`Compute.ts:1035-1055`) with the same logic and a `ComputeConflict` error.

### `internal/DevStub.ts`

`DEV_TIMESTAMP`, `devId(type, id) = "dev:<type>:<id>"`, `attrOrString`, `attrOrNullableString`, `attrOrRedactedString`, and `devProvider(resource, stables, attrs)` (`:49-72`): `list` returns `[]`, `diff` always `update`, `read` echoes `output`, `reconcile` merges `output` with fresh fabricated attributes, `delete` is a no-op. Callers: App, EnvironmentVariable, Deployment, Branch, CustomDomain, Bucket, BucketAccessKey, Connection, Database, Project, SourceRepository. **Not Compute**, which has its own `ComputeDevProvider` that runs a dev process (`Compute.ts:2772-2831`).

### Artifact helpers

- `internal/ArtifactFile.ts`: `inspectVerifiedFile`, `inspectArtifactFile(path, maxBytes, { cleanup?, description? })` (regular file, no symlink, realpath identity re-check, streaming SHA-256), `artifactFileStream`, `readArtifactFile`, `verifiedFileChunks`. Callers: Deployment (via `readUploadArtifact`), ComputeArchive, ArchivePlatform. Compute reaches it only through `readUploadArtifact`.
- `internal/ArtifactUpload.ts`: `executeArtifactUpload(uploadUrl, artifact, contentType)`: PUT on `PrismaUploadClient` if provided, else ambient `HttpClient`; 15-minute timeout; non-2xx fails `ArtifactUploadOperationFailed` with only the byte count of the body prefix. Caller: `Deployment.uploadArtifact`, which Compute imports.
- `internal/HttpClient.ts`: `PrismaHttpClientLive` (node transport), `PrismaUploadClient` service and `PrismaUploadClientLive`.
- `internal/ArchivePlatform.ts`, `internal/BundlePaths.ts` (`normalizeBundleFilePath`): Compute and ComputeArchive only.

### Other internal files

- `internal/Observed.ts`: structural types (`ObservedApp`, `ObservedDeployment`, `ObservedEnvironmentVariable`, ...) plus `secretValue`, `requiredSecretValue`, `narrowDatabaseSource`. Shared by all.
- `internal/Pagination.ts`: `PrismaPaginationError` (raised when `hasMore` is true but `nextCursor` is null). Every hand-written page walk uses it.
- `internal/Credentials.ts`: `fromEnvironment`, `fromAuthProvider`, `environmentFromAuthProvider` (lazy credential resolution so `alchemy dev` needs no token). Used by Providers.ts and PrismaLogs.ts.
- `internal/BaseUrl.ts`: `resolveBaseUrl` from `PRISMA_API_URL`, then `PRISMA_MANAGEMENT_API_URL`, default `https://api.prisma.io`; HTTPS only except loopback; origin only.
- `internal/Authorization.ts`, `internal/LogsClient.ts`: header and log-stream helpers.
- `internal/EnvName.ts`: `fnv1a64`, `physicalInstanceName`, `envName`. BucketAccessKey, Connect, Connection.
- `internal/DatabaseSecrets.ts`, `internal/PrismaDevDatabase.ts`, `internal/BucketClient.ts`: database and bucket only.

### `Operations.ts` and `PrismaEnvironment.ts`

- `Operations.ts`: thin standalone wrappers over the hand-rolled `PrismaClient` (`listApps`, `createAppDeployment`, `promoteApp`, `rollbackApp`, `startDeployment`, environment-variable CRUD, ...). No resource uses them.
- `PrismaEnvironment.ts`: `PrismaEnvironment` service holding an `Effect<{ serviceToken?, baseUrl, ... }>` that runs per request; `fromProfile()` layer.

### What is shared and what is duplicated between Compute and the primitives

Already shared (one implementation, both call it): `waitForDeploymentStatus`, `destroyDeployment`, `destroyApp`, `promoteAppObserved`, `startDeploymentIdempotent`, `ensureDeploymentMembership`, `observeDeployment`, `aggregateCleanupFailure`, `ensureAppImmutableIdentity`, `readUploadArtifact`, `uploadArtifact`, the `Refs` helpers, `PrismaPaginationError`, the `Observed` types. Compute alone uses `waitForAppDeploymentTarget`, `stopDeploymentIdempotent`, `toDeploymentUrl`.

Duplicated (same logic written twice or three times):

| Logic | Primitive copy | Compute copy | Differences |
|---|---|---|---|
| List Apps | `App.ts:185-207` (filters project, logicalId, branchId) | `Compute.ts:1013-1033` (project only) | Third inline copy in `ComputeLifecycle.ts:309-328`. |
| List branches | `internal/Branches.ts:17-40` | `Compute.ts:988-1011` | Third copy in `Branch.ts:174-196` (no `limit`). |
| Desired branch | `desiredBranchId` (`Branches.ts:46`) | `desiredComputeBranchId` (`Compute.ts:1035`) | Same rules; different error class. |
| Find App by name | `findApp` (`App.ts:212`) | `findApp` (`Compute.ts:1060`) | Same; different error class. |
| Default name | `createDisplayName` (`App.ts:209`) | `createAppName` (`Compute.ts:1057`) | Identical. |
| Create App | `App.ts:420-449` | `createApp` + `ensureApp` (`Compute.ts:1078-1093`, `1788-1842`) | Compute sends **no `logicalId`**, has no logical-id lookup or sync, no post-update convergence check, and retries the whole ensure on `NotFound` (`projectConsistencySchedule`, 6 retries from 500 ms, `Compute.ts:972-984`, `2298-2305`). Compute read finds an App only by name (`Compute.ts:2213-2218`). |
| Find env var | `findVariable` (`EnvironmentVariable.ts:212-235`) | `findEnvironmentVariable` (`Compute.ts:1854-1886`) | EnvironmentVariable fails on more than one match; Compute takes the first. |
| Env key/value validation | `EnvironmentVariable.ts:151-178` | `Compute.ts:1116-1147` | Same constants and rules; separate error classes. |
| System-managed check | `EnvironmentVariable.ts:253-269` | `Compute.ts:1888-1898` | Separate error classes. |
| Create deployment, upload, observe, clean up created | `Deployment.ts:642-698` | `Compute.ts:2517-2573` | Near-verbatim copy. Compute always sends `portMapping: { http: artifact.port }`, fixes content type `"application/gzip"`, and passes `effectiveNews` to `destroyDeployment`. |
| Start and wait for running | `Deployment.ts:707-731` | `Compute.ts:2589-2611` | See section 6. |

---

## 6. Release sequence: `Deployment.reconcile` versus `Compute.reconcile`

| Step | Deployment (`Deployment.ts`) | Compute (`Compute.ts`) |
|---|---|---|
| Decide whether to make a new deployment | In `diff`: replace on content/hash/trigger/app/failed change (`:495-561`). Reconcile reuses `output.deploymentId` if it exists. | Diff always returns `update` (`:2208`). Reconcile computes `deploymentHash = sha256({ artifact: artifact.hash, branchId, environmentClass, environmentBranchId })` (`:2335-2340`) and reuses the persisted deployment only when it equals `output.artifactHash` (`:2497-2498`). `artifact.hash` includes **plaintext env values**, env class and port (`resolveArtifact`, `:1605-1666`), unsalted, stored `Redacted`. |
| Environment variables | None. User must use separate `EnvironmentVariable` resources and `triggers`. | Syncs `env` (props plus binding env) before creating the deployment; refuses keys it does not own; deletes removed keys before creation so they are not captured; rolls back created variables on failure (`:2469-2495`, `:1948-2049`, `:2741-2746`). |
| Recovery before acting | Pre-existing `failed` deployment: fail (`:636-640`). | Refuses if a persisted failed deployment is not the App's latest (`:2377-2388`); rolls back to the persisted promoted deployment and deletes the displaced one if a previous attempt left the App pointing elsewhere (`:2397-2446`); refuses while stable readiness is `pending` (`:2448-2452`); drains a non-live pending cleanup (`:2456-2468`). |
| Membership check | Against the full deployment list. | Same helper with `app.latestDeploymentId` short-cut. |
| Create version | `createServiceDeployment({ serviceId, portMapping?, skipCodeUpload? })`, `Retry.none`. | Same call, always with `portMapping: { http: artifact.port }`. A persisted failed deployment is never reused (`:2514-2516`). |
| skipCodeUpload precondition | Not checked. | Requires `app.latestDeploymentId` (`ensureSkipCodeUploadCanFork`, `:1844-1852`). |
| Upload | `uploadArtifact(url, file, artifactContentType ?? "application/octet-stream")`. | `uploadArtifact(url, file, "application/gzip")`. |
| Start | Only when `start ?? promote ?? false`. | When `start ?? true` (default on). |
| Wait for running | `waitForDeploymentStatus(id, "running")`, defaults 120 s / 1 s. `previewDomain` taken from the start response when start returned one. | Same helper with `timeoutSeconds` / `pollIntervalMs` props. `previewDomain` from the observed deployment. |
| Preview URL check | None. | `waitForDeploymentUrl(previewUrl, props)` before promotion (`:2604`): waits until the edge stops returning Prisma's "Service not found" 404, or, with `healthCheck`, until `GET path` returns an accepted status (`:1325-1428`, default 60 s via `urlReadinessTimeoutSeconds`). Skipped when `verifyUrl: false`. |
| Failure before promotion | Destroy the deployment if this reconcile created it. | Same, plus roll back created env vars and destroy a newly created App. |
| Promote | Only when `promote`. `promoteAppObserved` with defaults (60 s). | Unless `skipPromote`. `promoteAppObserved` with props options. Sets `preserveCreatedAppOnFailure = true` first. |
| Verify after promotion | Only the `latestDeploymentId` observation inside `promoteAppObserved`. | Also `waitForDeploymentUrl(stableUrl)` unless `verifyUrl: false` (`:2630-2633`). |
| Stable check fails | Not applicable. | With a previous deployment: `createServiceRollback` to it, observe, then destroy the new deployment; non-convergence raises `ComputeDeploymentRecoveryFailed` and keeps both (`:2636-2668`). First deployment: fail; a newly created App is cleaned up, a pre-existing one is kept (`:2669-2686`). |
| Previous version | Nothing. Engine deletes the old generation only on replacement of this same resource. | Records `previousDeploymentId`; after a successful promotion, stops it (default) or destroys it (`destroyOldDeployment`, or always when it was terminal-failed). Failure to clean up is recorded as `pendingDeploymentCleanup` and retried next deploy (`:2690-2717`). |
| Outputs about the release | `status`, `previewDomain`, `appEndpointDomain` (only if promoted), hashes. | `deploymentUrl`, `url`, `promoted`, `previousDeploymentId`, `previousDeploymentAction`, `readinessStatus`, `pendingDeploymentCleanup`, env ownership ids. |
| Delete | Stop and delete this deployment; timeout becomes `DeleteInProgress`. | Delete owned env vars, then `destroyApp` (cascade). |
| Logs | `tail` on the deployment. | `tail` on the current deployment. |

Behavioural differences, listed once:

1. Default for `start`: Deployment `false`, Compute `true`.
2. Deployment has no URL readiness check, no health check, no post-promotion check, and no rollback.
3. Deployment never stops or deletes the previously promoted deployment.
4. Deployment decides replacement in `diff`; Compute decides reuse in `reconcile` from its own hash. Compute's hash covers env values, env class, port and branch; Deployment's covers artifact bytes and content type, plus the separate `triggers`.
5. Deployment does not check the skip-upload precondition.
6. Wait and promotion timeouts are configurable on Compute and fixed defaults on Deployment.
7. Upload content type: configurable vs fixed `application/gzip`.
8. Deployment uses the start response's `previewDomain`; Compute does not.
9. Compute has crash-recovery logic driven by its persisted attributes (`promoted`, `readinessStatus`, `pendingDeploymentCleanup`); Deployment has only the failed-status replace.
10. Deployment's `read` recovers a lost deployment by `foundryVersionId` from state; Compute's `read` falls back to the App's `latestDeploymentId` (`Compute.ts:2234-2237`), and drops `artifactHash` in that case (`:2262-2264`).

---

## 7. How other resources refer to an App, a Compute or a deployment

| Resource | Prop / mechanism | Quote | Notes |
|---|---|---|---|
| `Deployment` | `app: string \| App` | `Deployment.ts:73` | Does not accept `Compute`. Resolved by `resolveAppId` (`internal/Refs.ts:62`), reading `.appId`. |
| `CustomDomain` | `app: string \| App \| Compute` | `type AppReference = string \| App \| Compute;` (`CustomDomain.ts:46`) | Reads `.appId` only. App id change fails diff with `CustomDomainInvalidProps`, so a Compute that changes `appId` (project change replaces) breaks an attached domain. |
| `Website.FrameworkSite` | passes the Compute itself | `app: compute,` (`Website/FrameworkSite.ts:194`); also uses `compute.appEndpointDomain` for the DNS alias target (`:189`) and `compute.url` (`:203`); returns `compute: Compute \| undefined` (`:117`). | Depends on `Compute` keeping `appId`, `appEndpointDomain`, `url`. |
| `Connect` (binding) | `CurrentRuntimeContext`, any Platform host | `Connect.ts:275-289` | Calls `output.bind(key)` on the host runtime context. For Compute, `RuntimeContext.set` stores the Output in `env` under an uppercased key (`Compute.ts:889-907`), and the core Platform merges `runtimeContext.env` into the Compute's `props.env` (`packages/alchemy/src/Platform.ts:630-635`). Compute then syncs those keys as environment variables. |
| Bucket bindings (`ReadBucket`, `WriteBucket`, `ReadWriteBucket`) | create a `BucketAccessKey` and return a client over its outputs (`BucketBinding.ts:62-80`) | | No direct App reference; credentials reach the host through the same runtime-context path as `Connect` (I did not trace every client builder). |
| `Connection`, `BucketAccessKey` | none | JSDoc examples pass outputs into `Compute({ env: {...} })` (`Connection.ts:171-185`, `BucketAccessKey.ts:104-118`). | |
| `SourceRepository` | none | Internally lists `branchId: "unassigned"` Apps before linking and verifies they end up on the default branch (`SourceRepository.ts:466-484`, `318-333`). | Works on App ids discovered from the API. |
| `Branch` | none | | |
| `Project` | delete calls `destroyProjectApps` (`Project.ts:721`) | | Deletes every App in the project, whoever owns it. |
| Compute's binding contract | `{ env?: Record<string, string \| Redacted<string> \| null \| undefined> }` (`Compute.ts:657-659`), read by `activeBindingEnv` (`Compute.ts:2161-2173`) | | App, Deployment and EnvironmentVariable have binding contract `never`. |

`isCompute` (`Compute.ts:671-672`) is exported but no file in the package calls it. There is no `isApp`.

---

## 8. Local and dev behaviour

- Registration: `Providers.ts:167-217`. Every Prisma provider is in one `Provider.collection` and one `Layer.mergeAll`; `ComputeProvider()`, `AppProvider()`, `DeploymentProvider()`, `EnvironmentVariableProvider()`, `BranchProvider()`, `CustomDomainProvider()` each use `ProviderLayer.dual({ local, live })`.
- App, Deployment, EnvironmentVariable, Branch and CustomDomain local variants are `devProvider` stubs (section 5): `dev:<type>:<id>` ids, nothing runs, delete is a no-op. App's local `appEndpointDomain` is `"localhost"`; Deployment's local `appEndpointDomain` and `previewDomain` are `undefined`.
- Compute's local variant (`ComputeDevProvider`, `Compute.ts:2772-2831`) is not a stub: it requires `ctx.dev`, optionally spawns `dev.command` as a child process tracked in a module-level `Map` (`Compute.ts:957-970`, `2116-2159`), and returns `appId: output?.appId ?? "dev:<id>"` (no type segment, unlike `devId`), `url` / `appEndpointDomain` = the local URL, `local: true`.
- Live providers treat a `dev:` id in `output` as missing: diff returns `update`, reconcile creates, delete returns early (`isPrismaDevId`, `internal/Refs.ts:24-25`). `desiredBranchId` ignores a `dev:` `branchId` and falls back to the default branch (`Branches.ts:50`).
- Credentials resolve lazily, so dev runs need no Prisma token (`internal/Credentials.ts:37-59`, `Providers.ts:209-213`).

---

## 9. Surprising findings

1. **Deployment can record a new artifact hash without uploading it.** If `artifactPath` (or `portMapping`, `skipCodeUpload`, `artifactContentType`) is unresolved at plan time, `diff` returns `undefined` (`Deployment.ts:519`), which the engine treats as an update. Reconcile then keeps the existing deployment (`Deployment.ts:629-633`) but sets `artifactHash` from the new file (`Deployment.ts:614-620`). The next plan sees matching hashes and never replaces. This needs an artifact path that comes from another resource changing in the same deploy. The `triggers` check was moved ahead of this early return for exactly this reason (`Deployment.ts:507-509`); the artifact path was not.
2. **Deleting a promoted Deployment takes the App's endpoint down.** `Deployment.delete` stops and deletes without checking `latestDeploymentId`. A replacement with `promote: false`, or `stack destroy` of a Deployment while its App stays, stops the live deployment.
3. **Two Deployments with `promote: true` on one App fight.** Each re-promotes on every deploy (`Deployment.ts:549-553`), so the last one reconciled wins.
4. **A deployment created before a failed promotion is orphaned from state.** Promotion is outside the created-deployment cleanup (`Deployment.ts:732-738`), and a failed reconcile persists no new `deploymentId`. Compute has the same shape (`Compute.ts:2617-2624`). `AppPromotionNotConverged` says the deployment "was preserved because promotion commit state is ambiguous", so this is intended, but the next deploy creates another deployment. Deployment's `read` can only recover it if `foundryVersionId` was persisted, which it was not.
5. **`skipCodeUpload` precondition is documented on Deployment but enforced only by Compute.**
6. **Compute creates Apps without a `logicalId`**, while `App` always sets one and uses it for lost-state recovery and ownership. A composed Compute built on `App` would start writing logical ids to existing Compute Apps (App reconcile step 8 sets it on first reconcile).
7. **App delete does not report draining as "in progress".** `destroyApp` gives up after about 3.75 s of `Conflict`, with a raw error. `Deployment.delete` maps its stop timeout to `Provider.DeleteInProgress`.
8. **App region change is a diff error, not a replace** (both App and Compute). Project change is a replace.
9. **Compute's deployment fingerprint hashes plaintext env values unsalted** (`Compute.ts:1606`, `1658-1663`, `2335-2340`), stored `Redacted`. Deployment's `triggers` deliberately salts (`Deployment.ts:403-408`). The two fingerprints are not compatible.
10. **Compute and EnvironmentVariable cannot co-manage a key.** Compute refuses any existing key whose id is not in its own `environmentVariableIds` (`Compute.ts:1999-2004`), and EnvironmentVariable's create fails on `Conflict` for a key Compute created.
11. **`App.latestDeploymentId` goes stale** after a separate Deployment promotes; App's diff never looks at it.
12. **Plan-time API and file work.** `App.diff` calls `getProjectBranches`; `Deployment.diff` reads and hashes the whole artifact file (up to 768 MiB).
13. **Two Management API clients coexist.** CustomDomain and `Operations.ts` use the hand-rolled `Client.ts` (`/v1/apps/...` routes); everything else uses distilled (services). `CustomDomain.list` uses `client.listApps()` while `App.list` uses distilled `getServices`.
14. **`isCompute` is exported but unused in the package.**
15. **`destroyApp`'s `options` parameter** accepts wait options it never uses (only `keepApp`).
16. **Deployment local ids differ from Compute local ids** (`dev:deployment:<id>` from `devId` versus Compute's `dev:<id>`), and the App stub's `appEndpointDomain: "localhost"` is not a URL that anything serves.

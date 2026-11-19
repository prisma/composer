# Prisma.Compute: complete inventory of current behaviour

Source: `wip/alchemy` (Alchemy repository). All paths are relative to
`packages/prisma/src/` unless they start with `packages/`. `Compute.ts:N` means
line N of `packages/prisma/src/Compute.ts`, which was read in full (2,837 lines).

Also read: `Deployment.ts` (full), `ComputeLifecycle.ts` (full),
`internal/AppPromotion.ts`, `internal/DeploymentActions.ts`,
`internal/DeploymentObserve.ts`, `internal/DeploymentIdentity.ts`,
`internal/AppIdentity.ts`, `internal/CleanupFailure.ts`, `internal/Refs.ts`,
`Connect.ts` (binding half), `BucketBinding.ts`, the three bucket capability
files (layer parts), `Website/FrameworkSite.ts`, `Website/StaticSite.ts`,
`Website/index.ts`, `Website/Artifact.ts` (interface), `Providers.ts`,
`Bootstrap.ts`, key types of `ComputeBuild.ts` and `ComputeArchive.ts`, the
props/attributes of `App.ts` and `EnvironmentVariable.ts`, and in core
`packages/alchemy/src/Platform.ts` (lines 30-687), `Output.ts` (`bind`),
`RuntimeContext.ts` (interface) and `packages/aws/src/AWSBindings.ts` (generic
host binding).

---

## 1. Input props (`ComputeProps`, Compute.ts:380-565)

`ComputeProps extends PlatformProps`, which adds the internal `isExternal?: boolean`
(`packages/alchemy/src/Platform.ts:42-48`).

"Update" below means the live `diff` returns `{ action: "update" }`. The live
diff returns update for every change except `project` (replace) and `regionId`
(error). See section 5.

| Prop | Type | Default | What it controls | Change causes |
|---|---|---|---|---|
| `project` | `string \| Project` | required | Project that owns the App. Resolved with `resolveProjectId` (Compute.ts:2280). | **replace** when both old and new concrete project IDs are known and differ (Compute.ts:2189-2197) |
| `appName` | `string?` | `createPhysicalName({ id })` (Compute.ts:1057-1058) | App display name; also the natural key used by `findApp` (name + branch). | update (`updateService` rename, Compute.ts:1833-1839) |
| `regionId` | `PrismaRegionId?` | project default region server-side (only sent when set, Compute.ts:1087) | Region of the App. | **diff fails** with `ComputeInvalidProps` if it differs from `output.regionId ?? olds.regionId` (Compute.ts:2198-2205). Removing it is allowed. |
| `branchId` | `string?` | — | Branch to attach the App to. Mutually exclusive with `branchGitName` (Compute.ts:1231-1235). `null` rejected (1236-1241). | update (`updateService` branch move, 1833-1839) |
| `branchGitName` | `string?` | project's default branch | Branch looked up by git name (`getProjectBranches` with `gitName`). | update |
| `path` | `string?` | `"."` | App directory for path archives and builds; also dev command cwd fallback (2129). | update |
| `archiveIgnore` | `readonly string[]?` | — | Extra archive exclusions; `.env*`, `.git`, `.alchemy` (and more, `ComputeArchive.ts:94-117`) always excluded. | update |
| `entrypoint` | `string?` | `package.json#main` (Compute.ts:1751) | Entrypoint inside the artifact (path and command builds; auto build Bun fallback). | update |
| `main` | `string?` | — | Entry module for an effect-native app; bundled by rolldown. Required when an inline Effect is passed. | update |
| `handler` | `string?` | `"default"` | Export name inside `main`; must be `default` or a JS identifier (1252-1259). | update |
| `bundle` | `ComputeBundleOptions?` (`input`, `output`, `extra`) | — | Rolldown options for effect-native bundles (1551-1589). | update |
| `exports` | `string[] \| Record<string, unknown>?` (`@internal`) | set by Platform | Only used as a flag: effect-native mode is `isExternal !== true && (main !== undefined \|\| exports !== undefined)` (674-677). | update |
| `build` | `ComputeBuild \| false \| "auto"` | — (undefined = archive `path` as is) | Command build, auto framework build, or static build (see section 11). | update |
| `artifactPath` | `string?` | — | Prebuilt `tar.gz` uploaded as is. | update |
| `port` | `number?` | `8080`, or the auto/static build's `defaultPort` (1692, 1725) | Sent as `portMapping: { http: port }` on every new deployment (2537). Also bootstrap default port for effect-native (1546, 1570). | update |
| `env` | `Record<string, string \| Redacted \| null \| undefined>?` | — | Runtime env vars synced through Prisma's environment variable API before deployment creation. `null` deletes, `undefined` ignored. | update |
| `envClass` | `"production" \| "preview"?` | doc says `"production"`; **actually inferred** from the attached branch's role and only validated if set (1933-1938) | Env var class. | update |
| `skipCodeUpload` | `boolean?` | `false` | New deployment forks the App's current artifact (`createServiceDeployment({ skipCodeUpload })`). | update |
| `start` | `boolean?` | `true` | Start the deployment. `false` requires `skipPromote: true` (1225-1230). | update |
| `skipPromote` | `boolean?` | `false` | Do not promote to the stable endpoint. | update |
| `destroyOldDeployment` | `boolean?` | `false` | Delete (not just stop) the previously promoted deployment after promotion. Cannot combine with `skipPromote` (1219-1224). | update |
| `timeoutSeconds` | `number?` | `120` (ComputeLifecycle default) | Wait for start/stop; also passed as the App-target wait budget (default 60 there, `internal/AppPromotion.ts:40`). | update |
| `pollIntervalMs` | `number?` | `1000` | Poll interval for status waits and URL probes. | update |
| `verifyUrl` | `boolean?` | `true` | Probe preview URL before promotion and stable URL after promotion. | update |
| `healthCheck` | `{ path; statusCodes? }?` | — | Application GET probe on preview then stable URL. Incompatible with `verifyUrl: false` and `start: false` (1180-1189). | update |
| `urlReadinessTimeoutSeconds` | `number?` | `60` | Budget per URL probe phase (1361). | update |
| `dev` | `ComputeDev?` (`command`, `cwd`, `port`, `url`, `env`) | — | Local behaviour in `alchemy dev` (section 10). | update |

`validateComputeProps` (Compute.ts:1177-1282) is the single validation pass. Its
checks, in order: health check shape; `healthCheck`+`verifyUrl:false`;
`healthCheck`+`start:false`; positive finite `timeoutSeconds`, `pollIntervalMs`,
`urlReadinessTimeoutSeconds`; integer `port` and `dev.port` in 1..65535; every
env key matches `^[A-Z_][A-Z0-9_]*$` (<= 256 chars) and every non-null value is
non-empty and <= 8 KiB (1116-1147); `skipPromote`+`destroyOldDeployment`;
`start:false` without `skipPromote`; branch mutual exclusion and nulls;
`skipCodeUpload` with `artifactPath` or `build`; effect-native mode forbids
`artifactPath`, `build`, `skipCodeUpload` and requires `main`.

Build sub-props (Compute.ts:172-319):

- `ComputeCommandBuild`: `command`, `cwd` (default `path`), `outdir` (relative to `cwd`), `entrypoint`, `env`, `outputLimitBytes` (1 MiB), `timeoutSeconds` (900).
- `ComputeAutoBuild`: `type: "auto"`, `framework` (`auto|nextjs|nuxt|astro|nestjs|tanstack-start|vite|bun`, `ComputeBuild.ts:43-51`), `env`, `outputLimitBytes`, `timeoutSeconds`.
- `ComputeStaticBuild`: `type: "static"`, `outdir`, `command?`, `cwd?`, `indexPage` (`index.html`), `spa` (false), `env`, `outputLimitBytes`, `timeoutSeconds`.

All build `env` values are persisted in Alchemy state as given; the JSDoc tells
users to wrap secrets in `Redacted`.

---

## 2. Output attributes (Compute.ts:567-661)

| Attribute | Written by reconcile as | Read on the next run by |
|---|---|---|
| `appId` | `app.id` (2720) | `findExistingApp` (1778-1786), `ensureApp` Conflict ownership check (1812), `read` (2212), `delete` (2764). Stable property: `stables: ["appId"]` (2180). Dev uses `dev:<id>`. |
| `deploymentId` | current deployment (2721) | `read` (2228), reconcile `persistedDeployment` (2344-2348), interrupted-promotion recovery (2397-2446), `tail` (2766-2767). |
| `projectId` | resolved project (2722) | `diff` replace check (2189), `delete` (2757). |
| `appName` | `app.name` | not read by reconcile. |
| `regionId` | `app.region.id` | `diff` immutability check (2199), `ensureApp` region fallback (1831). |
| `deploymentEndpointDomain` | `deployment.previewDomain` | consumer-facing only. |
| `deploymentUrl` | `https://` + preview domain | consumer-facing only. |
| `appEndpointDomain` | from `promoteAppObserved` or `app.appEndpointDomain` | `read` fallback (2251). Consumed by `Website/FrameworkSite.ts:182` (CNAME target). |
| `url` | stable URL if promoted, else preview URL (2728) | consumer-facing (`FrameworkSite.ts:197`). |
| `promoted` | `true` after promotion, else `app.latestDeploymentId === deployment.id` (2616, 2623) | reconcile guards at 2380 and 2399. |
| `previousDeploymentId` | the deployment displaced by this run, or null (2580-2585) | **not read** by reconcile; `read` copies it through (2254). Informational. |
| `previousDeploymentAction` | `"stopped" \| "destroyed" \| "still-active" \| null` (2614-2615, 2710) | **not read**; copied by `read`. Informational. |
| `readinessStatus` | `"ready"` or `"skipped"` (2629-2635). **`"pending"` is never written** by the current code. | Guards at 2448 and 2458 (only matter for state written by an older version). |
| `pendingDeploymentCleanup` | `{ deploymentId, action: "stop" \| "destroy" }` when the cleanup of the previous deployment failed (2690-2716) | Drained at the start of the next reconcile, before any env or deploy change (2456-2468). |
| `environmentKeys` | `managedEnvKeys(env)`: sorted keys with non-null values (1109-1114, 2734) | **not read**; informational. |
| `environmentVariableIds` | `Record<key, envVarId>` of variables this resource owns (2735) | The ownership map: passed to `syncComputeEnvironmentInternal` (2474-2482), used by `cleanupRemovedComputeEnvironment` (2489-2495) and `delete` (2756-2763). |
| `environmentClass` | inferred class (2736) | previous scope (2469-2472) and `delete` scope (2758-2761), both with `olds?.envClass` taking precedence. |
| `environmentBranchId` | branch ID for preview scope, else `null` (2737) | previous scope and `delete` scope. |
| `artifactHash` | `Redacted.make(deploymentHash)` (2738) | Deployment reuse decision (2341-2343, 2497-2498), recovery and pending guards (2402, 2448). Legacy plain strings are accepted (1106-1107). |
| `local` | `false` live, `true` dev | `diff` (2186), `read` (2211), `delete` (2752). |

`deploymentHash` is `sha256Object({ artifact: artifact.hash, branchId: app.branchId, environmentClass, environmentBranchId })` (2335-2340), and `artifact.hash` itself includes the plaintext env map, `envClass ?? "production"` and port (section 11). So a change to any env value, the port, the artifact bytes, the bundle, or the branch produces a new deployment; otherwise the persisted deployment is reused.

---

## 3. Binding contract

Fourth type parameter (Compute.ts:657-659):

```ts
{
  env?: Record<string, string | Redacted.Redacted<string> | null | undefined>;
}
```

`activeBindingEnv` (Compute.ts:2161-2173) drops bindings whose `action === "delete"`, takes `binding.data?.env` from each, and shallow-merges them in order. Reconcile then does (2271-2278):

```ts
env: { ...bindingEnv, ...news.env }
```

so an explicit `env` prop wins over a binding with the same key. The dev provider does the same (2787-2794).

**Who uses the `bindings` channel today.** Nothing in the repository's source calls `host.bind` on a Compute. The only producers of `bindings` with `env` data are hand-built inputs in `packages/integration-tests/test/Prisma/Compute.test.ts` (for example lines 4270-4280, 4388-4393, 4612). The Compute JSDoc and tests treat `bindings` as a supported contract, but no binding service targets it.

**How bindings actually reach Compute.** Every Prisma binding service and the generic AWS path write through the **runtime context's `set`**, which collects values in `runtimeContext.env`. Platform then merges that into the resource props after the init Effect runs (`packages/alchemy/src/Platform.ts:630-637`):

```ts
instance.Props = {
  ...props,
  env: { ...props?.env, ...runtimeContext.env },
  exports: runtimeContext.exports ? yield* runtimeContext.exports : undefined,
};
```

So binding values arrive in `news.env`, not in `bindings`, and **here the binding value wins over a user `env` key of the same name** (the opposite precedence from the `bindings` path above).

Compute's `set` (Compute.ts:892-912) normalises the key and JSON-encodes the value:

```ts
const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
env[key] = output.pipe(Output.map((value) =>
  Redacted.isRedacted(value)
    ? Redacted.make(JSON.stringify({ _tag: "Redacted", value: Redacted.value(value) }))
    : JSON.stringify(value)));
```

Plain strings are therefore stored on Prisma with JSON quotes. This differs from core's `packEnvValue`, which stores plain strings verbatim (`packages/alchemy/src/RuntimeContext.ts:139-160`). The runtime `get` (913-936) reads `process.env[key]` directly and JSON-decodes, rebuilding `Redacted` from the marker.

Files that bind onto Compute (all via `set`, through `Output.bind` or `yield*` of an Output, `packages/alchemy/src/Output.ts:135-145`):

- `Connect.ts:271-336` (`ConnectBinding`): binds eight keys from `connectEnvKeys` (`PRISMA_<NAME>_CONNECTION_ID`, `_DATABASE_ID`, `_DIRECT_CONNECTION_STRING`, `_POOLED_CONNECTION_STRING`, `_ACCELERATE_CONNECTION_STRING`, `_HOST`, `_USER`, `_PASSWORD`; 143-173). Optional values are encoded with the prefix `__ALCHEMY_PRISMA_CONNECTION_VALUE__:` because "Compute env sync omits undefined and treats null as deletion" (175-218).
- `BucketBinding.ts:54-77` used by `ReadBucket.ts:196-200` (role `read`), `WriteBucket.ts:183-187` (role `read_write`), `ReadWriteBucket.ts:89-93` (role `read_write`). Each creates a `BucketAccessKey` resource with logical ID `<bucket><Capability>BucketAccessKey` and yields its `endpoint`, `bucketName`, `accessKeyId`, `secretAccessKey` Outputs, each of which becomes an env var.
- Config lookups inside an effect-native init: Platform's ConfigProvider interceptor binds every `Config` value read at plan time into the runtime context (`Platform.ts:538-574`), so `Config.String("X")` in a Compute init becomes an env var.
- `packages/aws/src/AWSBindings.ts:240-330` (`Bind`): for a host that is not an IAM role, a Google service account, or a Fly machine, it creates an IAM user and access key and writes the key into the host env with `runtime.set`. A Compute host falls into this branch (inferred from the conditions; not tested in this read).
- `Connection.ts` and `BucketAccessKey.ts` only document passing outputs through the `env` prop; they do not bind.

`CustomDomain.ts:46` accepts a `Compute` as its `app` reference and reads `appId` from it (169-177).

---

## 4. How Compute is declared: `Platform`

Compute.ts:851-955:

```ts
export const Compute: Platform<Compute, ComputeRuntimeServices, ComputeShape, ComputeRuntimeContext> & {
  <PropsReq = never>(id: string, props: InputProps<ComputeProps> | Effect.Effect<...>): Effect.Effect<Compute, never, Providers | PropsReq>;
} = Platform(ComputeTypeId, { createRuntimeContext: (id) => { ... } });
```

Only the `createRuntimeContext` hook is used (no `aliases`, `onCreate`, `transformProps` or `methods`). `ComputeRuntimeServices = ProcessServices`, `ComputeShape = Main<ProcessServices>` (663-669).

What `Platform` provides (core `Platform.ts`):

- An underlying `Resource("Prisma.Compute", { requiresImplementation: true })` (300-303).
- Three call forms:
  - `yield* Prisma.Compute("id", props)` with no implementation: props are marked `isExternal: true` (332-343). Compute then treats it as a path/build/artifact deployment even if `main` is set (Compute.ts:674-675).
  - `Prisma.Compute("id", props, impl)` inline: eager instance (437-447).
  - Class form `class Api extends Prisma.Compute<Api>()("Api", propsOrEffect, impl) {}` (constructor with no id, 319-326), and a bare tag whose `.make(props, impl)` arrives later. Used in `examples/prisma-compute-effect/src/Api.ts:12`, `examples/prisma-tutorial/src/Api.ts:8`, `packages/integration-tests/test/types/PrismaCompute.ts:19`.
- When an implementation is present, `make` (463-659) resolves props, calls `createRuntimeContext(id)`, registers the resource, runs `impl` with `RuntimeContext`, `Platform`, `Self` and `ServerHost` (because Compute's context has `run`, 603-608), runs the ConfigProvider interceptor, calls `runtimeContext.serve(fetch, { shape })` when the impl has `fetch` or other methods (503-533), then rewrites `Props.env` and `Props.exports` (630-637).

Compute's runtime context (Compute.ts:862-954):

- `Type`, `id`, `env` (the binding map).
- `set` / `get`: section 3.
- `run(effect)`: pushes to a `runners` list.
- `serve(handler)`: pushes a runner that, if an `HttpServer` service exists, serves the handler with `RuntimeContext` provided, then waits forever. The second argument (`{ shape }`, RPC methods) is ignored, so RPC methods on the impl shape are not exposed.
- `exports`: `{ default: Effect.forEach(runners, r => Effect.forever(r logging and ignoring errors), { concurrency: "unbounded" }) }`.

Bundling is **not** done by Platform. Compute does it itself in `bundleEffectCompute` (Compute.ts:1523-1603), using `props.main` and `props.handler`. The generated virtual entry (1565-1573):

```ts
import { bootstrap } from "@alchemy.run/prisma/Bootstrap";
import entrypoint from "<main>";            // or `import { <handler> as entrypoint }`
await bootstrap(entrypoint, {"port":<port>,"stack":{"name":...,"stage":...}});
```

`Bootstrap.ts:30-64` sets `PORT` if missing, builds Bun services, a Bun HTTP server on `0.0.0.0`, a ConfigProvider with `ALCHEMY_PHASE: "runtime"` over `process.env`, and runs `resolveProgram("default")` over `entrypointLayer(entrypoint)`: at runtime the user's module default export is re-evaluated, the same init runs, and `exports.default` runs the registered `serve`/`run` loops.

---

## 5. `diff` (Compute.ts:2184-2209)

| Condition (checked in order) | Result |
|---|---|
| `news` is not a plain input object (an Output or Effect) | `undefined` (engine default) |
| `output.local` or `output.appId` starts with `dev:` | `update` |
| old project ID (`output.projectId ?? concrete olds.project`) and new concrete project ID (only if `news.project` is resolved) are both known and differ | `replace` |
| `news.regionId` resolved and defined, current region (`output.regionId ?? olds.regionId`) defined, and they differ | **fail** with `ComputeInvalidProps` ("region is immutable ... deploy a second Compute App under a different appName") |
| anything else | `update`, always, because source files can change without a prop change (2206-2208) |

Diff never returns no-op. Every deploy runs reconcile, which runs the build (section 11) and decides from the hash whether to create a deployment. `list` returns `[]` (2183): App's provider owns teardown enumeration.

---

## 6. `read` (Compute.ts:2210-2268)

1. `output.local` → return `output` unchanged.
2. App lookup: if `output.appId` is a real ID → `getService({ serviceId })`, NotFound → `undefined`. Otherwise `findApp(olds.project, appName or physical name, olds)`: `getServices` (all pages) filtered by name, then branch resolution via `desiredComputeBranchId` (`getProjectBranches`), then filter by `branchId`; more than one match → `ComputeConflict` (1060-1076). `olds` is dereferenced without a guard (2214); whether `olds` can be undefined here is not checked in this read.
3. No App → `undefined`.
4. Deployment: `getDeployment(output.deploymentId)` (NotFound → undefined). If found, `ensureDeploymentMembership(app.id, deployment, app.latestDeploymentId)`: when the deployment is not the latest, lists `getServiceDeployments` and requires exactly one match with the same `foundryVersionId`, else `DeploymentIdentityConflict` (`internal/DeploymentIdentity.ts:15-46`). If no saved deployment, falls back to `app.latestDeploymentId`.
5. Builds attributes from live data for `appId`, `deploymentId`, `projectId`, `appName`, `regionId`, domains, `url`, `promoted`; copies `previousDeployment*`, `readinessStatus`, `pendingDeploymentCleanup`, `environment*` from `output`. `environmentClass` falls back to `olds.envClass`.
6. `artifactHash` is kept only when the saved deployment was found; with the latest-deployment fallback it is cleared (2262-2264), which forces a new deployment on the next reconcile.
7. Ownership: returns `attrs` when the App was found by saved `appId`, and `Unowned(attrs)` when found by name (2267). The engine then refuses takeover unless adoption is enabled.

---

## 7. `reconcile` (Compute.ts:2269-2750), step by step

API calls are distilled `@distilled.cloud/prisma/management` operations. "Membership check" means `ensureDeploymentMembership` (may call `getServiceDeployments`).

**Preparation (no cloud writes)**

1. `bindingEnv = activeBindingEnv(bindings)` (2270).
2. `effectiveNews = { ...news, appName: createAppName(id, news.appName), env: { ...bindingEnv, ...news.env } }` (2271-2278).
3. `validateComputeProps(effectiveNews)` (2279).
4. `projectId = resolveProjectId(project)` (2280). Fails with `RefsOperationFailed` if not a string.
5. `artifact = resolveArtifact(effectiveNews)` (2281). Runs the build, bundle and archive on the local machine (section 11). Returns `{ file?: ArtifactFile, hash, port }`. `cleanupArtifact = artifact.file?.cleanup`, and `releaseArtifactOnFailure` wraps the next three steps so the temp file is removed if they fail (2282-2286).

**App**

6. If `skipCodeUpload`: `observedApp = findExistingApp(output)` → `getService(output.appId)`, NotFound → undefined (1778-1786). It is wrapped in a NotFound retry (2290-2293), but NotFound is already caught inside, so the retry never triggers on NotFound.
7. `ensureSkipCodeUploadCanFork`: with `skipCodeUpload`, requires `observedApp.latestDeploymentId`, else `ComputeInvalidProps` (1844-1852). It only looks at the App from saved state.
8. `ensureApp` (1788-1842), retried on `NotFound` with exponential backoff from 500 ms, at most 6 retries (972-975, 2299-2304):
   1. `app = observedApp ?? findExistingApp(output)` (`getService`).
   2. Branch: explicit non-dev `branchId` is used as is; otherwise `getProjectBranches` (paged, with `gitName` if given), keeping `isDefault` branches when no git name; more than one → `ComputeConflict`; none → `ComputeOperationFailed`.
   3. No App → `createService({ projectId, displayName, branchId, regionId? })` with `Retry.none`. On `Conflict` → `findApp`; if the match equals `output.appId`, use it (`created: false`); otherwise `ComputeConflict` "already exists ... not owned".
   4. `ensureAppImmutableIdentity(app, projectId, props.regionId ?? output.regionId ?? app.region.id)` → `AppIdentityConflict` on project or region mismatch.
   5. If name or branch differs → `updateService({ serviceId, displayName, branchId })`.
   6. Returns `{ app, created }`. Compute never sets the App's `logicalId` (Prisma.App does).
9. `cleanupCreatedAppOnFailure` (2308-2322): if the App was created in this run and `preserveCreatedAppOnFailure` is false, `destroyApp(app.id)` (`deleteService`, up to 5 attempts on `Conflict`, NotFound is success; `ComputeLifecycle.ts:280-309`), then re-fail with the original error; a cleanup failure becomes `PrismaCleanupFailed`. It only covers failures from step 10 onward. A failure inside step 8 after `createService` succeeded (for example `updateService` or the identity check) does not clean up the new App.

**Inner body (2330-2740)**

10. `resolveComputeEnvironmentScope` (1921-1940): requires `app.branchId` (else `ComputeConflict`); `getBranch({ branchId })`; class = `branch.role`; if `envClass` is set and differs → `ComputeInvalidProps`; scope = `{ class: role, branchId: role === "preview" ? app.branchId : null }`.
11. `deploymentHash` (2335-2340); `outputArtifactHash` unwrapped from state (2341-2343).
12. `persistedDeployment = getDeployment(output.deploymentId)`, NotFound → undefined (2344-2348). `terminalFailedDeploymentId` = its ID if status is `failed` (2349-2350). `promotionRequested = !skipPromote` (2351).
13. **Terminal-failure guard** (2377-2388). If the saved deployment failed, promotion is requested, saved `promoted` is true, and the App's latest deployment is a different non-null one → `ComputeDeploymentRecoveryFailed` ("cannot prove that the live deployment is the interrupted replacement"). No changes are made.
14. **Interrupted-promotion recovery** (2397-2446). Condition: promotion requested, saved `promoted` true, saved `deploymentId` set, no terminal failure, `outputArtifactHash !== deploymentHash`, and `app.latestDeploymentId` is non-null and differs from the saved deployment. Meaning: a previous run promoted a new generation, its stable check failed, and rollback did not converge, so state still names the old generation.
    - `createServiceRollback({ serviceId, deploymentId: saved })` (result kept, not failed on).
    - `waitForAppDeploymentTarget(app.id, saved, props)`: polls `getService` until `latestDeploymentId === saved` (default 60 s).
    - If it did not converge → `ComputeDeploymentRecoveryFailed` (nothing else changed).
    - If it converged → `app = observed`; `destroyDeployment(displaced)`: `getDeployment`, `createDeploymentStop` if running or provisioning, wait for `stopped`, `deleteDeployment` (`ComputeLifecycle.ts:214-273`). Failure → `ComputeDeploymentRecoveryFailed` naming `DELETE /v1/deployments/<id>`. Then reconcile continues to the normal flow.
15. **Pending-readiness guard** (2448-2452): saved `readinessStatus === "pending"` and the hash changed → `ComputeNotReady`. The current code never writes `"pending"`.
16. **Pending cleanup drain** (2456-2468): if a saved `pendingDeploymentCleanup` exists, saved readiness is not `"pending"`, and it is not the App's live deployment → `cleanupPreviousDeployment` (2353-2375): `getDeployment` (NotFound counts as done), membership check, then `destroyDeployment` for `destroy`, or `createDeploymentStop` + wait `stopped` for `stop`. A failure here fails the reconcile before any env or deploy change. If the pending deployment is the live one, the record is dropped. After this step `persistedPendingCleanup` is always undefined unless saved readiness was `"pending"`, so the reuse of its `action` at 2695 is reachable only for old state.
17. **Environment sync** (2469-2483): previous scope = `(olds?.envClass ?? output.environmentClass ?? "production", output.environmentBranchId ?? null)`. `syncComputeEnvironmentInternal(projectId, current class, env, current branch, sameScope ? output.environmentVariableIds : {})`. Detail in section 9. API: `getEnvironmentVariables` per key, then `updateEnvironmentVariable` / `createEnvironmentVariable` (`Retry.none`) / `deleteEnvironmentVariable`. Created IDs are recorded in `createdEnvironmentVariableIds` for rollback.
18. **Removed-key cleanup** (2489-2495): `cleanupRemovedComputeEnvironment` deletes previously owned keys that are no longer present (or all of them if the scope changed). Done before deployment creation "so deleted keys cannot be captured into the new runtime".
19. **Deployment reuse** (2497-2516): reuse `persistedDeployment` only when `outputArtifactHash === deploymentHash`. If reusing, or if the saved one is terminal failed, run the membership check on it. A terminal failed deployment is never reused.
20. **Create and upload** (2534-2578), only when not reusing:
    - `createServiceDeployment({ serviceId, portMapping: { http: artifact.port }, skipCodeUpload? })` with `Retry.none`.
    - If there is an artifact file and no `uploadUrl` → destroy that deployment, fail `ComputeOperationFailed`.
    - `uploadArtifact(uploadUrl, file, "application/gzip")` (`Deployment.ts:453-484`: size check <= 768 MiB, credential-free HTTPS URL check, `executeArtifactUpload`). Failure → destroy the created deployment.
    - `getDeployment(created.id)`; NotFound → synthesise `{ status: "new", previewDomain: null }`; other errors → destroy the created deployment.
    - `cleanupCreatedDeploymentOnFailure` (2518-2532) only deletes a deployment created in this run.
21. **Previous deployment** (2580-2587): `previousDeploymentId = terminalFailedDeploymentId ?? persistedPendingCleanup?.deploymentId ?? (app.latestDeploymentId if not the current one) ?? null`. `rollbackDeploymentId` is the same, except null when it is the terminal failed one.
22. **Start** (2589-2611), when `start ?? true`: if status is not running or provisioning, `createDeploymentStart` (a `Conflict` is accepted if the deployment is now running or provisioning). `waitForDeploymentStatus(id, "running", props)` polls `getDeployment`; `failed` → `PrismaDeploymentFailed`; timeout → `PrismaDeploymentWaitTimeout`. Then `waitForDeploymentUrl(previewUrl, props)` (section 7a). Any failure → delete the deployment if created in this run, then fail.
23. **Promote** (2613-2624), when promotion is requested: set `preserveCreatedAppOnFailure = true`, then `promoteAppObserved(app.id, deployment.id, props)` (`internal/AppPromotion.ts:110-193`): `createServicePromote`; on success, wait for the App's latest to equal the deployment, else `AppPromotionNotConverged`. On a failed promote call: `getService`; if already latest, success; else `createServiceRollback` to the same deployment as a repair, observe again; still wrong → `AppPromotionNotConverged`. Promotion is replayed every run, even when already latest, because it "also repairs endpoint/custom-domain routing drift". When promotion is skipped, `promoted` is `app.latestDeploymentId === deployment.id`, so a reused live deployment counts as promoted.
24. **Stable readiness** (2626-2687), when `promoted && verifyUrl !== false`: `waitForDeploymentUrl(stable URL)`.
    - Success → `readinessStatus = "ready"`.
    - Failure with a rollback target → `createServiceRollback({ deploymentId: rollbackDeploymentId })`, then `waitForAppDeploymentTarget`.
      - Converged → delete the new deployment if created in this run, then fail with the readiness error (or `ComputeDeploymentRecoveryFailed` if the rollback response was lost).
      - Not converged → `ComputeDeploymentRecoveryFailed`; neither deployment deleted. Because the reconcile fails, state keeps the previous output (`promoted: true`, old `deploymentId`), so the next run takes step 14.
    - Failure with no rollback target (first deployment, or the previous one is terminal failed):
      - App created in this run → `preserveCreatedAppOnFailure = false`, so the outer handler deletes the whole App (step 27).
      - App pre-existing → `deploymentConverged = true` (env changes are kept) and the deployment stays live.
      - With a terminal failed predecessor → `ComputeDeploymentRecoveryFailed`; otherwise the readiness error.
25. **Previous deployment cleanup** (2689-2717): `deploymentConverged = true`. When promoted and a different previous deployment exists, action = saved pending action if it matches, else `destroy` if the previous is terminal failed or `destroyOldDeployment`, else `stop`. `cleanupPreviousDeployment` runs under `Effect.result`: success sets `previousDeploymentAction` and clears pending; failure logs a warning and leaves `pendingDeploymentCleanup` in the output for the next run.
26. **Return** attributes (2719-2740).

**Outer handlers (2741-2749), in order**

27. If `deploymentConverged` is false → `rollbackCreatedEnvironmentVariables(createdIds, error)`: deletes created variables in reverse order (NotFound ignored); if any delete fails → `ComputeEnvironmentRollbackFailed` listing `DELETE /v1/environment-variables/<id>` (1948-1974). Updated values and deleted keys are **not** restored.
28. `cleanupCreatedAppOnFailure` (step 9).
29. `Effect.ensuring(cleanupArtifact)`: temp artifact file removed on every exit.

### 7a. `waitForDeploymentUrl` (Compute.ts:1325-1428, exported)

Skipped when `verifyUrl === false`. Missing URL → `ComputeUnexpectedResponse`. No `HttpClient` service → silently skipped without a health check, `ComputeOperationFailed` with one. Probe URL = the URL, or `new URL(healthCheck.path, url)`. Loop until `urlReadinessTimeoutSeconds` (default 60): GET with `redirect: "manual"`, each request at most 5 s. A non-404 accepted status succeeds without reading the body. Otherwise up to 64 KiB of body is read (2 s budget); success unless it is Prisma's edge "Service not found" page and the status is accepted. Timeout → `ComputeUrlTimeout`. "Accepted" means any status without a health check, `statusCodes` or 2xx with one.

---

## 8. `delete` (Compute.ts:2751-2765)

1. `output.local` or `dev:` app ID → `stopTrackedDevProcess(output.appId)` and return.
2. `destroyComputeEnvironment(projectId, scope(olds?.envClass ?? output.environmentClass ?? "production", output.environmentBranchId), output.environmentVariableIds)` (2066-2087): per owned key, `getEnvironmentVariables`; skip if missing, if the ID changed, or if system-managed; else `deleteEnvironmentVariable` (NotFound ignored).
3. `destroyApp(output.appId)`: `deleteService`, retried up to 5 times on `Conflict` (250 ms × 2^n), NotFound is success. The App delete cascades its deployments; Compute does not stop or delete deployments itself and does not wait.

`tail` (2766-2767): `tailDeploymentLogs(output.deploymentId)` (`PrismaLogs.ts:117`), current deployment only.

---

## 9. Environment variable handling

**Scope.** Determined from the App's attached branch, not from props: `getBranch(app.branchId).role` gives the class; `branchId` in the scope is the App's branch for `preview`, and `null` (project-level template) for `production` (1921-1940). `envClass` is only a consistency check. `findEnvironmentVariable` (1854-1886) queries `getEnvironmentVariables({ projectId, class, key, branchId? })` over all pages and picks the row whose `branchId === (branchId ?? null)`.

**Ownership map.** `environmentVariableIds: Record<key, id>`. It is the only proof of ownership because the API has no ownership marker and returns redacted values (JSDoc 477-482). When the scope changes, the previous map is not passed in (2479-2481), so nothing in the new scope counts as owned.

**Sync algorithm** (`syncComputeEnvironmentInternal`, 1976-2049):

1. Observe and validate every key before any write (1989-2006). For each key in `plainEnv(env)` (`undefined` dropped, `Redacted` unwrapped): validate; look it up; if it exists and `isManagedBySystem` → `ComputeEnvironmentVariableSystemManaged`; if it exists and `ownedIds[key] !== variable.id` → `ComputeEnvironmentVariableNotOwned` (the message tells the user to use a standalone `Prisma.EnvironmentVariable` or delete the variable). This also applies to `null` (delete) requests for a key that exists but is not owned.
2. Apply upserts in key order: existing → `updateEnvironmentVariable({ envVarId, value })`; missing → `createEnvironmentVariable({ projectId, branchId?, class, key, value })` with `Retry.none`. Each written key goes into `nextOwnedIds`.
3. Apply deletions after all upserts: for `null` values whose variable exists → `deleteEnvironmentVariable`. A `null` key is dropped from ownership; a `null` key that does not exist is a no-op.
4. A failure during apply deletes the variables created in this call (reverse order) and re-fails.

**Removal cleanup** (`cleanupRemovedComputeEnvironment`, 2089-2114): for each previously owned key, skip it if the scope is unchanged and the key is still in `env` (even as `null`); otherwise look it up in the old scope and delete it if the ID still matches and it is not system-managed. A key whose ID changed is silently dropped from ownership. Unlike `destroyComputeEnvironment`, the lookup here does not catch NotFound (2100-2105).

**Exported helper.** `syncComputeEnvironment` (2051-2064) wraps the internal function and drops `createdIds`. It is used only by tests (`packages/integration-tests/test/Prisma/Compute.test.ts:11`) and named in a `Providers.ts:112-113` doc comment.

**Redaction.**
- Values in the `env` prop are persisted in Alchemy state exactly as given; plain strings are plaintext in state (JSDoc 473-476).
- Outputs record only keys (`environmentKeys`) and IDs, never values.
- `artifactHash` hashes the plaintext env map without a salt (`sha256Object({ ..., env })`, 1628-1633 etc.) and stores the digest `Redacted`. `Prisma.Deployment` salts its `triggers` hash for exactly this reason (`Deployment.ts:403-425`); Compute does not.
- Binding values travel as `Redacted` when the source Output is `Redacted`.

---

## 10. Dev mode and the local provider

Registration (2833-2837):

```ts
export const ComputeProvider = () =>
  ProviderLayer.dual(Compute, { local: () => ComputeDevProvider(), live: () => ProviderLive() });
```

`ComputeDevProvider` (2772-2831) is a plain `Provider.effect`, not built with `LocalProvider.make`. The dev process registry is a module-level `Map<string, ChildProcessHandle>` (957). The repository's doctrine says running-process local providers must use `LocalProvider.make` (`AGENTS.md`, section "LocalProvider.make").

- `diff`: always `update`. `read`: returns `output` only when `output.local`. `list`: `[]`.
- `reconcile`: merges binding env the same way as live; `validateComputeProps`; `resolveProjectId`; fails with `ComputeOperationFailed` unless `AlchemyContext.dev`; `startDev(id, props)`; returns attributes with `appId: output?.appId ?? "dev:<id>"`, `deploymentId: undefined`, `appName: appName ?? id` (not the physical name), `regionId ?? "us-east-1"`, every URL and domain field set to the local URL, `promoted: false`, `readinessStatus: "skipped"`, `environmentVariableIds: {}`, `environmentClass: envClass ?? "production"`, `environmentBranchId: null`, `artifactHash: undefined`, `local: true`.
- `delete`: `stopTrackedDevProcess(output.appId)`.

`startDev` (2116-2159):
- Local URL = `dev.url`, else `http://localhost:<dev.port ?? port>` when a port is set.
- No `dev.command` → returns the URL and runs nothing.
- Otherwise kills any tracked process for `dev:<id>`, then spawns `dev.command` through a shell in `dev.cwd ?? path`, with env `{ NODE_ENV: "development", ...env, ...dev.env, PORT }` (Redacted unwrapped, `null` dropped) on top of the parent env. stdout and stderr lines become log records. There is no readiness wait.
- Because diff always returns update, every dev reconcile restarts the process.

What it emulates: only "a local process and URL". It does not build, bundle, run the effect-native `main`, create env vars, or apply health checks. An effect-native Compute in dev runs nothing unless `dev.command` is set.

---

## 11. Build and bundle (`resolveArtifact`, Compute.ts:1605-1776)

Every path returns `{ file, hash, port }`. `file` is an `ArtifactFile` (a verified temp `tar.gz` with `sha256`, `size`, `cleanup`). `env = plainEnv(props.env)`, `envClass = props.envClass ?? "production"`.

| Path (first match wins) | What runs | `hash = sha256Object(...)` | `port` |
|---|---|---|---|
| Effect-native (`isExternal !== true` and `main` or `exports`) | `bundleEffectCompute` (1523-1603): `Bundle.build` (rolldown) on `realPath(main)`, `cwd = findCwdForBundle`, `platform: "node"`, Bun condition names, user plugins plus the virtual bootstrap entry, unresolved-import checks off; output ESM, `sourcemap: "hidden"`, `minify: true`, `entryFileNames: "index.js"`. Files are written to a temp directory (duplicate paths rejected; the **first** output file is taken as the entrypoint, 1517), then `createComputeArchive({ output: "file" })`. | `{ bundle: bundle.hash, env, envClass, port }` | `port ?? 8080` |
| `skipCodeUpload` | nothing | `{ skipCodeUpload: true, env, envClass, port }` | `port ?? 8080` |
| `artifactPath` | `readUploadArtifact({ artifactPath, output: "file" })` (`Deployment.ts:331-359`: inspect file, <= 768 MiB) | `{ artifact: sha256, env, envClass, port }` | `port ?? 8080` |
| `build: "auto"` or `{ type: "auto" }` | `runComputeAutoBuild` (`ComputeBuild.ts:537-553`): tries Next.js, Nuxt, Astro, (NestJS), TanStack Start, Vite, Bun strategies; returns a `ComputeBuildArtifact` (directory, entrypoint, `defaultPort`, `archiveIgnorePrefix`, `requiredFiles`, `cleanup`). Then archive. | `{ artifact: sha256, env, envClass, port }` | `port ?? defaultPort ?? 8080` |
| `build: { type: "static" }` | `runComputeStaticBuild` (`ComputeBuild.ts:555+`): optional command, verifies `outdir` and `indexPage`, stages files with a production HTTP server. Then archive. | same | `port ?? defaultPort ?? 8080` |
| `build: { command, outdir }` | `runBuildCommand` in `cwd` with `build.env` (no ambient Prisma tokens), then archive `cwd/outdir` with `build.entrypoint ?? entrypoint ?? package.json#main` | same | `port ?? 8080` |
| no build | archive `path` with `entrypoint ?? package.json#main` | same | `port ?? 8080` |

`createComputeArchive` (`ComputeArchive.ts:145-160`) applies the always-ignored patterns, user `archiveIgnore` (prefixed by `archiveIgnorePrefix`), `requiredFiles`, size limits (768 MiB uncompressed and compressed, 128 MiB per file, 50,000 entries) and a manifest (`COMPUTE_MANIFEST_VERSION = "1"`).

**Separability.** `resolveArtifact` makes no Management API calls and needs nothing from the App, so the whole build is separable from deployment. Its couplings:
- `hash` mixes the artifact bytes with `env`, `envClass` and `port`, so today "artifact identity" and "deployment inputs" are one value.
- `port` comes from the build output for auto and static builds, and it feeds `createServiceDeployment`'s `portMapping`.
- The temp file lives only for the reconcile (`Effect.ensuring(cleanupArtifact)`), so a separate artifact resource would need a durable path. `Website/Artifact.ts` (`Prisma.WebsiteArtifact`, attributes `directory`, `artifactPath`, `hash`) already does this for websites.
- The build runs on every deploy because diff always returns update; there is no memoisation in Compute itself.

---

## 12. Exports of Compute.ts and their importers

`index.ts:8` re-exports everything (`export * from "./Compute.ts"`), and the package also exposes `@alchemy.run/prisma/Compute`. Importers found by grepping `packages`, `examples` and `website/src` (excluding `node_modules`, `submodules`, `dist`, `lib`):

| Symbol | Kind | Referenced by (besides Compute.ts) |
|---|---|---|
| `Compute` | interface + Platform constant | `Providers.ts:17,177`, `CustomDomain.ts:18` (type), `Website/FrameworkSite.ts:11`, tests (`Compute.test.ts`, `Resources.test.ts`, fixtures `isolated-project-compute.ts`, `traced-compute.ts`, `read-/write-/readwrite-compute.ts`, `types/PrismaCompute.ts`), many examples as `Prisma.Compute` |
| `ComputeProvider` | provider layer factory | `Providers.ts:17,197`, `Compute.test.ts`, `PublicSurface.test.ts` |
| `ComputeDevProvider` | provider factory | `Compute.test.ts`, `PublicSurface.test.ts` |
| `ComputeProps` | type | `Website/FrameworkSite.ts:11`, `Compute.test.ts`, `SourceConventions.test.ts` |
| `syncComputeEnvironment` | function | `Compute.test.ts`, `PublicSurface.test.ts`; doc comment in `Providers.ts:112` |
| `waitForDeploymentUrl` | function | `Compute.test.ts`, `PublicSurface.test.ts` |
| `isCompute` | guard | `PublicSurface.test.ts` only |
| `ComputeConflict`, `ComputeInvalidProps`, `ComputeNotReady`, `ComputeOperationFailed`, `ComputeUnexpectedResponse`, `ComputeUrlTimeout`, `ComputeEnvironmentVariableSystemManaged`, `ComputeEnvironmentVariableNotOwned`, `ComputePackageJsonError` | tagged errors | `PublicSurface.test.ts` only |
| `ComputeEnvironmentRollbackFailed`, `ComputeDeploymentRecoveryFailed` | tagged errors | `Compute.test.ts`, `PublicSurface.test.ts` |
| `ComputeStaticBuild`, `ComputeDev` | types | `SourceConventions.test.ts` |
| `ComputeCommandBuild`, `ComputeAutoBuild`, `ComputeBuild`, `ComputeBundleOptions`, `ComputeHealthCheck`, `ComputeRuntimeServices`, `ComputeShape`, `ComputeRuntimeContext` | types | no references outside Compute.ts |

---

## 13. What is layered on top of Compute

**`Website/FrameworkSite.ts`.** `deployWebsite` (159-199) is the single caller. It is used by `makeFrameworkSite` (202-245), which backs `Astro`, `Foldkit`, `Nextjs`, `Nuxt`, `Octane`, `ReactRouter`, `SolidStart`, `SvelteKit`, `TanStackStart`, `Vinext`, `Vite`, `Vocs` and `Waku`, and by `StaticSite.ts:141`. The call:

```ts
const compute = yield* Compute("Compute", {
  ...props.compute,           // WebsiteComputeOptions: appName, port, envClass, start, skipPromote,
                              // destroyOldDeployment, timeoutSeconds, pollIntervalMs, verifyUrl,
                              // healthCheck, urlReadinessTimeoutSeconds  (FrameworkSite.ts:28-41)
  project: typeof project === "string" ? project : project.projectId,
  artifactPath: artifact.artifactPath,   // Output from Prisma.WebsiteArtifact
  isExternal: true,
  port,                                   // compute.port ?? 3000
  regionId, branchId, branchGitName,
  env: { ...props.env, PORT: String(port), HOST: "0.0.0.0", NODE_ENV: "production" },
});
```

It relies on these outputs: `compute.appEndpointDomain` (mapped to the `switchboard.<region>.prisma.build` CNAME target, 179-187), the Compute itself as `CustomDomain`'s `app` (reads `appId`, 188-196), and `compute.url` as the site URL when there is no custom domain (197). The whole `Compute` object is returned as `Website.compute`. The website owns the build (`Server` or `Command.Build`) and the archive (`WebsiteArtifact`); Compute only re-reads and hashes the archive. During native dev no Compute is declared (220-227; `StaticSite.ts:71-130`).

**Other wrappers.** None in the repository's source. `CustomDomain` consumes Compute but is not a wrapper. `App.ts` and `Deployment.ts` mention Compute only in doc comments. The `list` comment at Compute.ts:2181-2182 calls Compute "a composite over App + Deployment", but it does not use those resources; it calls the shared helpers directly.

---

## 14. Compute compared with `Prisma.Deployment` (Deployment.ts)

**Compute does, Deployment does not:**
- Build, bundle and archive (Deployment only uploads `artifactPath` or forks).
- Create and maintain the App (name, branch, region identity checks).
- Sync environment variables with ownership, rollback and removal cleanup.
- Reuse the saved deployment when the hash matches. Otherwise it creates a new deployment inside an update, so `deploymentId` changes while only `appId` is stable. Deployment instead keeps `deploymentId` stable and plans a replacement in `diff` when port, `skipCodeUpload`, `artifactPath`, content type, artifact hash, app, or `triggers` change (`Deployment.ts:495-561`).
- Preview URL readiness and the optional health check before promotion; stable URL readiness after promotion. Deployment only waits for status `running` (`Deployment.ts:706-731`).
- Automatic rollback on stable readiness failure, recovery of an interrupted promotion on the next run, and refusal when a terminal failed generation and a different live one disagree.
- Stop or destroy the previous deployment, with a persisted retry record (`pendingDeploymentCleanup`).
- Delete a newly created App when the first deployment fails; delete a newly created deployment when start or upload fails (Deployment also does the latter).
- Pass `timeoutSeconds` and `pollIntervalMs` to status waits and promotion; Deployment uses the defaults (`Deployment.ts:717, 725, 736`).
- Always send `portMapping: { http: port }` with default 8080; Deployment sends it only when set and allows `http: null` to reset.
- Upload content type fixed to `application/gzip`; Deployment defaults to `application/octet-stream` and makes it configurable.
- `start` defaults to `true`; Deployment defaults to `false`, and `promote: true` implies start.
- Terminal failed saved deployment: Compute creates a fresh generation in the same update and destroys the failed one after success. Deployment's `diff` returns replace on `status === "failed"` and its reconcile refuses to touch it.
- Delete: Compute deletes owned env vars, then the whole App. Deployment deletes only its own deployment (membership check first) and maps a stop-wait timeout to `Provider.DeleteInProgress` (`Deployment.ts:746-765`).
- Logs: both `tail` the current deployment.

**Deployment does, Compute does not:**
- `triggers` with a salted, redacted fingerprint that forces replacement (`Deployment.ts:109-146, 403-451`).
- Persists `foundryVersionId`, `status` and `createdAt`; `read` can recover a deployment by `foundryVersionId` after lost state (`Deployment.ts:265-281, 562-582`). Compute stores no `foundryVersionId` and recovers only from saved IDs or the App's latest deployment.
- `diff` can return `undefined` (nothing to do). Compute always returns update.
- A dev stub provider with fabricated `dev:` IDs (`Deployment.ts:772-783`); Compute's dev provider runs a local process.
- Uses `started.previewDomain` from the start response (`Deployment.ts:715-722`).

---

## 15. Things that make decomposition hard, or that were surprising

1. **One hash spans three would-be resources.** `deploymentHash` = build output + plaintext env map + `envClass` + port + App branch + env scope (1628-1633, 2335-2340). Env, App branch and artifact changes all trigger a new deployment through this one value. Split into resources, the deployment would need these as explicit inputs (as `Deployment.triggers` does).
2. **Env sync must happen between App creation and deployment creation**, and removed keys must be deleted before the deployment is created, because Prisma snapshots env vars at deployment creation (2485-2495). This ordering is enforced inside one reconcile today.
3. **Env scope is derived from the App's live branch** (`getBranch(app.branchId).role`, 1929-1939), which is known only after `ensureApp`. Env var resources would depend on the App's branch, not on props.
4. **Rollback of env vars depends on whether the deployment later converged.** Created variables are deleted if any later step fails, including start, preview readiness, promotion and stable readiness (2741-2746). But when stable readiness fails on a pre-existing App with no rollback target, `deploymentConverged` is set to true (2677) and the env changes are kept. In separate resources an env var would already be committed when the deployment fails.
5. **Env rollback is partial.** Updated values and deleted keys are never restored (1948-1974). Only creations are undone.
6. **App cleanup on failure depends on deployment outcome.** A newly created App is deleted if anything up to promotion fails, kept once promotion starts (2620), and deleted again if the first deployment's stable readiness fails (2674-2675). Separate resources cannot delete their parent.
7. **A gap in App cleanup.** A failure inside `ensureApp` after `createService` succeeded (identity check or `updateService`) is not covered by `cleanupCreatedAppOnFailure`, and the new App ID is never persisted (1806-1839, 2298-2322).
8. **Saved state from a failed run drives the next run.** Because a failed reconcile does not write state, the previous output (`promoted: true`, old `deploymentId`) is what triggers interrupted-promotion recovery (2390-2446). That recovery only checks "promoted in state, latest differs, hash differs". It would also fire if someone promoted another deployment from the console and the user changed code: Alchemy rolls back to its saved deployment and **deletes** the other one (2434). Spreading this across resources means the recovery needs state from both the App (live target) and the deployment (saved generation).
9. **`previousDeploymentId` is computed from live App state, not from saved state** (2580-2585). Only `pendingDeploymentCleanup` carries across runs. A version-per-resource design would need to decide who owns stopping the displaced version.
10. **Dead or legacy-only branches.** `readinessStatus: "pending"` is never written, so the guard at 2448 and the reuse of the saved pending `action` at 2695 only matter for state from an older version. `persistedPendingCleanup` is always cleared before use otherwise (2456-2468).
11. **NotFound retries that never retry.** `findExistingApp` catches NotFound itself (1783), so the NotFound retry around it (2289-2294) does nothing for NotFound.
12. **Two binding channels with opposite precedence.** `bindings` env is overridden by `news.env` (2274-2277); runtime-context env from `Output.bind` overrides user `props.env` (Platform.ts:632-635). No source in the repository uses the `bindings` channel; only tests do.
13. **Binding values are JSON-encoded on the wire** (Compute.ts:899-910), so a plain string binding reaches Prisma with quote characters. Core's `packEnvValue` would store it verbatim. Anything reading those env vars outside the Effect runtime sees the JSON form.
14. **Effect-native mode is decided by props, not by the call form alone**: `isExternal !== true && (main || exports)` (674-675). `exports` is populated by Platform after the init runs (Platform.ts:636). `yield* Compute("x", { main })` without an implementation is treated as a path deployment.
15. **RPC methods on an effect-native impl are dropped.** Compute's `serve` ignores the `{ shape }` argument Platform passes (871-886 vs Platform.ts:527-531).
16. **Unsalted hash of secrets.** `artifactHash` digests plaintext env values without a salt; Deployment salts its equivalent.
17. **Port belongs to the build for auto and static builds** (1692, 1725), but to the deployment API call. A separate artifact resource would have to output its default port.
18. **Region immutability is a diff error, not a replacement** (2198-2205), while a project change is a replacement. `App.ts` makes its own choices for both (its diff returns replace at `App.ts:308`; the exact condition was not read).
19. **Identity differs from `Prisma.App`.** Compute creates Apps without `logicalId` and finds them by display name plus branch (1060-1076, 1078-1093). `Prisma.App` sets `logicalId` to the resource FQN by default and looks Apps up by it (`App.ts:76-85, 232-238, 402-477`). Moving Compute onto `Prisma.App` changes how existing Compute Apps are found after lost state.
20. **The dev provider does not follow the local-provider doctrine**: no `LocalProvider.make`, a module-level process map, no readiness wait, and a restart on every reconcile (957-970, 2116-2159, 2780-2782).
21. **Build runs on every deploy** because diff always returns update and Compute has no memoisation (2206-2208, 2281). In a split design, a separate artifact resource with its own hash could skip work that Compute repeats today.
22. **`olds?.envClass` overrides the saved `environmentClass`** when computing the previous scope (2470) and the delete scope (2759), even though the current scope ignores `envClass` and uses the branch role. Not verified whether this can pick the wrong scope; look at 2469-2472 with `envClass` set to a value the branch later stops matching.

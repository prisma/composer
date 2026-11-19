Every deploy of a `Prisma.Compute` deletes the version it replaces, so a rollback in the Prisma Console has nothing to return to. This keeps the replaced version, and makes `Prisma.Compute` a composition of child resources so the fix lives in one place:

```ts
const compute = yield* Prisma.Compute("api", { project, path: "./app", env: { LOG_LEVEL: "info" } });
```

```
+ api                    Prisma.Compute
+ api/Service            Prisma.ComputeService
+ api/Env/LOG_LEVEL      Prisma.EnvironmentVariable
+ api/Artifact           Prisma.ComputeArtifact
+ api/Version            Prisma.ComputeVersion
```

Before, `Prisma.Compute` was one resource with its own Management API code for the service, the variables, the build and the version. Now its provider makes no API calls. It declares the children and copies their outputs.

A changed artifact replaces `api/Version` only. `Prisma.ComputeVersion` has the default removal policy `retain`, so the replaced version stays on the platform and the Console can roll back to it.

### The same resources by hand

```ts
const service = yield* Prisma.ComputeService("web", { project });
const version = yield* Prisma.ComputeVersion("web-version", {
  service: service.serviceId,
  artifactPath: "./dist/app.tar.gz",
});
yield* Prisma.activateVersion(service, version);
```

`activateVersion` tells the service which version to serve. The service promotes it, checks its stable URL, and restores the version it served before when the check fails. A second `activateVersion` on one service fails the plan.

The version no longer promotes itself, because the platform stores the active version on the service. A version only uploads, starts, and checks its own preview URL.

### Breaking changes

`Prisma.App` and `Prisma.Deployment` take the names Prisma's platform uses for them.

- **Saved state is compatible.** The new resources declare the old type names as `aliases`, so rows saved as `Prisma.App` and `Prisma.Deployment` are read as the new types.
- **Code is not.** The old exports are removed, so a program that names `Prisma.App` or `Prisma.Deployment` must be renamed.

```diff
-Prisma.App  Prisma.Deployment  appId  deploymentId  appEndpointDomain  latestDeploymentId
+Prisma.ComputeService  Prisma.ComputeVersion  serviceId  versionId  serviceEndpointDomain  activeVersionId
-AppConflict  DeploymentInvalidProps  PrismaDeploymentWaitTimeout  destroyApp  destroyDeployment
+ComputeServiceConflict  ComputeVersionInvalidProps  PrismaComputeVersionWaitTimeout  destroyComputeService  destroyComputeVersion
```

The same rename applies to every `App*`/`Deployment*` error, helper, option and result field, and to `appName`, `deploymentEndpointDomain` and `deploymentUrl` on `Prisma.Compute`.

```diff
-yield* Prisma.Deployment("web", { app: app.appId, artifactPath, promote: true });
+const version = yield* Prisma.ComputeVersion("web", { service: service.serviceId, artifactPath });
+yield* Prisma.activateVersion(service, version);
```

| | Before | After |
| --- | --- | --- |
| A replaced version | deleted | kept; `RemovalPolicy.destroy()` or `destroyOldDeployment: true` deletes it |
| The version a service serves | deleted by the version's own delete | deleted only by the service's delete |
| `start` | implied by `promote: true` | defaults to `true` |
| A new version | not checked | checks its preview URL (`verifyUrl`, `healthCheck`); stopped and deleted if it fails |
| `artifactPath` | any archive | a tar.gz with `compute.manifest.json` at its root |
| `Prisma.Compute` attributes | its own bookkeeping fields | those are gone; adds `activeVersionId` and `composed` |
| `Prisma.EnvironmentVariable` | value required | a value that resolves to `undefined` declares no variable |
| Default service logical ID | `Site/Web` | `Site.Web`, because the platform refuses `/` |

A deploy that changes nothing still promotes the declared version again, which undoes a rollback made in the Console.

### Stacks that are already deployed

- **`Prisma.App` and `Prisma.Deployment`**: the next deploy keeps the same service and URL.
- **`Prisma.Compute`**: the deploy stops with `ComputeCannotUpgradeInPlace` and changes nothing. One saved row would have to become four, and the engine has no way to split a row. The options are to stay on the earlier release, or to remove the resource from state and deploy a new service with a new URL. `website/src/content/docs/prisma/compute/deployments.mdx` has the steps.

### Tests against a fake Management API

The main paths deploy to the real platform in `ActiveVersion.live.test.ts`, `ComputeArtifact.live.test.ts` and `Compute.live.test.ts`: an app and a static site deployed and destroyed, a new version with the old one kept, a platform rollback, an Effect-native Compute, and an unchanged redeploy.

This also adds a fake, `fixtures/ComputeCloud.ts`, which `AGENTS.md` rules out. About 20 cases use it for platform failures a test cannot cause on the real platform: a rollback that does not converge, a rollback response that is lost, a version reported as `stopping` at the moment of promotion. About 55 more cases use it without that reason and are not converted to live tests yet.

### Alternatives considered

- **Stop deleting inside the old `Prisma.Compute`.** It would leave two copies of the deploy code, one in `Prisma.Compute` and one in `Prisma.Deployment`, and the next fix would again reach only one.
- **A flag on the version, such as `active: true`.** Two versions of one service could both set it.
- **A separate promotion resource.** The platform has no such object; the active version is a field of the service.

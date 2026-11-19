# Manual QA: Prisma Compute composition (Alchemy, branch feat/prisma-compute-composition, head c36563220)

All twelve scenarios ran against the real platform in us-east-1 on 2026-11-18. Everything created was deleted afterwards.

## Summary

| # | Scenario | Result | One line |
| --- | --- | --- | --- |
| 1 | First deploy with `Prisma.Compute` | Pass | Served at once with the variable; the plan shows two undocumented internal rows and a count that does not match the rows. |
| 2 | Unchanged redeploy | Pass, with a defect | No new version, but the plan always says "4 to update" and the deploy makes API calls for 8 to 11 seconds. |
| 3 | New source, platform rollback, redeploy | Pass | New version served, old one kept; rollback served v1 within a second; the next deploy promoted v2 again, as documented, though the plan gave no sign of it. |
| 4 | Change and remove a variable | Fail | A changed value ships correctly; a removed variable is still served by the new version and stays visible to the app until some other change ships. |
| 5 | Broken health check, then fix | Partial | The old version kept serving and the fix recovered with no manual steps, but the error headline was a cleanup failure, the failed version was not deleted, and it later blocked `destroy`. |
| 6 | Low-level resources and two active versions | Pass, with a docs gap | Works with a correctly built archive; the docs never say an archive needs `compute.manifest.json`. The two-active-versions error is clear. |
| 7 | Own and each other's URLs | Pass | Both apps report both URLs; the unchanged redeploy creates no versions. |
| 8 | Class form with a binding and Config | Pass, with a docs defect | Serves and sees the binding and Config values once the Layer is the module's default export, which the JSDoc example omits. Removal-policy placement matches the docs. |
| 9 | `alchemy dev` | Pass | Local process served with the env, nothing created on the platform, clean stop in 8 seconds, no credentials needed. |
| 10 | `alchemy destroy` | Partial | Six stacks destroyed in 4 to 12 seconds; one failed twice after 1 min 23 s on the version stuck since scenario 5; `retain()` with `destroyOldDeployment` deleted the active version of a kept service. |
| 11 | Upgrade from `Prisma.App` / `Prisma.Deployment` | Pass | Nothing recreated; the `ComputeServiceIdUnavailable` instructions work, though a plain retry works too. |
| 12 | Upgrade from the earlier `Prisma.Compute` | Pass, with rough edges | Plan, deploy and destroy stop safely with clear instructions; move and destroy paths work as written; a contradictory "re-run with --adopt" line follows the error, and destroy removes the old service through the project, unlike what the docs say. |

## Defects, most serious first

1. **A removed environment variable keeps reaching the app.** The user deletes `GREETING` from `env` and deploys. The deploy creates a new version and then deletes the variable, but that new version still has it: the app returned `"greeting":"hello-2"`, and kept doing so after a further unchanged deploy. It disappeared only when an unrelated source change shipped a version (`"greeting":null`). The user expects the app to stop seeing the variable after the deploy that removed it. No user doc mentions this; only the pull request description says the new version still has the key. (Scenario 4.)

2. **`RemovalPolicy.retain()` plus `destroyOldDeployment: true` deletes the active version on `alchemy destroy`.** With retain piped where the docs say (`Api.pipe(Effect.provide(ApiLive), RemovalPolicy.retain())`), destroy printed `[api/Version] delete … deleted (3.9s)` and orphaned everything else. The kept service then answered 404 on its stable URL. The user asked to keep everything on the platform; they should get a service that still serves. The docs say the version keeps its own policy, but not that this makes a retained stack unusable. (Scenarios 8 and 10.)

3. **A failed health check leaves a version the provider can neither delete nor get past at destroy time.** After the preview check got HTTP 500 for the full wait, the deploy ended with `PrismaCleanupFailed: Failed to clean up Prisma deployment 'cpv_nf2s…' after reconcile failed. The resource may be orphaned. Manual cleanup: DELETE /v1/deployments/cpv_nf2s…`. The version stayed in status `stopping` for over 20 minutes. The next deploy forgot it ("Replaced resource retained.") instead of deleting it, contrary to "A new version that fails its check is deleted". Later, `alchemy destroy` failed twice with `Conflict: The deployment did not reach a delete-safe state after stop (1m 23s)`, after it had already deleted the active version, so the stable URL went to 404. `deleteProject` through the API removed it all at once. The user should see the version deleted, or at least tracked and retried, and a destroy that completes. (Scenarios 5 and 10.)

4. **The health-check failure is reported as a cleanup failure.** The headline of that failed deploy is `PrismaCleanupFailed`, printed three times, followed by a 17-line stack trace. The actual reason, `ComputeUrlTimeout: … '/health' to become reachable. Last response: HTTP 500.`, is the last line, under `[cause]`. The wording "to become reachable" is also wrong for a URL that answered. Why the cleanup failed is never shown, and the manual step names a raw HTTP route with no tool. The user should see, first, "the health check on /health returned 500". (Scenario 5.)

5. **The plan never reports "no changes".** An unchanged program plans `4 to update` (`9 to update` for two Computes, `12 to update` with a database binding), with "no declared property changes" on most rows, every time, and the deploy then spends 8 to 11 seconds on API calls. A user cannot use `plan` to confirm the deployed stack matches the program. The same output also hides a real difference: after a platform rollback the plan is identical, with the active-version row `noop`, even though the deploy will undo the rollback. (Scenarios 2, 3, 7, 8.)

6. **The class-form example in the `Prisma.Compute` JSDoc does not deploy.** Copying it (`const ApiLive = Api.make({ project, main: import.meta.filename }, …)`) fails the bundle: `[MISSING_EXPORT] "default" is not exported by "src/Api.ts"`, in about 40 lines of colour codes that print the path one character at a time. The Layer has to be the module's default export (`export default ApiLive`), as other Alchemy pages show. (Scenario 8.)

7. **The docs never say what a prebuilt archive must contain.** Following "Serve a version" with `tar czf dist/app.tar.gz server.js` waits 73 seconds and fails with `ComputeUrlTimeout: … No HTTP response was received.` The archive needs `compute.manifest.json` with `manifestVersion` and `entrypoint`, which no user page or JSDoc mentions, and the error does not point at the archive. (Scenario 6.)

## Rough edges

- The plan lists internal rows the docs never mention: `api/Prisma.Compute.Composition` and `api/Service/Prisma.ComputeService.ActiveVersion(Version)`. Its count ("6 to create, 2 binding changes") does not match the eight rows, and rows show no resource type. With two Computes, two rows read `…ActiveVersion(Version)`, which does not say which version.
- Completion lines appear late and out of order: `[api/Env/GREETING] created (10.7s)` prints after the version was created.
- The platform service is named after the child, `QaBasic-Service-live-will-…`, not after the Compute, `api`.
- The deploy prints nothing for minutes while it waits on a health check: 3 minutes 7 seconds in scenario 5, although the documented wait is 60 seconds.
- Errors are printed once per affected row (two to four times) and then again as a summary.
- `ComputeServiceTooManyActiveVersions` names versions by internal binding IDs (`Prisma.ComputeService.ActiveVersion(web-version)`), not as `web-version`.
- `ComputeServiceIdUnavailable` says to remove `activateVersion`, deploy, and add it back, but a plain second `alchemy deploy` also works, because the failed run already rewrote the service row; its summary nevertheless says "0 succeeded". Its explanation ("makes the service and its version read each other") is internal. The plan does not predict it.
- After `ComputeCannotUpgradeInPlace`, a second error line says `OwnedBySomeoneElse … Re-run with --adopt`, contradicting the instructions just printed. It probably appears only because the simulated old service had a logical ID.
- In the move path, skipping `--adopt` creates a new empty service and then fails on the variable, with the error printed four times; the plan does not warn.
- The class-form bundle pulls in `@vercel/nft` and prints two long `[EVAL] Use of direct eval` warnings on every deploy, and four on every `plan`. Plan takes about 5 seconds because it bundles.
- The plan word "orphaned" ("1 to orphaned") is ungrammatical and not the word the docs use ("kept", "retained").
- Each app in a project sees every other Compute's variables. This is documented, but surprising when `env` is written on one Compute.
- `alchemy dev` prints `[web] ready at http://localhost:5173` before the dev process's own ready line.
- A new active version briefly showed status `stopping` on the platform while it was serving; that looks like a platform quirk.

## Places where the docs and the behaviour disagree

- `deployments.mdx`: "A new version that fails its check is deleted." In scenario 5 it was not; the cleanup failed and the next deploy forgot it.
- `deployments.mdx`, upgrade section: a destroy "leaves the old service as it is", and the error says to "delete the old service in the Prisma Console" after `state delete` and `alchemy destroy`. When the stack also declares the project, destroying the project deletes the old service, so that last step is impossible.
- `apps.mdx`, "Removal policies": a decoration "reaches every resource it declares". The version is an exception (it keeps `retain`, or `destroy` with `destroyOldDeployment`); that is stated only in `deployments.mdx` and the JSDoc. A user reading `apps.mdx` alone expects `RemovalPolicy.destroy()` to delete replaced versions; it does not.
- The `Prisma.Compute` JSDoc class-form example does not deploy as written (defect 6).
- The user docs do not describe what removing a key from `env` does (defect 1).
- `ComputeServiceIdUnavailable` and `deployments.mdx` both say to deploy once without `activateVersion`; a plain retry is enough.

## Setup

- Checkout: `wip/alchemy-compute`, head c36563220. Region us-east-1. Credentials from `~/.config/prisma-compose/deploy.env` with `CI=true`.
- Each scenario is a scratch project under `examples/qa-<scenario>` with `alchemy.run.ts`, a tiny `node:http` server, and state in `Alchemy.localState()` (the form `setup.mdx` shows).
- Scratch projects are not in the pnpm lockfile, so instead of running `pnpm install` (which would rewrite the tracked lockfile) each one symlinks `node_modules` to `examples/prisma-compute-effect/node_modules`, which already links `alchemy`, `@alchemy.run/prisma` and `effect`. The first run used `pnpm exec alchemy plan`; pnpm then ran a workspace-wide install with prepare scripts (about 5 seconds of unrelated output) because the new directory is not in the lockfile. Every later command calls `./node_modules/.bin/alchemy` directly, which is the same binary the package scripts run.
- Platform facts come from a small Effect script over `@distilled.cloud/prisma/management` (`getProjects`, `getServices`, `getServiceDeployments`, `getDeployment`, `createServiceRollback`, `deleteProject`). The Prisma CLI was not used.

## Scenario records

### 1. First deploy with `Prisma.Compute`

Program: `Prisma.Project("project", { name: "qa-compute-composition-basic", createDatabase: false, region: "us-east-1" })` and `Prisma.Compute("api", { project, path: "./app", entrypoint: "server.js", port: 3000, env: { GREETING: "hello-1" } })`, the "Deploy a directory with an entrypoint" example from the `Prisma.Compute` JSDoc plus one variable.

Commands: `alchemy plan`, `alchemy deploy` (refused without a terminal: "Cannot prompt for approval in a non-interactive terminal. Nothing was changed — re-run with --yes to deploy."), `alchemy deploy --yes`.

Plan:

```
Plan: 6 to create, 2 binding changes
[api] create
[api/Prisma.Compute.Composition] create
[api/Artifact] create
[api/Env/GREETING] create
[project] create
[api/Service] create
[api/Service/Prisma.ComputeService.ActiveVersion(Version)] create
[api/Version] create
```

Result: deploy succeeded in 16.4 seconds (18 seconds wall clock). The stable URL answered at once with `{"version":"v1","greeting":"hello-1"}` (HTTP 200). The platform shows one service with logical ID `api` and one running version, active, whose variables include `GREETING`.

Observations:

- The plan shows that one Compute is several resources, and the child names (`api/Service`, `api/Env/GREETING`, `api/Artifact`, `api/Version`) match the table in `apps.mdx`. But it also shows two rows the docs never mention: `api/Prisma.Compute.Composition` and `api/Service/Prisma.ComputeService.ActiveVersion(Version)`. These look like internal machinery. The summary says "6 to create, 2 binding changes" while eight rows are listed, so a user cannot match the count to the rows.
- The plan rows show no resource types, unlike the example in the pull request description (`+ api/Service  Prisma.ComputeService`).
- Completion lines are printed late and out of order: `[api/Env/GREETING] created (10.7s)` appears after `[api/Version] creating` and at the same instant as `[api/Version] created`, although the variable must have been written before the version.
- The platform service is named `QaBasic-Service-live-will-zchd6jgdztolyk3f`: it takes the child's name `Service`, not the Compute's name `api`. Its logical ID is `api`, as documented.

### 2. Redeploy with nothing changed

Commands: `alchemy plan`, `alchemy deploy --yes`, `alchemy plan` again, `alchemy plan --detailed`.

Plan, every time, including after the redeploy:

```
Plan: 4 to update, 1 binding changes
[api] update
[api/Prisma.Compute.Composition] update
[api/Artifact] noop
[api/Env/GREETING] update
[project] noop
[api/Service] update
[api/Service/Prisma.ComputeService.ActiveVersion(Version)] noop
[api/Version] update
```

`--detailed` explains it only for the version: `- service: cps_z5lz… / + service: (known after apply)`. The other updated rows say "no declared property changes".

Result: the deploy ran updates on the variable (1.2 s), the service (5.0 s) and the version (3.4 s): 8.4 seconds, 11 seconds wall clock. No new version was created (the platform still lists one version, the same ID), and the URL still serves v1. So the docs' promise "An unchanged deploy creates no new version" holds, but the plan never settles on "no changes": a user who runs `plan` to check that their program matches what is deployed is told four resources will change, every time.

### 3. Change the source, roll back on the platform, redeploy

Commands: change `VERSION` in `app/server.js` from v1 to v2; `alchemy plan`; `alchemy deploy --yes`; roll back with `createServiceRollback({ serviceId, deploymentId: <first version> })` through the SDK, as `deployments.mdx` describes; curl; `alchemy plan --detailed`; `alchemy deploy --yes`.

Plan for the source change: `Plan: 4 to update, 1 to replace, 2 binding changes`, with `[api/Version] replace` and `[api/Artifact] update`. Deploy: 11.7 seconds. The log says `[api/Version] Retaining replaced resource (removal policy: retain)... Replaced resource retained.` The stable URL served `{"version":"v2",...}` right after. The platform lists two versions, both with status `running`, the new one active.

Rollback: the API answered `{"appEndpointDomain":"https://z5lz….ewr.prisma.build","reassignedDomains":0}`, and the stable URL served v1 on the first request, one second later. The platform shows the first version active. This matches "The stable URL serves the kept version within seconds."

Unchanged deploy after the rollback: the plan is identical to the plan of an unchanged deploy with no rollback (`4 to update`, and `[api/Service/Prisma.ComputeService.ActiveVersion(Version)] noop`). The deploy (6.8 seconds) then made v2 active again, and the stable URL served v2. This matches the docs ("The next deploy promotes the declared version again"), but the plan gives no sign that the deploy will undo a rollback: the active-version row says `noop`. A user who rolled back during an incident and runs `plan` to check is not warned.

### 4. Change a variable's value, then remove it

Value change (`GREETING: "hello-2"`): plan `3 to update, 1 to replace`, with `[api/Version] replace`. Deploy 10.6 seconds. The app returned `"greeting":"hello-2"`. A third version was created. Matches "A changed value ships a new version." The older version's preview URL still returned `hello-1`, as expected for a kept version.

Removal (delete the `env` line from the program): plan `2 to update, 1 to replace, 1 to delete`, with `[api/Env/GREETING] delete` and `[api/Version] replace`. The deploy created a fourth version first, then deleted the variable. The app, served by that new version, still returned `"greeting":"hello-2"`, and the platform lists `GREETING` among the new version's variables. A further unchanged deploy creates no version, so the app keeps seeing the removed variable until some later change ships a version.

The user docs (`apps.mdx`, `deployments.mdx`, the `Prisma.Compute` JSDoc) say nothing about removing a key; they cover only `null` and `undefined` values. Only the pull request description says it ("A key removed from `env` is deleted after the new version is created, so that version still has it"). A user who removes a variable expects the app to stop seeing it; here the deploy creates a version whose only purpose seems to be the removal, and that version still carries the variable.

### 5. A broken deploy, then recovery

Steps: added `healthCheck: { path: "/health" }` to the Compute and deployed a healthy v3 (9.0 seconds, served v3; it also served `"greeting":null`, so the variable removed in scenario 4 disappeared only now, with an unrelated change). Then made `/health` answer HTTP 500 (v4-broken) and ran `alchemy deploy --yes`.

What the user saw: after `[api/Version] creating replacement` the terminal printed nothing for 3 minutes 7 seconds, then:

```
ERROR: [api] fail — PrismaCleanupFailed: Failed to clean up Prisma deployment 'cpv_nf2stcfyd7oa66vnpt4ev1n1' after reconcile failed. The resource may be orphaned. Manual cleanup: DELETE /v1/deployments/cpv_nf2stcfyd7oa66vnpt4ev1n1.
ERROR: [api/Service] fail — PrismaCleanupFailed: (same text)
ERROR: [api/Version] fail — PrismaCleanupFailed: (same text) (3m 7s)
Failed: 1 succeeded, 3 failed (3m 7s)
ERROR (#1): PrismaCleanupFailed: … (a 17-line stack trace through Effect internals) …
  [cause]: ComputeUrlTimeout: Timed out waiting for Prisma Compute URL 'https://cv-fe3f613b171f.ewr.prisma.build/health' to become reachable. Last response: HTTP 500.
```

- The service kept serving v3 throughout: correct, and the most important part.
- The real reason, "the health path answered HTTP 500", is the last line, under a stack trace, labelled `[cause]`. The headline is a cleanup failure. The wording "to become reachable" is wrong for a URL that answered 500; it was reachable and unhealthy.
- The reason the cleanup failed is never printed. On the platform the failed version sat in status `stopping` for at least five minutes; the delete evidently waited and gave up.
- "Manual cleanup: DELETE /v1/deployments/…" points the user at a raw HTTP route with no host, no auth and no tool. Nothing in the docs explains how to call it.
- The same error is printed three times, once per row, so it looks like three failures.
- The documented default wait for the preview URL is 60 seconds (`urlReadinessTimeoutSeconds`); the deploy took 3 minutes 7 seconds with no progress line. A user cannot tell a hung deploy from a waiting one.
- The docs say "A new version that fails its check is deleted". It was not deleted.

Recovery: fixed `/health` (v5-fixed) and ran `alchemy deploy --yes` with no manual steps. It succeeded in 9.3 seconds and served v5-fixed. The log printed `[api/Version] Retaining replaced resource (removal policy: retain)... Replaced resource retained.` twice: the failed version was forgotten from state, not deleted. It remains on the platform in status `stopping`, now tracked by nothing; only the service's deletion will remove it. Right after the deploy the new active version also showed status `stopping` for a few seconds while serving traffic, then `running`; that looks like a platform status quirk.

### 6. The low-level resources: `ComputeService`, `ComputeVersion` with a prebuilt archive, `activateVersion`

Program: the "Serve a version" example from `deployments.mdx` exactly (`Prisma.ComputeService("web", { project })`, `Prisma.ComputeVersion("web-version", { service: service.serviceId, artifactPath: "./dist/app.tar.gz", artifactContentType: "application/gzip" })`, `Prisma.activateVersion(service, version)`), with a project named `qa-compute-composition-lowlevel`.

Plan: `3 to create, 1 binding changes`: `[project]`, `[web]`, `[web/Prisma.ComputeService.ActiveVersion(web-version)]`, `[web-version]`.

First attempt, an archive built the way a user would from the docs (`tar czf dist/app.tar.gz server.js`): the deploy waited 1 minute 13 seconds and failed with `ComputeUrlTimeout: Timed out waiting for Prisma Compute URL 'https://cv-a733….ewr.prisma.build' to become reachable. No HTTP response was received.` The failed version was deleted (the service had no versions afterwards), as documented. But nothing in the docs says what a "prebuilt archive" must contain. By unpacking the archive `Prisma.Compute` builds, I found it needs a `compute.manifest.json` at the root (`{"manifestVersion": "1", "entrypoint": "…"}`). No user page or JSDoc mentions the manifest. The error gives no hint that the archive is the problem.

Second attempt, with the manifest: deploy succeeded in 8.3 seconds. Stable URL and `version.url` (the preview URL) both served `low-v1`; the app saw `PORT=8080`, the documented default. Plan said `[web-version] replace` and the log said "Retaining replaced resource", about the version that had already been deleted; harmless but confusing.

Replace the archive (low-v2, same path): plan `1 to update, 1 to replace`; deploy 10.2 seconds; stable URL served `low-v2`; the platform kept the low-v1 version, as documented.

Two active versions (a second `ComputeVersion` "web-version-2" and a second `activateVersion` call): planning failed in 213 milliseconds, before any change, with:

```
ComputeServiceTooManyActiveVersions: Prisma.ComputeService 'web' has 2 versions attached as its active version (Prisma.ComputeService.ActiveVersion(web-version), Prisma.ComputeService.ActiveVersion(web-version-2)). A service serves exactly one version; attach only one with Prisma.activateVersion.
```

The error is clear and matches the docs. Two small faults: it is printed three times, and it names the versions by internal binding IDs (`Prisma.ComputeService.ActiveVersion(web-version)`) instead of the user's names `web-version` and `web-version-2`.

### 7. Services that know their own and each other's URLs

Program: the "A service's own URL" example from `apps.mdx` (two `ComputeService`s, two `Compute`s with `service` passed in; web gets `PUBLIC_URL` and `API_URL`, api gets `WEB_URL`), plus `entrypoint` and `port`.

Plan: `12 to create, 4 binding changes`. Deploy succeeded in 20.4 seconds. Both URLs served at once:

```
web: {"app":"web","PUBLIC_URL":"https://dqp3….ewr.prisma.build","API_URL":"https://jdcg….ewr.prisma.build","WEB_URL":"https://dqp3….ewr.prisma.build"}
api: {"app":"api","PUBLIC_URL":"https://dqp3….ewr.prisma.build","API_URL":"https://jdcg….ewr.prisma.build","WEB_URL":"https://dqp3….ewr.prisma.build"}
```

Each app sees its own URL and the other's. Each also sees the other's variables, because variables belong to the project's Branch, not to a service; the docs say so ("A variable belongs to the project and the service's Branch, not to one service"), so this is expected, but a user who wrote `env` on one Compute may still be surprised that the other app gets it.

Unchanged redeploy: plan `9 to update`, deploy 9.0 seconds, no new versions (still one per service). Same "updates that change nothing" noise as scenario 2. The plan rows `[api-service/Prisma.ComputeService.ActiveVersion(Version)]` and `[web-service/Prisma.ComputeService.ActiveVersion(Version)]` both say `Version`, so they do not tell the user which Compute's version each service serves.

### 8. The class form, with a binding and a Config value

Program (`examples/qa-class`): `class Api extends Prisma.Compute<Api>()("api") {}` and `ApiLive = Api.make(propsEffect, initEffect)`, following the "Decorate a class-form Compute" example in the `Prisma.Compute` JSDoc. The props effect reads `Config.String("QA_GREETING")` into `env`; the init calls `Prisma.Connect(Connection)` with `Prisma.ConnectBinding`, over a `Prisma.Postgres` and `Prisma.Connection` laid out as in `examples/prisma-compute-effect`. The stack yields `Api.pipe(Effect.provide(ApiLive))`. Run with `QA_GREETING=from-config`.

First deploy failed after 14 seconds:

```
ERROR (#1): BundleError: Build failed with 1 error:
[MISSING_EXPORT] "default" is not exported by "src/Api.ts".
```

followed by about 40 lines of colour-coded rolldown output in which the file path is printed one character per escape sequence. The JSDoc example never exports the Layer, and its `main: import.meta.filename` sits in a snippet that reads like the stack file. The other docs (`infrastructure-as-effects/runtime.mdx`) use `export default Api.make(...)`. Adding `export default ApiLive;` fixed it. The failed deploy had already created the project, database, connection and nine variables; the next deploy carried on from there, as the pull request says it should.

Second deploy: `Plan: 3 to create, 9 to update, 1 to replace`, 11.5 seconds. The URL served `{"version":"class-v1","greeting":"from-config","databaseUrlSet":true}`. The binding produced eight `api/Env/PRISMA_CONNECTION_*` rows and the Config value one `api/Env/QA_GREETING` row, all present on the version. Bundling printed two long `[EVAL] Use of direct eval` warnings from `@vercel/nft` (a build tool, apparently pulled into the app bundle), and the same warnings, four times, on every `plan`. Plan takes about 5 seconds here because it bundles.

Unchanged plan: `12 to update`, `[api/Artifact] noop`, no replace. The bundle comparison works; the "update" noise from scenario 2 is larger here because every binding variable is listed.

`RemovalPolicy.destroy()` where the docs say it goes for this form, `Api.pipe(Effect.provide(ApiLive), RemovalPolicy.destroy())`, then a new version (class-v2): deploy 14.1 seconds, log "Retaining replaced resource (removal policy: retain)". The old version is still on the platform. This is what the docs say ("The version keeps its own policy either way"; use `destroyOldDeployment`), so it is not a defect, but the scenario as briefed expected the old version to go; a user reading only the "Removal policies" section of `apps.mdx` would expect the same, because that section says the decoration "reaches every resource it declares" without saying the version is the exception. That sentence is only in the JSDoc and in `deployments.mdx`.

`destroyOldDeployment: true` in the props, then class-v3: log "Cleaning up replaced resource...", and the class-v2 version was deleted from the platform. Correct. (The class-v1 version, replaced before the flag was set, stays, as expected.)

Placement of a removal policy, tested with `retain()` because `destroy()` has no visible effect on versions: `examples/qa-class` was changed to the placement the docs say reaches nothing, `Api.pipe(RemovalPolicy.retain(), Effect.provide(ApiLive))`, and a copy, `examples/qa-classretain` (project `qa-compute-composition-classretain`), uses the documented placement `Api.pipe(Effect.provide(ApiLive), RemovalPolicy.retain())`. Both deployed. The result is checked under scenario 10.

### 9. `alchemy dev` with `dev.command`

Program (`examples/qa-dev`): `Prisma.Compute("web", { project, path: "./app", entrypoint: "server.js", port: 3000, dev: { command: "node server.js", port: 5173 }, env: { GREETING: "hello-dev" } })`. Run with `alchemy dev --no-input`, `CI=true`, and `PRISMA_SERVICE_TOKEN` deliberately unset, since `setup.mdx` says dev needs no Prisma credentials.

Plan: `3 to create`, all `(local)`: `[web/Dev]`, `[project]`, `[web]`. Ready in 121 milliseconds. `curl http://localhost:5173/` returned `{"version":"dev-local","greeting":"hello-dev","port":"5173"}`: the dev command ran in `path`, with `PORT` set and the `env` value present. The platform has no project named `qa-compute-composition-dev`. SIGINT stopped it in 8 seconds, printing "Exited."; no `node server.js` process remained and the port was closed. Matches the docs. One small fault: `[web] ready at http://localhost:5173` is printed before `[web/Dev] ready at http://localhost:5173`, that is, before the port was checked.

### 11. Upgrade from `Prisma.App` and `Prisma.Deployment`

Setup (`examples/qa-upgrade`, project `qa-compute-composition-upgrade`): deployed the scenario 6 program (`ComputeService("web")`, `ComputeVersion("web-version")`, `activateVersion`) with the new code. `alchemy state ls QaUpgrade/live_will` lists the rows (`web`, `web-version`, `project`, `output`); with `Alchemy.localState()` they live in `.alchemy/state/QaUpgrade/live_will/<id>.json`. `alchemy state` has no edit command, so I edited the two files with a small script (`to_legacy_app.py` in the scratchpad), after backing them up:

- `web.json`: `resourceType` `Prisma.ComputeService` → `Prisma.App`; attributes `serviceId` → `appId`, `activeVersionId` → `latestDeploymentId`, `serviceEndpointDomain` → `appEndpointDomain`; removed `branchRole` (new in this change); emptied `bindings` (the old resource had no active-version binding).
- `web-version.json`: `resourceType` `Prisma.ComputeVersion` → `Prisma.Deployment`; prop `service` → `app`, added prop `promote: true`; attributes `versionId` → `deploymentId`, `serviceId` → `appId`, added `appEndpointDomain`.

(a) Program without `activateVersion`: `plan --detailed` showed `2 to update`, with `- app: cps_… / - promote: true / + service: (known after apply)` on the version and no replace. `deploy --yes` succeeded in 4.3 seconds. Same service ID, same single version, stable URL kept serving low-v2. Both rows were rewritten under the new type names and attribute names. Then adding `activateVersion` back and deploying succeeded (4.6 seconds) and created no version. Pass; matches the docs.

(b) Redid the state edit, and deployed a program that already calls `activateVersion`. `plan` showed nothing unusual (`2 to update, 1 binding changes`); `deploy` failed in 2 seconds:

```
ERROR: [web-version] fail — ComputeServiceIdUnavailable: This resource received no Compute service ID. The service's saved state was written before Prisma.App was renamed Prisma.ComputeService, and Prisma.activateVersion makes the service and its version read each other before that state is rewritten. Deploy once with the renamed resources and without Prisma.activateVersion, so the service's state is rewritten, then add Prisma.activateVersion and deploy again.
Failed: 0 succeeded, 1 failed (2.0s)
```

The service kept serving throughout. Following the instructions exactly (comment out `activateVersion`, deploy: 2.3 seconds, plan showed `[web/Prisma.ComputeService.ActiveVersion(web-version)] unbind`; restore it, deploy: 4.4 seconds) worked: one version, same service, URL serving.

Judged as a newcomer: the message says what happened and what to do, which is good. But "makes the service and its version read each other" is internal reasoning a user cannot act on, and the instruction is heavier than needed. The failed deploy had already rewritten the service row (state showed `web` as `Prisma.ComputeService`, status `updated`, while the summary said "0 succeeded"). I redid the state edit a third time and simply ran `alchemy deploy --yes` twice with `activateVersion` in place: the first failed with the same error, the second succeeded in 6.7 seconds. So a plain retry recovers, and the message's claim that you must remove `activateVersion` is not true. The plan also does not predict this failure.

### 12. A stack deployed with the earlier single-resource `Prisma.Compute`

Setup: two copies, `examples/qa-legacya` and `examples/qa-legacyb` (projects `qa-compute-composition-legacya` and `-legacyb`), each a `Prisma.Compute("api", { project, path, entrypoint, port, env: { GREETING } })`, deployed with the new code. Then a script (`to_legacy_compute.py` in the scratchpad) rewrote `.alchemy/state/QaLegacy/live_will/api.json` to the old attribute set: `appId`, `appName`, `projectId`, `regionId`, `appEndpointDomain`, `deploymentId`, `latestDeploymentId`, `deploymentEndpointDomain`, `deploymentUrl`, `url`, `environmentKeys`, `local`, and the removed `promoted`, `previousDeploymentId`, `previousDeploymentAction`, `readinessStatus`, `pendingDeploymentCleanup`, `environmentVariableIds`, `environmentClass`, `environmentBranchId`, `artifactHash`; no `composed`; no bindings. It deleted the four child rows (`api__Service`, `api__Env__GREETING`, `api__Artifact`, `api__Version`).

One honest difference from a real old stack: the service the new code created carries logical ID `api`, while the old release's `Prisma.Compute` created its service with no logical ID (checked in the merge base's `Compute.ts`: `createService({ projectId, displayName, branchId, regionId })`). For the move path on copy b I cleared it with `updateService({ logicalId: null })`, after `state delete`, so the old service looks like a real one. Copy a kept `api`; the effect of that is noted below.

`alchemy plan` and `alchemy deploy --yes` (copy a): both stopped while planning, in about 2 seconds, and changed nothing:

```
ComputeCannotUpgradeInPlace: Prisma.Compute 'api' was deployed with an earlier release of @alchemy.run/prisma, from before Prisma.Compute declared its service, environment variables and version as separate resources. This release cannot take over that service in place.
The deploy stopped while planning, so nothing was changed.

To keep deploying or destroy this stack as it is, use that earlier release: the last release before this change, listed in the changelog.

To move to this release, which serves from a new service with a new URL:
1. Run `alchemy state delete QaLegacy/live_will/api`. …
2. If the Compute sets serviceName, change it …
3. Deploy with `--adopt`, so the new environment variables take over the old service's variables of the same key, or delete those variables in the Prisma Console first.
4. Move custom domains to the new service, and update anything that uses the old URL.
5. Delete the old service in the Prisma Console once nothing uses it.

To destroy the stack on this release instead: run `alchemy state delete QaLegacy/live_will/api`, then `alchemy destroy`, and delete the old service in the Prisma Console.
OwnedBySomeoneElse: Cannot adopt resource 'api/Service' (Prisma.ComputeService): it exists in the cloud but is not owned by this stack/stage/logical-id. Re-run with `--adopt` (or wrap the effect in `adopt(true)`) to take it over.
```

The main message is clear, complete and matches the docs. The trailing `OwnedBySomeoneElse … Re-run with --adopt` line contradicts it: it tells the user to do the one thing the main message says to do only after `state delete`. `deploy --yes --adopt` before `state delete` still stopped with `ComputeCannotUpgradeInPlace` and changed nothing, so the contradiction is not dangerous, only confusing. (The extra line comes from the simulated service having logical ID `api`; a real old service has none, so a real user would probably not see it.)

`alchemy destroy --yes` (copy a): failed with `DestroyError`, repeating the same instructions with "The old service, its versions and its environment variables were neither changed nor deleted. Other changes in this run were applied." The project was skipped ("blocked by failed delete of api"). The service kept running. Correct and clear.

Destroy instructions (copy a): `alchemy state delete QaLegacy/live_will/api` ("✓ Deleted state at QaLegacy/live_will/api"), then `alchemy destroy --yes`: deleted the project in 4.0 seconds, and the project's deletion took the old service with it; the platform then had no project of that name. The final step of the instructions, "delete the old service in the Prisma Console", was impossible, because it was already gone. When the stack declares the project too, `alchemy destroy` deletes the old service; the message should say so, because the "Upgrade" section of `deployments.mdx` says a destroy "leaves the old service as it is". Here the user asked to destroy, so deleting it is not wrong, but the instructions describe a different outcome.

Move instructions (copy b, old service logical ID cleared): `alchemy state delete QaLegacy/live_will/api`, then `alchemy plan` showed `5 to create` (a new service, variable, artifact, version). I first ran `deploy --yes` without `--adopt` to see what a user who skips step 3 gets: it created a new, empty service and then failed with `OwnedBySomeoneElse: Cannot adopt resource 'api/Env/GREETING' (Prisma.EnvironmentVariable) … Re-run with --adopt`, printed four times. The plan had not predicted that. Then `deploy --yes --adopt` as step 3 says: succeeded in 13.0 seconds; it reused the empty service from the failed run, took over the `GREETING` variable, and the new URL served `{"version":"legacy-v1","greeting":"hello-legacy"}`. The old service kept running on its own URL with its version. The steps work as written.

Is a service ever deleted or duplicated without the user asking? Not in the deploy paths: the old service was never touched until the user ran `state delete` and then `destroy`. The move creates a second service, as the instructions say it will. The destroy path deletes the old service through the project, which the instructions do not mention. On copy b, before I cleared the old service's logical ID `api`, `plan --adopt` after `state delete` would have adopted the old service (`[api/Service] adopted`) instead of creating a new one; that does not apply to a real old stack, whose service has no logical ID, but it would apply to anyone whose old service shares the logical ID.

Not tested: removing the Compute from the program on a legacy stack (only `destroy` was tested), and the "keep" option, which needs the previous release.

### 10. `alchemy destroy` for each stack

All seven deployed stacks were destroyed with `alchemy destroy --yes`, in parallel. (`qa-legacya` was destroyed in scenario 12; `qa-dev` created nothing.)

| Stack | Plan | Result | Time |
| --- | --- | --- | --- |
| qa-lowlevel | 2 to delete, 1 to orphaned | done | 4.6 s |
| qa-pair | 10 to delete, 2 to orphaned | done | 5.5 s |
| qa-class (retain piped onto the class alone) | 16 to delete | done, everything deleted | 12.4 s |
| qa-classretain (retain piped around `Effect.provide`) | 1 to delete, 15 to orphaned | done | 4.0 s |
| qa-upgrade | 2 to delete, 1 to orphaned | done | 4.1 s |
| qa-legacyb | 5 to delete, 1 to orphaned | done; the project's deletion also removed the old service | 7.4 s |
| qa-basic | 4 to delete, 1 to orphaned | failed | 1 min 23 s, twice |

qa-basic failed both times with `ERROR: [api/Service] fail — Conflict: The deployment did not reach a delete-safe state after stop (1m 23s)`, and the project was skipped. The cause is the version left in status `stopping` by the failed health check in scenario 5; it never left that state (over 20 minutes). Before failing, the service delete had already deleted the active version, so the stable URL answered 404 and the service had no active version while six kept versions remained. The message names neither the version nor what to do. Deleting the project through the Management API (`deleteProject`) succeeded at once, so the platform can remove it; only the provider's service delete gets stuck.

Removal-policy placement for the class form (from scenario 8):

- Piped onto the class alone (`Api.pipe(RemovalPolicy.retain(), Effect.provide(ApiLive))`): it reached nothing, and destroy deleted all 16 resources. This matches the docs.
- Piped around `Effect.provide` (`Api.pipe(Effect.provide(ApiLive), RemovalPolicy.retain())`): 15 rows were orphaned (kept on the platform), but `[api/Version] delete` deleted the active version. That Compute also set `destroyOldDeployment: true`, and the docs say the version keeps its own policy; with that flag the policy is `destroy`. The result is a kept service with no version that answers 404 on its stable URL, a kept database and a kept project. A user who asked to "Keep everything on the platform when the stack is destroyed" (the JSDoc example's title) gets a service that no longer serves.

The plan wording "1 to orphaned" is ungrammatical, and "orphaned" is not explained; the docs call this "retained" or "kept".

No error appeared while the platform drained, other than the stuck version above. Plan for the other stacks never mentioned that the kept, replaced versions would be deleted with the service; they were, because the service's delete removes its versions, as the docs say.

## Cleanup

Deleted the two projects left over (`qa-compute-composition-basic` and `qa-compute-composition-classretain`) through `deleteProject`. A final `getProjects` listing shows no project named `qa-compute-composition-*` ("0 qa projects"). Deleted every `examples/qa-*` directory; `git status --short` in the checkout is empty and the head is still c36563220. No log or state file contained the service token.

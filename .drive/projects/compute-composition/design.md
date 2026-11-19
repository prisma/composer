# `Prisma.Compute` as a composition of the primitive resources

Status: design, reviewed and spiked. Nothing is implemented.
Dates: written 2026-11-11, revised 2026-11-13 after two reviews, a spike, and Will's corrections. Author: hodgkin-12, with Will.

Two repositories are involved:

- **Alchemy** (`alchemy-run/alchemy`), package `packages/prisma`, published as `@alchemy.run/prisma`. Most of the work is here. A clone is at `wip/alchemy` in this worktree, at commit `01792ec3`. Alchemy file references below are relative to that clone.
- **Composer** (this repository). It consumes `@alchemy.run/prisma` 2.0.0-beta.85.

Supporting material, all with file and line references:

- [`research/`](research/): inventories of `Prisma.Compute` and of the primitive resources, a study of how Alchemy's engine supports composition, a survey of the Prisma tests, docs and conventions, and [`research/spike-results.md`](research/spike-results.md), which records what was run and what it showed.
- `reviews/` (local, never committed): the architect's and the principal engineer's reviews. The principal engineer's review holds pseudo-code for the promote-and-check sequence, corrections to line references, and a commit-by-commit order.

## 1. The problem

`prisma deploy` deletes the previous version of a Compute service every time it ships a new one. Prisma Cloud's rollback needs the previous version to still exist, so rollback never works for a service deployed by Composer.

```
$ prisma deploy          # first deploy: creates version A, promotes it
$ prisma deploy          # code changed: creates version B, promotes it, DELETES A
# Prisma Cloud console → Rollback: there is nothing to roll back to
```

On Prisma Cloud a version is immutable. Which version is live is a separate fact: the service's endpoint points at one version, and each change to that is recorded as a promotion. Rollback is `POST /v1/services/{serviceId}/rollback`.

### Why it happens

Composer declares one `Prisma.Deployment` resource per service ([`compute.ts:415`](../../../packages/1-prisma-cloud/1-extensions/target/src/descriptors/compute.ts)). `Prisma.Deployment` plans a replacement whenever the artifact or its `triggers` change (`packages/prisma/src/Deployment.ts:495-561`). Alchemy replaces a resource by creating the new one and then calling the provider's `delete` on the old one. `Deployment.delete` stops and deletes the version (`Deployment.ts:746-765`).

Alchemy is doing what the graph says. The graph is wrong: its one node stands for both "a version" and "the version that is live", and nothing says an old version should be kept.

### The deeper problem upstream

`@alchemy.run/prisma` has two separate implementations of "ship a new version of a service", and they disagree.

| | `Prisma.Compute` | `Prisma.Deployment` |
| --- | --- | --- |
| What the engine sees | one resource, updated in place | one resource, replaced on every artifact change |
| Previous version | kept | deleted by the engine |
| Health check before promotion | yes | no |
| Check of the stable endpoint after promotion | yes | no |
| Recovery when the new version is unhealthy | restores the previous version | none |
| Who uses it | everyone following Alchemy's docs | Composer |

`Prisma.Compute` is not built from `Prisma.App`, `Prisma.EnvironmentVariable` and `Prisma.Deployment`. It is one 2,837-line resource whose `reconcile` calls the Management API directly for all three jobs (`Compute.ts:2269-2750`), with its own copies of much of the primitives' code.

Composer cannot declare `Prisma.Compute` today. Its decision record for adopting the upstream provider gives three reasons, and all three come from `Prisma.Compute` being a single resource:

1. A service's environment includes its own URL. One resource cannot take as an input a value it produces.
2. It owns its environment variables through a private record in its own state, and refuses any variable not in that record.
3. It contains the build and bundling code. Composer never builds the application's code.

## 2. Decisions

Made by Will, 2026-11-11 to 2026-11-13:

1. Composer should use `Prisma.Compute`. That it cannot today is a defect upstream.
2. `Prisma.Compute` is a composition of primitive resources, so the engine sees the service, its environment variables, and its version as separate graph nodes. Composer and other Alchemy users run the same code.
3. The resources use the platform's terms: `Prisma.ComputeService` and `Prisma.ComputeVersion`. There is no separate resource for promotion: the service has a pointer to its active version, and promoting means changing it. A flag on the version was rejected because the model could then hold two active versions. The platform team is consolidating its own fields and APIs on ComputeService and ComputeVersion in a separate effort that Will coordinates. That API stays backwards-compatible, and this project does not wait for it.
4. A resource named for a version is exactly one immutable version.
5. A superseded version is kept because `Prisma.ComputeVersion` declares Alchemy's default removal policy `retain`.
6. What happens to the previous version after a promotion is the platform's concern. Nothing in Alchemy stops it or deletes it.
7. A platform object is found by its `logicalId`, never by its name.
8. One `Prisma.EnvironmentVariable` per key. A version receives every variable in its Branch, and a service reads only the keys in the map it is given, so a variable that lingers in a version's copy is never read.
9. The work follows the Alchemy team's conventions (section 8).
10. One pull request to `alchemy-run/alchemy` for the whole project. Rollback for Composer users arrives when that pull request is merged and released, not earlier; Will accepted this.
11. Composer's decision record is not preserved for its own sake. Its section choosing the three low-level resources over `Prisma.Compute` is superseded.

## 3. The resources

| Today | After | Platform entity |
| --- | --- | --- |
| `Prisma.App` | `Prisma.ComputeService` | the service, including which version is active |
| `Prisma.Deployment` | `Prisma.ComputeVersion` | one immutable version |
| `Prisma.EnvironmentVariable` | unchanged | one variable in a project or Branch |
| none | `Prisma.ComputeArtifact` (new, name proposed) | no platform entity: the build output |
| `Prisma.Compute` | unchanged name; becomes the composite | |

### 3.1 The renames

- Alchemy resource types take `aliases`. A state row written under the old type moves to the new type on its next write (`packages/alchemy/src/Resource.ts:267-283`). `Prisma.ComputeService` lists `Prisma.App`, and `Prisma.ComputeVersion` lists `Prisma.Deployment`.
- Attribute and prop names follow: `appId` becomes `serviceId`, `deploymentId` becomes `versionId`, `app` becomes `service`, `appEndpointDomain` becomes `serviceEndpointDomain`. Each provider keeps reading the old attribute names from rows written before the rename, as `AWS.DynamoDB.Table` does for an older shape of its own (`packages/aws/src/DynamoDB/Table.ts:599-604`).
- `Prisma.Compute`'s own attributes take the new names too, with the same reading of old rows.
- Whether `App` and `Deployment` stay as deprecated exports for a release is for the Alchemy maintainers. Alchemy has no written rule on deprecation.
- The package once had root modules named `ComputeService` and `ComputeVersion`, and a test asserts they no longer resolve (`PublicSurface.test.ts:287-292`). The clone has no history, so the reason is unknown. Find out before reusing the file names.

### 3.2 `Prisma.ComputeVersion`

Today's `Prisma.Deployment`, with these changes:

1. **It no longer promotes.** The `promote` prop is removed. Which version is active is the service's (section 3.3).
2. **A superseded version is kept.** The resource declares the default removal policy `retain`, as `AWS.Lambda.Version` does (`packages/aws/src/Lambda/Version.ts:94-96`). When the engine replaces the resource, removes it from the program, or destroys the stack, it skips the provider's `delete` and forgets the row. The spike ran all three. The version stays on the service. It is removed when the service is deleted, because the platform's service delete removes its versions. A user who wants old versions deleted pipes `RemovalPolicy.destroy()` onto the resource.
3. **It checks its own URL.** After the version reports `running`, it waits until the version answers on its preview URL, and with `healthCheck`, until that path returns an accepted status. This is `Prisma.Compute`'s check before promotion (`Compute.ts:1325-1428`).
4. **It plans a replacement when its artifact is not yet known.** Today, when `artifactPath` is unresolved at plan time, `diff` makes no decision, and `reconcile` keeps the old version while recording the new artifact's hash, so the new code never ships (`Deployment.ts:519`, `614-633`). With the artifact built by another resource in the same deploy, that would happen every time.
5. **`skipCodeUpload` checks what its JSDoc already promises:** the service has a promoted version to copy from.

Unchanged: it is replaced when the artifact bytes, `artifactPath`, `artifactContentType`, `portMapping`, `skipCodeUpload` or `triggers` change, and when its recorded version has failed. `versionId` stays its stable property. `triggers` keeps its meaning: the platform copies the Branch's variables into a version when the version is created, so a changed variable needs a new version.

New props, each as on `Prisma.Compute` today: `healthCheck`, `verifyUrl`, `urlReadinessTimeoutSeconds`, `timeoutSeconds`, `pollIntervalMs`.

### 3.3 The service's active version

The pointer to the live version belongs to the service, as it does on the platform. `Prisma.ComputeService` has an **active version**. Promoting means changing it. Because the pointer is on the service, the model cannot hold two active versions.

The order at deploy time is the plain one: the service is created with no active version, the version is created under it, and the service is then pointed at the version.

Each resource is declared once and each needs the other's ID, which is a cycle. Alchemy supports a cycle when one resource in it can be created as a bare record first and completed afterwards (the provider's `precreate`), and when the back-reference is attached as a binding. The spike ran this with throwaway resources ([research/spike-results.md](research/spike-results.md), section A5):

```ts
const service = yield* ComputeService("Service", { … });
const version = yield* ComputeVersion("Version", { service: service.serviceId, … });
// attaches the version to the service as its active version
yield* service.bind("Active", { versionId: version.versionId });
```

The user-facing way to write the last line is a small helper on `Prisma.ComputeService`; its name is for the principal engineer. Inside `Prisma.Compute` it is internal. Both props as plain references, and the binding without `precreate`, fail at plan time.

What `Prisma.ComputeService` gains:

- **`precreate`** creates the service with no active version. On a first deploy, `reconcile` then finds the service `precreate` created.
- **Reconcile, when an active version is attached:** promote it with `promoteAppObserved` and wait until the service reports it as live. Check the stable endpoint. On failure, call the platform's rollback to the version that was active before (the service's own `activeVersionId` attribute from the previous deploy), wait, and fail the deploy. If the rollback does not converge, fail and change nothing else. It promotes on every deploy, as `Prisma.Deployment` does today, because promoting again repairs routing and custom-domain drift.
- **Exactly one active version.** The provider counts the versions attached to it. More than one fails the plan, in `diff` for an existing service and in `precreate` for a first deploy, before any version is created.
- **No active version attached** (a service declared alone, or `skipPromote`): the service is left serving whatever it serves. The platform has no "unpromote".
- **Attributes:** `activeVersionId`, and `url`. `diff` reports an update with `serviceId` and `url` stable whenever the attached version is unknown or changed, so a resource that reads `activeVersionId` sees the new value. The spike found that without this a reader keeps the old one.
- **Props for the stable-endpoint check:** `verifyUrl`, `healthCheck`, `urlReadinessTimeoutSeconds`, `timeoutSeconds`, `pollIntervalMs`.

The service never stops or deletes a version. The Management API operations this needs (`createServicePromote`, `createServiceRollback`, `getService`) are ones the package already calls, so no change to the generated SDK is expected.

One engine limit to respect: when the service and the version are both updated in place, the engine does not guarantee which is reconciled first. The order this model needs holds because a new version is always a replacement, never an in-place update.

### 3.4 How a deploy runs through the engine

The spike confirmed each order.

First deploy:

1. The service is created with no active version.
2. The environment variables are written.
3. The version is created, uploaded, started and checked on its own URL.
4. The service is pointed at the version and the stable endpoint is checked.

A new artifact:

1. A new version B is created and checked. Version A is still active.
2. The service is pointed at B. It knows A was active before from its own state.
3. The engine reaches the old row for A. Its removal policy is `retain`, so the engine forgets it without calling `delete`.

If step 2 fails, the service restores A and the deploy fails. State keeps both versions. The next deploy points the service at B without creating a third version.

### 3.5 What the platform does with the previous version

Recorded because the spike first misread it. Foundry is in `prisma/pdp-metal`, `apps/foundry` (clone at `wip/pdp-metal`).

- Promotion rewrites one row that maps the endpoint to a version (`src/services/endpoints.ts:60`). Neither Foundry nor the control plane stops the previous version.
- Foundry starts every version's VM with scale-to-zero: idle policy, five-second cooldown, stateful (`src/services/vm/unikraft.ts:797`). A version with no traffic goes to Unikraft's `standby` within seconds, and Foundry reports `standby` as `running` (`unikraft.ts:137`).
- The spike ran a rollback onto a kept version: the service reported it live in about three seconds and the stable URL served it in about six.

## 4. `Prisma.Compute` as a composition

### 4.1 The graph

For `Prisma.Compute("api", props)` the engine sees:

| Resource | Logical ID | Declared when |
| --- | --- | --- |
| `Prisma.ComputeService` | `api/Service` | always, unless the caller passes `service` |
| `Prisma.EnvironmentVariable` | `api/Env/<KEY>` | one per key of the final environment |
| `Prisma.ComputeArtifact` | `api/Artifact` | when Compute must build: `main`, `build`, or a `path` to archive. Not declared with `artifactPath` or `skipCodeUpload`. |
| `Prisma.ComputeVersion` | `api/Version` | always, in a deploy |
| `Prisma.Compute` | `api` | always: the host |

Children are declared under `Namespace.push(id)` and the host keeps the bare `id`, as every composite in the Alchemy repository does.

The order the monolith enforces inside one function becomes graph edges:

- Each `EnvironmentVariable` takes its scope from the service.
- The `ComputeVersion` takes the service, the artifact path and `triggers`. `triggers` holds a salted digest of each variable's value, so a changed value produces a new version. It must not hold the variable resources themselves: an unresolved value counts as changed (`Deployment.ts:443-451`) and a variable's attributes are unresolved on every deploy, so the version would be replaced every time. The ordering edge (variables written before the version is created) is carried on the `service` prop, as Composer's `appAfterEnvironment` does today.
- The `ComputeVersion` is attached to the service as its active version (section 3.3), unless `skipPromote`.
- The host takes the children's outputs.

The composite sets the `ComputeVersion` child's removal policy explicitly. Otherwise a stack-wide `RemovalPolicy.destroy()` would turn retention off, and `protect()` would make every artifact deploy fail.

### 4.2 Why the host is still a resource

`Prisma.Compute` is declared with Alchemy's `Platform`, which gives it the class form, the init Effect, bindings and dev mode. `Platform` always wraps exactly one resource with one provider (`packages/alchemy/src/Platform.ts:300-303`). So the host stays a `Prisma.Compute` resource whose live provider no longer calls the Management API. The precedent is the hosted platforms in `packages/effect-cluster`: the Platform resource keeps the runtime and collects the environment, its provider only writes state, and child resources do the cloud work.

### 4.3 When the children are declared

The spike ran both forms with a throwaway Platform.

- **Without an init Effect** (`yield* Prisma.Compute("api", { … })`, the form Composer and `Prisma.Website.*` use): the whole environment is in `props.env`, and the children are declared from the `onCreate` hook.
- **With an init Effect** (the class form): bindings add variables during the init by calling `set` on the runtime context. The service is declared from `onCreate`. The rest is declared after the init, from the runtime context's `exports` Effect, which always runs (`Platform.ts:636`). The `serve` hook cannot be used: `Platform` skips it when the init returns nothing (`Platform.ts:504-505`). At that point the keys set during the init are in the runtime context's own `env` map, not yet in the props, so the composite reads them there.
- `onCreate` runs in both forms and cannot tell them apart from its props, so the composite needs its own way to know which form it is in. The principal engineer's review discusses this.
- Both paths do nothing inside a deployed bundle (`globalThis.__ALCHEMY_RUNTIME__`).
- Declaring the Platform twice declares the children once.
- A decoration piped onto the plain form reaches every child. Piped onto `yield*` of a class it reaches nothing, not even the host. The docs must say where to put a decoration.

### 4.4 How the host gets its attributes

After declaring the children, the composite binds their outputs onto the host, and the host's provider copies the bound data into its attributes. The spike confirmed the host is reconciled after its children and that a downstream resource can read the host's attributes.

`serviceId`, `serviceEndpointDomain`, `projectId` and `regionId` come from the service; `activeVersionId` and `url` also from the service; `versionId` and the preview URL from the version. The monolith's bookkeeping attributes (owned variable IDs, artifact hash, pending cleanup, previous-version action) are removed. A marker attribute says the row was written by the composed provider; section 6 uses it.

`Prisma.CustomDomain` accepts a Compute and reads its service ID; `Website/FrameworkSite.ts` reads the endpoint domain and `url`. Both follow the rename.

### 4.5 Environment variables

- **Scope.** The class and Branch come from the role of the Branch the service is attached to; `envClass` is only a check (`Compute.ts:1921-1940`). `Prisma.ComputeService` gains a `branchRole` attribute, and the composite passes the class and Branch to each variable.
- **`null`** means no variable: no child is declared.
- **Values** must be `Redacted`; the composite wraps plain strings.
- **Precedence and encoding** stay as today: a value set by a binding overrides the same key in `env`, and binding values are JSON-encoded so the deployed bundle can decode them.
- **Plain text in state.** Alchemy writes a `Redacted` value to state as plain text inside a marker (`State/StateEncoding.ts:74-93`). That is true today for every `Prisma.EnvironmentVariable` value, Composer's included. This design neither fixes it nor makes it worse; `triggers` holds digests so it adds no new copy. Fixing it is a change to Alchemy's core, tracked separately.

### 4.6 `Prisma.ComputeArtifact`

Holds what `resolveArtifact` does today (`Compute.ts:1605-1776`): the bundle for an Effect-native `main`, the command, auto and static builds, and archiving a `path`. It makes no Management API calls.

- Attributes: `artifactPath`, `hash`, `defaultPort`.
- It writes the archive where it outlives the reconcile, as `Prisma.WebsiteArtifact` does.
- It skips its work when its inputs have not changed, as core's `Command.Build` does (`Build.ts:161-205`). Otherwise, with the version replaced whenever its artifact is unresolved, every deploy would ship a new version. `Prisma.WebsiteArtifact` needs the same change.

When the caller passes `artifactPath`, this resource is not declared. A Composer deploy therefore contains no build node.

### 4.7 Dev mode

Today's local provider spawns `dev.command` and tracks the process in a module-level map, against Alchemy's rule that such a provider use `LocalProvider.make`. Under `alchemy dev` the composite declares no cloud children and declares core's `Command.Dev` for the process, as the AWS and Cloudflare site composites do. The principal engineer's review found this workable, with small behaviour differences. Composer sets Alchemy's dev flag itself, so the Composer change must check that the composite's dev branch does not alter Composer's local graph.

### 4.8 Props on `Prisma.Compute`

| Prop | Change |
| --- | --- |
| `service?: string \| ComputeService` | New. Use this service; do not declare one. This is how a service's own URL, or another service's, gets into its environment: declare the services first, then the Computes. |
| `triggers?` | New. Extra members for the version's `triggers`, for values the application reads that Compute does not write. |
| `destroyOldDeployment` | `true` declares the version child with the removal policy `destroy`. |
| `skipPromote` | The version is not attached to the service as its active version. Each deploy then leaves another version that is never promoted, as today. |
| the rest | Unchanged for the user. |

### 4.9 Behaviour that changes on purpose

1. A failed deploy no longer deletes variables it created. A variable is committed when it is written. It only affects a version created after it.
2. A failed first deploy no longer deletes the service it created. The service stays with no live version and the next deploy continues. Every other composite in Alchemy behaves this way; the engine has no rollback.
3. The previous version is no longer stopped after a promotion. The platform scales it to zero.
4. The monolith's recovery of an interrupted promotion, which could delete a version a person had promoted in the console (`Compute.ts:2397-2446`), is gone. A deploy after a console rollback promotes the declared version again, as any deploy overwrites a change made directly on the platform.

## 5. Composer

Each recorded blocker is removed: Composer declares the service itself and passes it in, so the service's URL is known before any environment row; variables are ordinary `Prisma.EnvironmentVariable` resources; and with `artifactPath` there is no build resource in the graph.

**First Composer pull request** (rollback works): take the new package, rename the two declarations, drop `promote: true` from the version, and attach the version to the service as its active version with `Prisma.activateVersion(service, version)`.

This pull request must also rewrite Composer's saved `Prisma.App` rows to the new shape in Composer's own state store before planning (`lowering/src/state/legacy-resources.ts` already rewrites old rows on read). Found while building the Alchemy change: a service and its version form a cycle, and for a cycle the engine hands a saved row's raw attributes to the other member before the provider can rename them (`packages/alchemy/src/Apply.ts:1047-1053`). An old row has `appId` and no `serviceId`, so the version receives no service ID and the deploy fails. For other Alchemy users the deploy stops with a clear error that tells them to deploy once without `activateVersion` and then add it. Composer must not put its users through two deploys, so it rewrites the rows itself.

**Second Composer pull request** (Composer declares `Prisma.Compute`):

- provision: `Prisma.ComputeService(...)`, as today under the new name, with the node's address as its `logicalId`.
- deploy: `Prisma.Compute(id, { service, artifactPath, artifactContentType, env, triggers, port, … })`.
- `appAfterEnvironment` and the hand-built `triggers` map are deleted.
- A new decision record supersedes the section that chose the three low-level resources, and `docs/design/05-prisma-cloud/alchemy-lowering.md` is updated.

Open points for that second pull request, each needing its own design pass:

- **The host's ID.** Composer's service row is `shop.web`. Two resource types at one ID fail, so the Compute host needs its own ID, and its children's IDs contain `/`. That changes Composer's recorded resource-ID format (the address, or the address plus `.` and a role), and the new decision record must say so.
- **Existing state rows.** Composer's rows `shop.web.deployment` and `shop.web.env.<KEY>` become `<id>/Version` and `<id>/Env/<KEY>`. Composer does not declare the children, so it cannot apply Alchemy's rename to them. Composer rewrites the rows in its own state store before planning (`lowering/src/state/legacy-resources.ts`). That file currently turns `Prisma.ComputeService` rows into `Prisma.App` (lines 50, 351-362) and must change with the rename.
- **Local target.** It supplies its own providers for the three low-level resources. They follow the rename, the local service provider must handle an attached active version, and it needs a provider for the `Prisma.Compute` host.
- **The dev-server path.** A service running its build adapter's dev server has environment rows and no version (`reserve` in the descriptor). Whether that is `Prisma.Compute` with no version or direct variable declarations is undecided.

## 6. Existing stacks declared with today's `Prisma.Compute`

Such a stack has one state row, named `api`, holding the service ID, the current version and the variable IDs. After the upgrade the engine finds that row for the host and no rows for the children. This does not affect Composer, which never declared `Prisma.Compute`.

- A service is found by its `logicalId`. `Prisma.ComputeService` writes one and finds the service by it. Today's monolith creates its service with no `logicalId`, so for these stacks the only correct source for the existing service is the service ID in the old state row. There is no lookup by name.
- How the new code reads that row is not designed. The engine offers no tool that splits one row into several. Candidates: the service child claims the old row through Alchemy's `renamedFrom` plus a type alias, which the principal engineer proposes and nobody has run; or a small change to Alchemy's core. If neither works, existing stacks get a new service and URL on upgrade, and the release note must say so.
- The spike showed that removing the old `Prisma.Compute` row from the program runs the old delete, which deletes the service, and that the deploy still reports success. Redeploying first with `RemovalPolicy.retain()` prevents it. The new host provider must not run the old delete for a row without the marker attribute.
- Where the service ID is known, the spike showed that a variable is adopted correctly by its project, class, Branch and key.

This is the least settled part of the design, and it is the first thing to build and test.

## 7. What was verified

By running code (see `research/spike-results.md`):

- The default removal policy `retain` on replace, on removal from the program and on `destroy`.
- The order of a replacement with a dependent, and what state holds after the dependent fails.
- Children declared from a Platform's hooks, outputs bound back to the host, single declaration on a double yield, the runtime guard, and how decorations reach children.
- Against the real platform: rollback onto a kept version works; a service and a variable can be adopted; removing a monolithic Compute deletes its service.

By reading code: the cause of the bug; Foundry's and the control plane's promote; scale-to-zero; that plain text is written to state.

Not verified:

- No part of the design itself has been built. The package was built and tested in the clone only for the spike.
- The rename-plus-alias route for existing stacks (section 6).
- Whether a version in `standby` is billed, and whether the platform limits how many versions a service keeps. Versions accumulate, as they do for every `Prisma.Compute` user today.
- A live deploy followed by a platform rollback through the finished resources. This is the acceptance test for the project.

## 8. Working the way the Alchemy team works

Read in full: `AGENTS.md` and `.agents/skills/alchemy-provider/SKILL.md`. Agents doing the work must also read that skill's `review.md` and `docs.md`, and the `harden` and `write-docs` skills.

**Code**

- `reconcile` is one observe, ensure, sync flow. It must not branch on whether `output` is defined; a test in the Prisma suite forbids the pattern.
- Every Management API call goes through the generated SDK (`@distilled.cloud/prisma/management`). An error the code must handle has to be a typed error in the SDK. If one is missing, the fix is a patch in the distilled repository, never a cast or a status check in Alchemy.
- No `Effect.orDie` in lifecycle operations. No `async`/`await`, raw promises, `node:fs`, `node:path` or `process.env` in resource code.
- Never write `Input<T>` in a props interface. Every retry and wait is bounded.
- A local provider whose resource is a running process uses `LocalProvider.make`.
- Modules other packages must not import go under `internal/`. Run `pnpm exports:sync` after adding a root module.
- Core (`packages/alchemy`) should not change for a provider. The only possible exception here is section 6.

**Tests**

- Lifecycle behaviour is tested by deploying a stack against the real API with `test.provider`, starting and ending with `stack.destroy()`, with deterministic names, checking the cloud through the SDK. Mocking HTTP or calling provider lifecycle methods directly is forbidden.
- The existing Prisma suites do not follow this: `Compute.test.ts`, `Deployment.test.ts`, `Resources.test.ts` and `ManagementLifecycle.test.ts` run against an in-memory fake and call the provider directly. No test deploys `Prisma.Deployment` or `Prisma.EnvironmentVariable` against a real account. New behaviour gets live tests written to the rule, and the fake-based tests that cover changed behaviour are updated in the same change. Whether to convert the fake-based suites wholesale is for the Alchemy maintainers.
- Four tests pin the package's shape and change with it: `PublicSurface.test.ts`, `SourceConventions.test.ts`, `Providers.test.ts` (stable properties) and `ManagementCoverage.test.ts` (promote and rollback become routes `Prisma.ComputeService` owns).
- Every test carries a `unit`, `local` or `live` tag. A resource with a local provider has a `{Resource}.local.test.ts`.
- CI runs no Prisma suite. Run them with `pnpm test:integration test/Prisma --profile testing`, or with `CI=true` and `PRISMA_SERVICE_TOKEN` set. A green test that leaves resources in the account is a provider bug.
- Setup found by the spike: `git submodule update --init --depth 1 submodules/distilled`; the repository's pinned pnpm needed a wrapper that runs its `pnpm.mjs` through node.

**Docs**

- JSDoc on the resource and on every prop and attribute is the only source of the API reference. Run `pnpm docs:check-jsdoc` and `pnpm docs:gen`. Never edit generated pages.
- The hand-written pages under `website/src/content/docs/prisma/compute/` describe behaviour that changes and are rewritten with the new names.

**Pull request**

- Title in conventional-commit form with `!`, because the changelog is generated from titles: `feat(prisma)!: …`.
- The description starts with a plain summary, uses no heading above `###`, prefers a code snippet to prose, and has no test plan or checklist. Pass the body with `--body-file`. In the Alchemy repository their format wins over Will's own where they differ; the `Agent:` line is kept as the last line.
- A breaking change is announced in the `:::caution` callout at the top of the release blog post.

## 9. Delivery

### Pull requests

- **One to `alchemy-run/alchemy`** for everything: the renames, the service's active version, the version resource, the artifact resource, the composed `Prisma.Compute`, tests, docs and examples.
- **None to `alchemy-run/distilled` is expected.** The SDK is generated from the Management API's OpenAPI spec, and every operation used here is one the package already calls. The one thing that could force one is an error the code must handle that the SDK does not expose as a typed error.
- **The work is built on a branch on the bot's fork.** The bot's token cannot open pull requests on `alchemy-run` repositories. When the branch is ready, Will gets the compare link and the description file.
- **Two to Composer** (section 5).

### What the Alchemy pull request must say up front

Will, 2026-11-14: the Alchemy team must not be surprised. The pull request description states the breaking changes plainly, near the top, before any detail. The same list goes to Will with the compare link, so he can raise it with the maintainers before the pull request is opened.

The position taken on compatibility for other Alchemy users:

- **Their code is not kept compatible.** Renamed exports, props and attributes are compile errors on upgrade. No deprecated names are kept.
- **Their deployed services must not be damaged.** After upgrading, an existing stack either carries on with the same service and URL, or the deploy stops with a clear error that says what to do. It never proceeds and deletes or duplicates a live service.

What the description lists, each with a before-and-after snippet:

1. `Prisma.App` is renamed `Prisma.ComputeService`, and `Prisma.Deployment` is renamed `Prisma.ComputeVersion`. Saved state carries over through type aliases. Code must be renamed.
2. Props and attributes are renamed with them: `app` to `service`, `appId` to `serviceId`, `deploymentId` to `versionId`, `appEndpointDomain` to `serviceEndpointDomain`. This includes the attributes of `Prisma.Compute` that `Prisma.CustomDomain` and the Website composites read.
3. `promote` is removed from the version. Which version is active is declared on the service.
4. A replaced version is kept on the platform by default, where it used to be deleted. `RemovalPolicy.destroy()` restores the old behaviour.
5. `Prisma.Compute` no longer stops the previous version after promoting, no longer deletes the variables or the service a failed deploy created, and no longer recovers an interrupted promotion by deleting the other version.
6. `Prisma.Compute` is now several resources in the engine's graph, so a plan shows several entries where it showed one.
7. What happens to a stack deployed with the old `Prisma.Compute` on upgrade (section 6): the exact behaviour, and the steps a user must take if any.
8. Where a decoration such as `RemovalPolicy.retain()` must be placed on a class-form Compute to take effect.

Questions to put to the maintainers before or with the pull request:

- How many people use the Prisma provider today besides Composer? If close to none, a documented break for old `Prisma.Compute` stacks is enough and no upgrade path needs building.
- Whether they want `App` and `Deployment` kept as deprecated exports for one release after all.
- Whether the fake-based Prisma test suites should be converted to live tests in this pull request or left.
- Why the root modules `ComputeService` and `ComputeVersion` were removed earlier.

The breaking changes also go into the `:::caution` callout of the release blog post.

### Order of work inside the Alchemy pull request

Each step builds and passes the package's tests, so the pull request reads commit by commit. The principal engineer's review has a finer ten-commit version.

1. The renames, with type aliases and continued reading of old attribute names. No behaviour change.
2. `Prisma.ComputeVersion` keeps superseded versions, checks its own URL and plans a replacement for an unknown artifact. `Prisma.ComputeService` gains its active version and `promote` is removed from the version. The monolith calls the same code, so there is one implementation from here on.
3. `Prisma.ComputeArtifact`, and the skip-when-unchanged behaviour for it and `Prisma.WebsiteArtifact`.
4. The upgrade path for existing `Prisma.Compute` stacks (section 6), proven against a real account before the composition is built on it.
5. `Prisma.Compute` becomes the composition. The monolith's service, variable, version and promotion code is deleted. Dev mode moves to `Command.Dev`.
6. Live tests, the four shape tests, JSDoc, the docs pages and the examples.

The principal engineer estimates 4,000 to 6,000 lines added and 8,000 to 11,000 removed.

### Milestones

1. **Done: the design's engine questions are answered** by the spike and the two reviews.
2. **A person who deploys a service with Composer can roll it back in the Prisma Cloud console.** Needs the Alchemy pull request merged and released, then the first Composer pull request. Check: `prisma deploy` twice, roll back in the console, see the first version serving.
3. **A person who uses `Prisma.Compute` directly gets a service whose parts are separate resources**, and can declare a `Prisma.ComputeService` or `Prisma.EnvironmentVariable` beside it. Arrives with the same Alchemy release.
4. **Composer declares `Prisma.Compute`**, so a Composer deploy checks a new version's health before making it live and restores the previous one if the check fails. Needs the second Composer pull request.

## 10. Alternatives considered

- **Composer marks its Deployment with the removal policy `retain`.** Rejected by Will: it works around the model and fixes nothing for other users.
- **Keep one resource and redefine it as the service's live release, updated in place.** An earlier draft. Rejected by Will: the resource would be named for a version and not be one.
- **A `destroyOldDeployment` flag on today's `Prisma.Deployment`.** Withdrawn: it would make the provider's `delete` not delete.
- **Keep both resources and have them call one shared function.** `Prisma.Compute` would stay one opaque node that Composer cannot declare.
- **Make `Prisma.Compute` a plain function that returns a record of children.** It would drop the class declaration, the init Effect, bindings and dev mode.
- **One resource owning a Compute's whole set of variables.** Proposed after the spike showed a removed variable is deleted after the new version is created. Rejected by Will: a version receives the whole Branch's variables whatever one Compute owns, and a service never reads a key that is not in its map.
- **A separate `Prisma.ComputePromotion` resource for the live pointer.** An earlier draft, which wrongly listed the name among Will's decisions. Rejected by Will: the pointer belongs to the service.
- **Keep `promote` as a flag on the version.** Rejected by Will: nothing would stop the model holding two active versions.
- **Stop the previous version after promoting.** Rejected by Will: what the platform does with a version that is no longer live is the platform's concern.
- **Find an existing service by its display name.** Rejected by Will: identity is the `logicalId`.

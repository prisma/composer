# Spike results: engine and platform behaviour behind the Compute composition design

Repository: `wip/alchemy` at `01792ec3`. Every experiment below ran code. File paths are relative to `wip/alchemy` unless they start with `/`.

## Part A: engine experiments

All of part A is one test file with throwaway resource types and in-memory providers that append every lifecycle call to a shared log, in the order the engine makes them:

- File: `packages/alchemy/test/spike-compute-composition.test.ts`
- Command (from `wip/alchemy`, with the pnpm wrapper described under "Setup" on `PATH`): `pnpm test test/spike-compute-composition.test.ts --retry 0 --timeout 60000`
- Result: 13 tests, all passing. The tests print their observations as `SPIKE ...` lines into the run log under `packages/alchemy/.alchemy/log/test/`. The quotes below are copied from those lines.

The throwaway types are:

- `Spike.Version` (V): replaced when its `tag` or `deps` props change, declared with `defaultRemovalPolicy: "retain"` exactly as `AWS.Lambda.Version` does.
- `Spike.VersionDF`: the same, but its diff returns `{ action: "replace", deleteFirst: true }`.
- `Spike.Pointer` (P): takes V's `versionId` as a prop and updates in place. A flag makes its reconcile fail.
- `Spike.Env` (E): one variable.
- `Spike.EnvSet`: one resource owning a whole set of variables, deleting removed keys inside its own reconcile.
- `Spike.Host` and `Spike.Host2`: two minimal `Platform` resources, described under A4.

### A1. A type's default removal policy `retain` on replacement

**Claim.** A resource type declared with `defaultRemovalPolicy: "retain"` keeps the old generation in the cloud when it is replaced: the engine skips the provider's `delete` and drops the state row. A user can opt out with `RemovalPolicy.destroy()`.

**What happened.**

Deploy V with `tag: v1`, then with `tag: v2`:

```
A1.deploy1 calls=["reconcile V V tag=v1 deps=[]"]
A1.replace calls=["reconcile V V tag=v2 deps=[]"]
A1.replace state={"V":{"status":"created","removalPolicy":"retain","attr":{"versionId":"v2-366c0b",...}}}
```

The provider's `delete` was never called for the v1 generation, and state holds only the v2 generation. The row records `removalPolicy: "retain"`, which came from the type's default, since nothing was piped onto the declaration.

Removing V from the program: the plan marks it `orphaned`, not `delete`, and the deploy makes no provider call and drops the row.

```
A1.removePlan {"resources":{},"deletions":{"V":"orphaned"}}
A1.removedFromProgram calls=[] state={}
```

`stack.destroy()` of a stack holding V: no provider call, state emptied.

```
A1.destroy calls=[] state={}
```

With `RemovalPolicy.destroy()` piped onto V, and P depending on V:

```
A1d.replace calls=["reconcile V V tag=v2 deps=[]","reconcile P P version=v2-c8de67","delete V V tag=v1"]
A1d.destroy calls=["delete P P","delete V V tag=v2"]
```

The old v1 is deleted after the new v2 is created and after P has been updated to point at v2. On destroy, P is deleted before V.

**Conclusion: confirmed.** A type's default `retain` reaches the old generation of a replacement, an orphan and a destroy. Piping `RemovalPolicy.destroy()` overrides it, and the old generation is then deleted only after its dependents have been reconciled against the new one. Note for the design: `retain` also applies to `destroy`, so destroying a stack never deletes any `ComputeVersion`. Only deleting the service removes them.

### A2. Order of a replacement with a dependent, and a failing dependent

**Claim.** A new version is created first, then the promotion is updated, then the old version is dealt with. If the promotion fails, nothing is forgotten, and the next deploy tries the promotion again.

**What happened.** V (default `retain`) and P (`version: V.versionId`):

```
A2.replace calls=["reconcile V V tag=v2 deps=[]","reconcile P P version=v2-3d6aae"]
```

The order is new V, then P. Nothing is called on the old V, because it is retained.

Then a third deploy (`tag: v3`) with P's reconcile failing:

```
A2.failedDeploy exit=failure
A2.failed calls=["reconcile V V tag=v3 deps=[]","reconcile P P version=v3-195a36","fail P P"]
A2.failed state={
  "P":{"status":"updating","attr":{"version":"v2-3d6aae"},"old":{"status":"updated","attr":{"version":"v2-3d6aae"}}},
  "V":{"status":"replaced","attr":{"versionId":"v3-195a36","tag":"v3"},"old":{"status":"created","attr":{"versionId":"v2-3d6aae","tag":"v2"}}}}
```

After the failure, V's single state row holds both generations: the new v3 as its attributes, with status `replaced`, and the old v2 under `old`. P's row still holds its old attributes (pointing at v2) with status `updating`. Garbage collection did not run, so the old v2 is still tracked.

The next deploy, with no program change and P no longer failing:

```
A2.recoveryPlan {"resources":{"V":"replace","P":"update"},"deletions":{}}
A2.recovered calls=["reconcile P P version=v3-195a36"]
A2.recovered state={"P":{"status":"updated","attr":{"version":"v3-195a36"}},"V":{"status":"created","attr":{"versionId":"v3-195a36"}}}
```

The plan still shows `replace` for V, but the apply does not reconcile V again: it reuses the v3 generation already created, updates P to v3, and then forgets the retained v2 without calling `delete`.

**Conclusion: confirmed.** The order matches section 4.5 of the design. After a failed promotion, state keeps both versions and the next deploy promotes the version the program declares without creating a third one. One thing the design does not say: during the failed state, P's row still points at the previous version, and V's row reports the new one. A host that copies attributes from bindings (A4c) is reconciled after P, so after a failed promotion it is not reconciled at all and keeps its previous attributes.

### A3. When the engine deletes a resource that is no longer declared

**Claim tested.** Section 5.5 of the design asks whether a removed variable is deleted before or after the new version is created. The platform copies every existing variable into a version when the version is created, so the order matters.

**What happened.** E1, E2, and V with `deps: [E1.key, E2.key]`. Then a program that declares only E1 and V, with `deps: [E1.key]`:

```
A3.plan {"resources":{"E-E1":"noop","V":"replace"},"deletions":{"E-E2":"delete"}}
A3.removeE2 calls=["reconcile V V tag=v deps=[\"E1\"]","delete E E-E2 E2"]
```

**E2 is deleted after the new V is created.** On the platform, the new version would capture the removed variable.

The engine's code explains why: orphan deletions run in `collectGarbage`, which `Apply.ts` calls only after `executePlan` has finished every create, update and replace (`packages/alchemy/src/Apply.ts:356-371`).

Mechanisms tried to make the delete come first:

- `deleteFirst: true` on V's replacement diff. It only changes when the old V is deleted. E2 is still deleted afterwards:

  ```
  A3df.removeE2 calls=["reconcile VDF V tag=v deps=[\"E1\"]","delete E E-E2 E2"]
  ```

- An explicit dependency. The engine has no `dependsOn` for resources (searched `packages/alchemy/src` for `dependsOn`; it appears only in `Nuke.ts` and `Provider.ts`, unrelated). An orphan has no declaration, so there is nothing to attach a dependency to.
- Not tried: a filtered deploy (`include`/`exclude` in `Plan.FilteredPlanOptions`) that deletes the orphan in a first run. That would be a two-run procedure for the user, not something a composite can do in one deploy.

One resource owning the whole set:

```
A3set.removeE2 calls=["EnvSet Env delete key E2","EnvSet Env write key E1","reconcile V V tag=v deps=[[\"E1\"]]"]
```

The removed key is deleted inside the set's reconcile, and V, which depends on the set, is created afterwards.

**Conclusion: confirmed the problem the design suspected.** With one resource per variable, a removed variable is deleted after the new version is created, and no engine mechanism changes that order within one deploy. The design's fallback, one resource that owns the service's whole set of variables, gives the required order.

### A4. A Platform that declares children

Two throwaway Platforms:

- `Spike.Host2` declares its children from `onCreate` (the form without an init Effect).
- `Spike.Host` has a runtime context modelled on `Prisma.Compute`'s: `env`, `set`, `get`, `alwaysServe: true`, and a `serve` hook that reads `Self`, merges `Self.Props.env` with the context's `env`, and declares the children.

Both call one function that, under `Namespace.push(id)`, declares one `Spike.Env` per key, a `Spike.Version` that takes every variable's value in `deps`, and a `Spike.Pointer` named `Promotion` that takes the version. It then binds `{ versionId, envKeys }` onto the host with ``host.bind`Children`(...)``. The host provider copies the bound data into its attributes. Both are guarded on `globalThis.__ALCHEMY_RUNTIME__`. A downstream `Spike.Pointer` takes `host.versionId`.

**a. Form without an init Effect, children from `onCreate`.**

```
A4a.plan {"resources":{"api":"create","api/Env/A":"create","api/Env/B":"create","api/Version":"create","api/Promotion":"create","Downstream":"create"}}
A4a.deploy calls=["reconcile E api/Env/A A=1","reconcile E api/Env/B B=2","reconcile V Version ...","reconcile P Promotion version=v-4b50c8",
  "reconcile Host2 api bindings=[{\"sid\":\"Children\",\"data\":{\"versionId\":\"v-4b50c8\",\"envKeys\":[\"A\",\"B\"]}}] ...",
  "reconcile P Downstream version=v-4b50c8"]
```

Confirmed. `onCreate` receives the resolved props, and the children's FQNs are `api/Env/A`, `api/Version`, `api/Promotion`.

**b. Class form, init calls `set`, children from `serve`.** The init calls `RuntimeContext.set("FROM_INIT", ...)` directly and also `Output.literal("bound").bind("FROM_BIND")`, which is how `Prisma.Connect` adds a variable. The class's props have `env: { FROM_PROPS: "p" }`.

```
A4b.plan {"resources":{"api":"create","api/Env/FROM_BIND":"create","api/Env/FROM_INIT":"create","api/Env/FROM_PROPS":"create","api/Version":"create","api/Promotion":"create","Downstream":"create"}}
A4b.deploy calls=["reconcile E api/Env/FROM_PROPS FROM_PROPS=p","reconcile E api/Env/FROM_INIT FROM_INIT=i","reconcile E api/Env/FROM_BIND FROM_BIND=bound",
  "reconcile V Version tag=v deps=[\"bound\",\"i\",\"p\"]","reconcile P Promotion ...","reconcile Host api bindings=[...] envKeys=[\"FROM_BIND\",\"FROM_INIT\",\"FROM_PROPS\"]","reconcile P Downstream ..."]
```

Confirmed, with two conditions the design must state:

1. **`serve` is not called when the init returns nothing.** `Platform.ts` returns early on a falsy init result before it looks at `alwaysServe` (`packages/alchemy/src/Platform.ts:504-505`: `if (!impl) return Effect.void;`). A class whose init returns `undefined` declared no children at all:

   ```
   A4b.voidInit.plan {"resources":{"apiVoid":"create"}}
   A4b.voidInit.declared []
   ```

   A Compute init that only registers `run` loops, or returns nothing, would deploy a host with no service, version or variables. The fix is either a one-line change to `Platform.ts` (check `alwaysServe` before the falsy check) or declaring the children from a moment that always runs. `runtimeContext.exports` is evaluated after the init unconditionally (`Platform.ts:630-637`), but I did not test declaring children from it.
2. **Inside `serve`, `Self.Props.env` does not yet contain the keys the init set.** `Platform` merges the context's `env` into `Props` only after the init and `serve` have returned (`Platform.ts:630-637`). The hook must read the runtime context's own `env` map, as effect-cluster does with `base.env`. The spike's hook merges both.

**c. Outputs reach the host through bindings.** In both forms the host's reconcile ran after the version and the promotion, received `bindings=[{"sid":"Children","data":{"versionId":...,"envKeys":[...]}}]`, and returned the bound values as attributes. A downstream resource reading `host.versionId` got the version's ID (`A4a.output {"versionId":"v-4b50c8","downstream":"v-4b50c8"}`). The host also received the init-set keys in `news.env`. **Confirmed.**

**d. Yielding the same Platform twice.**

- Form without init: two `yield* SpikeHost2("api", ...)` in one program ran `onCreate` once: `A4d.noinit.declared ["onCreate:api"]`. Confirmed.
- Class form, yielded twice inside one `Effect.provide(ApiLive)`: the Layer builds once and `serve` runs once: `A4d.class.declared ["serve:api"]`. Confirmed.
- Class form, provided twice in two separate `Effect.provide(ApiLive)` calls: the Layer builds twice and `serve` runs twice (`["serve:api","serve:api"]`). The plan was still correct, because declaring a child with the same FQN and the same props a second time returns the first registration. The children's props would have to be identical both times, so the composite must derive them only from the props and the init.

**e. Guard on `globalThis.__ALCHEMY_RUNTIME__`.** With the flag set (in an `exclusive` test), both forms planned only the host:

```
A4e.noInit {"resources":{"api":"create"}}
A4e.class {"resources":{"api":"create"}}
A4e.declared ["onCreate:skipped-at-runtime","serve:skipped-at-runtime"]
```

Confirmed: both hooks run at runtime, and the guard is what stops them.

**f. `RemovalPolicy.retain()` and `adopt(true)` piped onto the Platform declaration.**

```
A4f.noInit          {"api":{"removalPolicy":"retain","adopt":true},"api/Env/A":{"retain",true},"api/Version":{"retain",true},"api/Promotion":{"retain",true}}
A4f.classOnYield    {"api":{"removalPolicy":"destroy","adopt":false},"api/Env/...":{"destroy",false},"api/Version":{"retain",false},"api/Promotion":{"destroy",false}}
A4f.classOnProvide  {"api":{"retain",true}, every child {"retain",true}}
```

(Abbreviated; the full lines are in the log.)

- Form without init: the decorations reach every child declared in `onCreate`, as the engine research predicted.
- Class form, decorations piped onto `yield* Api`: they reach nothing, not even the host. The class's Layer is built where `Effect.provide(ApiLive)` runs, and the decorations are read from that context. This is how every Platform class form behaves today, not something this design introduces.
- Class form, decorations piped onto the region that provides the Layer: they reach the host and every child declared in `serve`.

Two consequences for the design. First, a user's `RemovalPolicy.retain()` on a Compute makes every child retained, including the variables and the promotion, so destroying that stack deletes nothing on the platform. That is probably what such a user wants. Second, `adopt(true)` on a Compute reaches every child, so the composite's own choice of adoption for its children (section 7) must be applied inside the composite, explicitly per child, and it then takes precedence over the user's.

**Workarounds needed in part A.** None in the engine. The A4 children are declared from an Effect that the hook runs under `Namespace.push(id)`; no source file was changed.

### Summary of part A

| Experiment | Result |
| --- | --- |
| A1 default `retain` on replacement, orphan and destroy | confirmed; `RemovalPolicy.destroy()` deletes the old one after its dependents are updated |
| A2 order of replace and dependent; failed dependent | confirmed; state keeps both generations, the next deploy reuses the new one |
| A3 removed variable deleted before the new version | refuted: it is deleted after, and no engine mechanism changes that; one resource owning the set works |
| A4a children from `onCreate` | confirmed |
| A4b children from `serve` after init | confirmed, but only when the init returns a value, and the hook must read the context's `env` |
| A4c outputs bound onto the host | confirmed |
| A4d yielding twice | confirmed once per Layer build; two separate provides declare twice, harmlessly when props match |
| A4e runtime guard | confirmed |
| A4f decorations | reach children in the form without init and when piped around the Layer's provide; not when piped onto `yield*` of a class |

## Part B: live experiments against a real Prisma account

- File: `packages/integration-tests/test/Prisma/spike-compute-composition.live.test.ts`
- How the token reaches the runner: `set -a; . ~/.config/prisma-compose/deploy.env; set +a`, then `CI=true` in the same command. With `CI=true` the Prisma auth provider skips profiles and reads `PRISMA_SERVICE_TOKEN` from the environment (`packages/prisma/src/AuthProvider.ts:36-53`). `PRISMA_WORKSPACE_ID` was not needed: the service token is scoped to the workspace.
- Command: `CI=true SPIKE_SUFFIX=<suffix> pnpm test:integration test/Prisma/spike-compute-composition.live.test.ts -t <B1|B3> --retry 0 --timeout 1500000`
- Projects are named `spike-compute-composition-<suffix>-<b1|b3>` in `us-east-1`.

### B1, first attempt (interrupted)

The first complete run deployed version A and version B with today's `Prisma.Deployment` (`start: true, promote: true`, `RemovalPolicy.retain()` piped on). It then lost the network during a 30-second wait, timed out, and its teardown was abandoned halfway. What it recorded before that:

```
B1.afterA {"versionA":"cpv_oxv67yg7t587zigxdim3kxc2","latestDeploymentId":"cpv_oxv67yg7t587zigxdim3kxc2","versions":[{"id":"cpv_oxv67yg7t587zigxdim3kxc2","status":"running"}]}
B1.urlAfterA "A:none"
B1.afterB {"versionA":"cpv_oxv67...","versionB":"cpv_euxe8j5wjr78acyilouvmtkk","latestDeploymentId":"cpv_euxe8j5...",
           "versions":[{"id":"cpv_euxe8j5...","status":"running"},{"id":"cpv_oxv67...","status":"running"}]}
B1.versionAStatusRightAfterB "running"
```

The engine log of that run also shows the retain path on a real resource: `[Deployment] Retaining replaced resource (removal policy: retain)... Replaced resource retained.`

The abandoned teardown left project `proj_drl9dbo5f4ksj0s3sb2bye8b` (`spike-compute-composition-k7q2-b1`) with service `cps_urmy9v8mhn8tt4w4jz5l54jf`. A cleanup test in the same file (`-t Bclean`) lists every project whose name starts with `spike-compute-composition-` and deletes only the IDs passed in `SPIKE_DELETE_PROJECT_IDS`. It deleted that project, and `getProject` then returned `NotFound`.

### B1. Does the platform stop the previous version when another is promoted?

**Claim.** The design assumes it does not, so `Prisma.ComputePromotion` must stop the previous version itself.

**What I ran.** `-t B1`, suffix `m3x9`. A tiny Bun server whose response is its version label, archived with `createComputeArchive`, deployed with `Prisma.Project`, `Prisma.App` and `Prisma.Deployment({ start: true, promote: true, portMapping: { http: 8080 } }).pipe(RemovalPolicy.retain())`. Then the same with a changed label. Statuses read with `getService`, `getServiceDeployments` and `getDeployment`.

**What happened.**

```
B1.afterA {"versionA":"cpv_uptpf3d6fdq40kywmrhyh1sg","latestDeploymentId":"cpv_uptpf3d6...","versions":[{"id":"cpv_uptpf3d6...","status":"running"}]}
B1.urlAfterA "A:none"
B1.afterB {"versionB":"cpv_eox9t35cvwy3lfqi2irurxte","latestDeploymentId":"cpv_eox9t35...",
           "versions":[{"id":"cpv_eox9t35...","status":"running"},{"id":"cpv_uptpf3d6...","status":"running"}]}
B1.versionAStatusRightAfterB "running"
B1.versionAStatus30sAfterB "running"
B1.urlAfterB "B:none"
```

Both runs (this one and the interrupted one) agree.

**Conclusion: confirmed.** The platform does not stop the previous version when another is promoted. Version A's raw status stays `running` 30 seconds after B is live. The promotion must stop it, as section 4.4 step 5 says. With `retain`, A is kept on the service and is not tracked by Alchemy any more.

### B2. Does the platform's rollback work onto a retained, stopped version?

**What I ran.** Same test. Stop A with `createDeploymentStop` and poll until `stopped`. Call `createServiceRollback({ serviceId, deploymentId: A })`, poll `getService` until `latestDeploymentId` is A, then fetch the service's stable URL until it answers with A's label.

**What happened.**

```
B2.stoppedA "stopped"
B2.rollbackResponse {"_tag":"Success","value":{"data":{"appEndpointDomain":"https://bae7tx1o3kgvshi6snpa922w.ewr.prisma.build","reassignedDomains":0}}}
B2.liveAfterRollback {"latest":"cpv_uptpf3d6fdq40kywmrhyh1sg","seconds":2.833}
B2.statusesAfterRollback {"a":"running","b":"running"}
B2.urlAfterRollback {"body":"A:none","seconds":5.663}
B1.projectGone true
```

**Conclusion: confirmed.** Rollback onto a stopped, retained version succeeds. The service reported A as live within 3 seconds, the platform started A again by itself (its status went from `stopped` to `running`), and the stable URL answered with A within 6 seconds. Rollback does not stop the version it moved away from: B was still `running` afterwards. A stopped version is therefore a usable rollback target, which is what the design needs, and a rollback made in the console leaves two versions running until the next deploy's promotion stops one.

Cleanup: the test's `stack.destroy()` deleted the service and project, and `getProject` returned `NotFound` (`B1.projectGone true`). Retained version rows are dropped from state but the versions are deleted with the service.

### B3. Adoption of a monolithic `Prisma.Compute`'s service and variable

**What I ran.** `-t 'B3.*plain'`, suffix `m3x9`. Stack 1: `Prisma.Project` and today's `Prisma.Compute("Api", { project, path, entrypoint: "server.ts", port: 8080, env: { GREETING: "hello" } })`. Stack 2, same state: the same `Prisma.Project`, no Compute, and under different logical IDs `Prisma.App("Service", { project, displayName: <the Compute's appName> }).pipe(adopt(true))` and `Prisma.EnvironmentVariable("Greeting", { project, class: "production", key: "GREETING", value: Redacted.make("hello") }).pipe(adopt(true))`. The plan was recorded before the deploy ran.

**Variant 1: the old Compute row is simply no longer declared.**

```
B3.plain.compute {"appId":"cps_blab6askym3r3yupn9w45ww2","appName":"Prisma-spike-compute-composition-live-B3bxw46rr6c2cf3ye6qmyc76wi",
                  "environmentKeys":["GREETING"],"variables":[{"id":"envvar_nzgdzo49uwhywjber4qqek01","key":"GREETING","class":"production","branchId":null}]}
B3.plain.plan {"resources":{"Project":"noop","Service":"adopted","Greeting":"adopted"},"deletions":{"Api":{"action":"delete","removalPolicy":"destroy"}}}
```

The plan adopts the existing service and the existing variable, and plans a `delete` of the old `Prisma.Compute` row. The deploy then ran in this order (engine log):

```
[Service] adopting   [Greeting] adopting
[Greeting] adopted (2.9s)
[Service] adopted (4.5s)
[Api] deleting
[Api] deleted (2.8s)
Done: 3 succeeded
```

and afterwards:

```
B3.plain.deployResult {"ok":true,"value":{"serviceAppId":"cps_blab6askym3r3yupn9w45ww2","sameService":true}}
B3.plain.serviceAfter {"exists":false}
B3.plain.variablesAfter []
```

The adopted `Prisma.App` had the same service ID as the Compute's, so the service was adopted and no second one was created. The variable was adopted too. Then the orphan delete of the old Compute row ran `Compute`'s delete, which deleted the service and its variables. **The deploy reported success, and state now holds a `Prisma.App` and a `Prisma.EnvironmentVariable` whose platform objects no longer exist.** The next deploy would recreate the service under a new ID and URL.

**Conclusion for this variant: the adoption itself works, and the only way forward without further steps deletes the service.** Adoption alone does not satisfy the requirement that an upgraded stack keeps its service and URL. Something must stop the old row's delete. Section 7 of the design proposes that the new host provider recognises the old row and deletes nothing; this experiment had no host at the old ID, so the old provider's delete ran. The design's approach keeps a `Prisma.Compute` at the same logical ID, which is a different situation and was not tested here.

**Variant 2: the old Compute row is first redeployed with `RemovalPolicy.retain()`, then removed from the program.** `-t 'B3.*retainFirst'`, suffix `m3x9`.

```
B3.retainFirst.compute {"appId":"cps_zm6eexdopdi13kti2fi3o7no","variables":[{"id":"envvar_ubz215h2kj2rmwv5yi32vlhb","key":"GREETING","class":"production","branchId":null}]}
B3.retainFirst.retainPlan {"resources":{"Project":"noop","Api":"update"},"deletions":{}}
B3.retainFirst.plan {"resources":{"Project":"noop","Service":"adopted","Greeting":"adopted"},"deletions":{"Api":{"action":"orphaned","removalPolicy":"retain"}}}
B3.retainFirst.deployResult {"ok":true,"value":{"serviceAppId":"cps_zm6eexdopdi13kti2fi3o7no","sameService":true}}
B3.retainFirst.serviceAfter {"exists":true,"name":"Prisma-spike-compute-composition-live-B3jmg3f5tatpzr7fg3rsm4nau5","latest":"cpv_m4usmz4rid2ijwqxnr40qhov"}
B3.retainFirst.variablesAfter [{"id":"envvar_ubz215h2kj2rmwv5yi32vlhb","key":"GREETING","class":"production","branchId":null}]
```

The redeploy with `retain` planned an `update` of the Compute, not a no-op, because `Prisma.Compute`'s diff always plans an update; it ran a full Compute reconcile to re-commit the policy. The removal then planned `orphaned`, ran no delete, and the service and the variable survived with the same IDs, now owned by the `Prisma.App` and `Prisma.EnvironmentVariable` rows.

**Conclusion: confirmed for this variant.** Adoption keeps the service and variable when the old row's delete is suppressed. Two-step migrations like this one need the user to deploy twice; the design's alternative is for the composed host provider to skip the old delete itself (section 7), which this spike did not test.

Cleanup for B3: each variant's `stack.destroy()` deleted the project (`projectGone true` in both). In variant 1 the service and variable had already been deleted by the old Compute's delete.

## Cleanup

A final run of the cleanup test, listing only, found no project whose name starts with `spike-compute-composition-`:

```
Bclean.found []
```

Nothing created by this spike remains on the Prisma account. Projects created and deleted: `proj_drl9dbo5f4ksj0s3sb2bye8b` (interrupted B1, deleted by the cleanup test), and the B1, B3 plain and B3 retainFirst projects of suffix `m3x9` (deleted by their own destroys, `getProject` returned `NotFound`).

## Type check

One `pnpm exec tsrs -b` after the tests. The workspace sources and the live test file are clean. The engine spike file has 10 type errors, all from its loosely typed throwaway resources (for example `Property 'version' does not exist on type 'Input<{ version: string; }>'` in a `diff` that does not narrow with `isResolved`, and `yield*` on a Platform class typed as `any`). They do not affect what the tests showed, and they were not fixed because the file is throwaway.

## Files created

Delete these to remove the spike:

- `wip/alchemy/packages/alchemy/test/spike-compute-composition.test.ts`
- `wip/alchemy/packages/integration-tests/test/Prisma/spike-compute-composition.live.test.ts`
- Test logs under `wip/alchemy/packages/alchemy/.alchemy/log/test/` and `wip/alchemy/packages/integration-tests/.alchemy/log/test/` (gitignored, pruned after a week)
- Outside the repository: a one-line `pnpm` wrapper at `/private/tmp/claude-502/-Users-will-Projects-prisma-composer--claude-worktrees-s3-closeout-handover-2ba967/047a0842-4c8c-4e4e-89e7-ef143e0a33c7/scratchpad/bin/pnpm`

No existing source file was modified. `git status` in `wip/alchemy` shows only the two spike test files as changes; everything `pnpm install` generated is gitignored.

## Setup that was needed

1. `git submodule update --init submodules/distilled` cloned the full history slowly (about 16 MB a minute) and was killed after the network dropped. What worked: `git submodule update --init --depth 1 submodules/distilled`, which fetched only commit `83e119cc` in a few minutes.
2. `pnpm install` failed before doing anything: the repository pins `pnpm@12.15.0`, and the globally installed pnpm tried to switch to it, but the cached 12.15.0 at `~/Library/pnpm/.tools/pnpm/12.15.0/` has only its shebang-less shell shim, not the native binary, so spawning it fails with `ENOEXEC`. Running `node ~/Library/pnpm/.tools/pnpm/12.15.0/node_modules/pnpm/bin/pnpm.mjs` works. The repository's `prepare` script calls `pnpm` again, so a wrapper script named `pnpm` that runs that command was put first on `PATH`. With it, `pnpm install` completed in 90 seconds. `--ignore-scripts` was not needed.
3. Every `pnpm test`, `pnpm test:integration` and `pnpm exec tsrs -b` ran with that wrapper on `PATH`. pnpm warns that the project wants Node 24 and the machine has Node 26.8.1; nothing failed because of it.
4. Live runs: `set -a; . ~/.config/prisma-compose/deploy.env; set +a` and `CI=true` in the same shell command. No credential value was printed or written.

## A5. A service that points at its active version

**The model.** Two resources. A Service holds a pointer to its active Version. A Version belongs to a Service. Promoting a version means changing the Service's pointer. The intended order at runtime is: create the Service with no active version, create the Version under it, then set the Version as the Service's active version. That is a cycle: the Version needs the Service's ID, and the Service needs the Version's ID.

**What I ran.**

- File: `wip/alchemy/packages/alchemy/test/spike-service-active-version.test.ts` (left in place).
- Command (from `wip/alchemy`, with the pnpm wrapper on `PATH`): `pnpm test test/spike-service-active-version.test.ts --retry 0 --timeout 60000`
- Result: 10 tests, all passing. The quotes below come from the `SPIKE` lines in the run log `packages/alchemy/.alchemy/log/test/2026-11-13T04-39-23-pid39765.log`, and, for cases 7 and 8 with the engine's default diff, from the earlier run `2026-11-13T04-38-14-pid36951.log`. Both runs used the same code for those cases.

The throwaway types:

- `A5.Service`: attributes `serviceId`, `url`, `activeVersionId`, `previousActiveVersionId`. Its binding contract is `{ versionId }`. It has a `precreate` that returns a stub with `activeVersionId: null`. Its `reconcile` sets `activeVersionId` from the bound data and `previousActiveVersionId` from its own `output`.
- `A5.ServiceNoPrecreate`: the same type without `precreate`.
- `A5.Version`: props `service` and `tag`. It is replaced when `tag` changes, and it is declared with `defaultRemovalPolicy: "retain"`.
- `A5.Env`: takes the service ID.
- `A5.Reader`: reads one attribute of the Service.

What I read first:

- `AGENTS.md`, "Concepts": Pre-Create, Observe, Binding, Dependency.
- `Provider.ts`: `precreate` and `observe`.
- `Plan.ts`:
  - the error for a ref that closes a cycle through props, `Plan.ts:421-460` and `1236-1256`;
  - how binding and prop edges become cycles, `1285-1370`;
  - the check for a cycle that cannot be broken, `2188-2235`;
  - which attributes a downstream resource sees when an upstream resource updates, `900-960`.
- `Apply.ts`:
  - how cycle peers wait for each other's early "ready" signal while everything else waits for the final output, `443-520`;
  - when precreate runs, `880-912` and `1322-1386`;
  - the pass that re-runs cycle members against final outputs, `1725+`.
- `Resource.ts`: `bind`, `Resource.ts:518-569`.
- The `precreate` of `AWS.Lambda.Function`, `packages/aws/src/Lambda/Function.ts:3051+`.

### 1. Declaration shape

**(a) The Version takes `service` as a prop, and the Version binds itself as the Service's active version. This works.**

```ts
const service = yield* A5Service("Service", {});
const version = yield* A5Version("Version", { service: service.serviceId, tag });
yield* service.bind("Active", { versionId: version.versionId });
```

```
A5.1a.plan {"resources":{"Service":"create","Version":"create"},"cycle":["Service","Version"]}
A5.1a calls=["precreate Service Service bindings=[{\"sid\":\"Active\",\"data\":{}}]",
             "reconcile Version Version service=svc-688da8 tag=v1",
             "reconcile Service Service output.activeVersionId=- olds=no bindings=[{\"sid\":\"Active\",\"data\":{\"versionId\":\"ver-v1-6ce9fc\"}}]"]
A5.1a.output {"serviceId":"svc-688da8","active":"ver-v1-6ce9fc","versionId":"ver-v1-6ce9fc"}
```

The engine sees the cycle: the Version depends on the Service through a prop, and the Service depends on the Version through the binding. Because the Service has `precreate`, the engine breaks the cycle there.

**(b) Both as plain props. This is impossible.** A resource cannot reference another before it is declared, so one side has to use a ref (`A5Version.ref("Version")`). The plan then dies before it calls anything:

```
A5.1b.result RefCycleError: 'Service' references 'Version' through a ref in its props, and 'Version' depends on 'Service'
  through props (Service -> Version -> Service). Neither can be planned before the other. Bind the reference instead of
  passing it as a prop, so the cycle runs through bindings.   (Plan.ts:1246)
A5.1b.calls []
```

**(c) Anything else.** The engine's own error message points to shape (a). The binding shape also needs `precreate` on at least one resource in the cycle. Without it the plan fails:

```
A5.1c.result UnsatisfiedResourceCycle: Circular dependency detected that cannot be resolved: [Service, Version].
  Resources lacking a precreate handler: [Service, Version].   (Plan.ts:2227)
```

The other way to avoid the cycle is a third resource that holds the pointer: a promotion resource that takes both the Service and the Version. That is the design in section 4 and has no cycle. Under this model, (a) with `precreate` on the Service is the only shape that works.

### 2. First deploy

The order is exactly the intended one:

1. **`precreate Service`.** The engine passes the binding with unresolved data (`{"sid":"Active","data":{}}`). The provider creates the Service with no active version and returns its ID.
2. **`reconcile Version`** with the real Service ID.
3. **`reconcile Service`** with `output` undefined, `olds` undefined, and `bindings=[{"sid":"Active","data":{"versionId":"ver-v1-..."}}]`. It sets the active version.

The state row for the Service was `creating` from the precreate stub, then `created` with `activeVersionId` set.

So the precreate must work with unresolved binding data, and the reconcile that follows receives `output === undefined` even though precreate already created the platform object. The real provider's reconcile must therefore find the service its precreate created. This is the usual reconcile rule: observe first, never assume from `output`.

### 3. New version

```
A5.3.plan {"resources":{"Service":"update","Version":"replace"},"cycle":[]}
A5.3 calls=["reconcile Version Version service=svc-3fb1cc tag=v2",
            "reconcile Service Service output.activeVersionId=ver-v1-0e270b olds=yes bindings=[{\"sid\":\"Active\",\"data\":{\"versionId\":\"ver-v2-64bcd4\"}}]"]
A5.3 state={"Version":{"status":"created","attr":{"versionId":"ver-v2-64bcd4",...}},
            "Service":{"status":"updated","attr":{"activeVersionId":"ver-v2-64bcd4","previousActiveVersionId":"ver-v1-0e270b"}}}
```

- The new Version is created first, with the existing Service ID.
- The Service is then reconciled with the new Version's ID.
- **The Service's provider does see the previous active version, in its own `output.activeVersionId` (`ver-v1-...`).** That is how the provider knows which version to stop.
- The old Version is forgotten without a `delete` call, because of its default `retain`.
- There is no precreate on later deploys. The Service already exists, and a cycle member that is being updated signals "ready" early with its previous output (`Plan.ts:2189-2191`).

### 4. The Service's reconcile fails on the second deploy

```
A5.4.afterFailure calls=["reconcile Version Version service=svc-69df3f tag=v2",
                         "reconcile Service Service output.activeVersionId=ver-v1-76570e ... versionId=ver-v2-214d76",
                         "fail Service Service"]
A5.4.afterFailure state={
  "Version":{"status":"replaced","attr":{"versionId":"ver-v2-214d76",...},"old":{"status":"created","attr":{"versionId":"ver-v1-76570e",...}}},
  "Service":{"status":"updating","attr":{"activeVersionId":"ver-v1-76570e",...},"old":{"status":"created","attr":{"activeVersionId":"ver-v1-76570e"}}}}
A5.4.recoveryPlan {"resources":{"Service":"update","Version":"update"},"cycle":["Service","Version"]}
A5.4.recovered calls=["reconcile Service Service output.activeVersionId=ver-v1-76570e ... versionId=ver-v2-214d76",
                      "reconcile Version Version service=svc-69df3f tag=v2"]
A5.4.recovered state={"Version":{"status":"created","attr":{"versionId":"ver-v2-214d76"}},
                      "Service":{"status":"updated","attr":{"activeVersionId":"ver-v2-214d76","previousActiveVersionId":"ver-v1-76570e"}}}
```

- **After the failure,** the Version row holds both generations: the new v2 as its attributes and the old v1 under `old`. The Service row is `updating` and still says v1 is active.
- **The next deploy** creates no third version. It points the Service at v2, and the provider again sees v1 in its `output`, so it can stop v1. The old v1 is then forgotten without a `delete`.
- **One thing to know.** In the recovery deploy both resources were updates inside a cycle. Each signalled "ready" early, so the Service reconciled before the Version. That was harmless here because the Version's ID was already known from the failed run. Two cycle members that are both being updated in place have no guaranteed order between their reconciles. The order the model needs, new Version before Service, holds when the Version is created or replaced, because a create or replace without `precreate` only signals after its reconcile.

### 5. Exactly one active version

The simplest enforcement is in the Service's provider: count the binding rows whose sid starts with `Active`. Counting needs only the rows, not their resolved values.

- **On a service that already exists,** the check goes in `diff`, and the plan fails before anything runs:

  ```
  A5.5.existingPlan TwoActiveVersions: Service 'Service' has 2 versions bound as its active version (Active, Active-VersionTwo); exactly one is allowed.
  A5.5.existing calls=["diff Service Service rejects 2 active versions", ...]
  ```

  No version was created. State was unchanged.

- **On a first deploy,** `diff` is not called, because there is no previous state. So the plan cannot catch it (`A5.5.plan success`). The check in `precreate` catches it before any Version is reconciled:

  ```
  A5.5.deploy TwoActiveVersions: Service 'Service' has 2 versions bound as its active version; exactly one is allowed.
  A5.5 calls=["precreate Service Service bindings=[{\"sid\":\"Active-VersionOne\",\"data\":{}},{\"sid\":\"Active-VersionTwo\",\"data\":{}}]",
              "precreate Service Service rejects 2 active versions"]
  A5.5 state={"VersionOne":{"status":"creating"},"Service":{"status":"creating"},"VersionTwo":{"status":"creating"}}
  ```

  The rows are left as `creating` with no attributes, and nothing was created. Before I added the `precreate` check, the same program created both Versions and failed only in the Service's `reconcile`.

So: check in `diff` for updates and in `precreate` for creates. `reconcile` is too late.

### 6. No active version

```
A5.6.alonePlan {"resources":{"Service":"create"},"cycle":[]}
A5.6.alone calls=["reconcile Service Service ... bindings=[]"]                         -> activeVersionId null
A5.6.addPlan {"resources":{"Service":"update","Version":"create"},"cycle":[]}
A5.6.addVersion calls=["reconcile Version ...","reconcile Service ... bindings=[{...versionId: ver-v1-17dfe4}]"]
A5.6.removePlan {"resources":{"Service":"update"},"deletions":{"Version":"orphaned"}}
A5.6.removeVersion calls=["reconcile Service Service output.activeVersionId=ver-v1-17dfe4 olds=yes bindings=[]"]
A5.6.removeVersion state={"Service":{"activeVersionId":null,"previousActiveVersionId":"ver-v1-17dfe4"}}
```

- A Service with no Version deploys and has no active version. No cycle forms, so no precreate runs.
- Adding a Version later works, and the order is right: Version first, then Service.
- Removing the Version's declaration reconciles the Service with no binding, and the Version is orphaned without a `delete`. What the Service then does is the provider's choice. In the spike it set `activeVersionId: null`. **On the real platform there is no "unpromote", so a real provider must decide what an empty binding means**, for example keep serving the last version and report it, or fail.

### 7. A variable that must exist before the Version

The Env takes the Service's ID, and the Version takes the Env's output, so it waits for it.

```
A5.7.plan {"resources":{"Service":"create","Env":"create","Version":"create","UrlReader":"create","ActiveReader":"create"},
           "cycle":["Env","Service","Version"]}
A5.7.first calls=["precreate Service ...","reconcile Env Env service=svc-66d2af","reconcile Version ...",
                  "reconcile Service ... versionId=ver-v1-16e7e5","reconcile Reader UrlReader ...","reconcile Reader ActiveReader value=\"ver-v1-16e7e5\""]
```

The order holds: Service stub, variable, Version, then the Service is finished. The engine puts the Env inside the cycle (Env depends on Service, Version depends on Env, Service depends on Version through the binding). So the Env waits only for the precreate stub, not for the Service's final reconcile. Without that, it would deadlock.

### 8. Readers downstream of the Service

Readers outside the cycle wait for the Service's final reconcile (`Apply.ts:494-516`). On the first deploy both saw final values: the URL and `ver-v1-...`.

**On a new version, with the engine's default diff, the reader of the active version ID kept the old value:**

```
A5.8.plan {"resources":{"Service":"update","Env":"noop","Version":"replace","UrlReader":"noop","ActiveReader":"noop"}}
A5.8.newVersion calls=["reconcile Version ... tag=v2","reconcile Service ... versionId=ver-v2-594f8d"]
A5.8.newVersion state={"Service":{"activeVersionId":"ver-v2-594f8d"}, "ActiveReader":{"attr":{"value":"ver-v1-16e7e5"}}}
```

The reason is in `Plan.ts:916-926`. When the provider's `diff` returns nothing and the props are unchanged, a binding change counts as a reason to treat the attributes as changed only for resources outside a cycle. The Service is in the combined cycle, so the planner hands downstream resources the old attributes (`Plan.ts:955`), and the reader plans `noop`.

**The fix is in the Service's provider.** Its `diff` returns `{ action: "update", stables: ["serviceId", "url"] }` whenever the bindings are unresolved or changed. Then:

```
A5.8b.plan {"resources":{"Service":"update","Version":"replace","UrlReader":"noop","ActiveReader":"update"}}
A5.8b.newVersion calls=["reconcile Version ... tag=v2","reconcile Service ... versionId=ver-v2-2b1c28","reconcile Reader ActiveReader value=\"ver-v2-2b1c28\""]
```

The URL reader correctly stays `noop`, because `serviceId` and `url` are declared stable. The active-version reader updates to the new value.

### 9. Destroy, and the known deadlock

```
A5.9.destroy calls=["delete Reader UrlReader","delete Env Env","delete Reader ActiveReader","delete Service Service"]
A5.9.destroy state={}
```

Dependents are deleted before the Service. The Version gets no `delete` because of its default `retain`. Nothing deadlocked. Inside the cycle, the binding edge from the Version to the Service does not make the Service wait on the Version during deletes (`Plan.ts:1321-1360`), but the prop edge from the Version to the Service still orders the Version before the Service.

**The known deadlock** (`AGENTS.md`, speed doctrine) is "a deploy that replaces a resource while removing its old dependency". I tested that shape: a new Version declared in the same deploy that drops the Env it depended on.

```
A5.9b.plan {"resources":{"Service":"update","Version":"replace"},"deletions":{"Env":"delete"}}
A5.9b calls=["reconcile Version Version ... tag=v2","reconcile Service ... versionId=ver-v2-30fb2c","delete Env Env"]
```

It finished well inside its 15-second limit. This model does not hit that deadlock in this shape. As A3 found, the removed Env is deleted after the new Version is created.

### Recommendation

Use shape (a):

- The Version takes the Service's ID as a prop.
- The Version binds itself onto the Service with `service.bind("Active", { versionId })`.
- The Service's provider implements `precreate`. It creates the Service with no active version and must accept unresolved binding data.

The Service's provider must also do these things:

1. **Check for more than one active version** in `diff` (for an existing service) and in `precreate` (for a new one). `reconcile` is too late: on a first deploy both Versions would already exist.
2. **Return `{ action: "update", stables: ["serviceId", "url"] }` from `diff`** whenever its bindings are unresolved or changed. Otherwise the engine hands downstream readers the old `activeVersionId` (`Plan.ts:916-926`), because the Service is in a cycle.
3. **Make `reconcile` find the service it created in `precreate`.** On the first deploy `reconcile` gets `output === undefined`.
4. **Decide what an empty binding means.** The platform has no "unpromote".

Engine limitations the design must work around:

- **Plain-prop cycles fail** with `RefCycleError` (`Plan.ts:1246`).
- **A cycle with no `precreate` fails** with `UnsatisfiedResourceCycle` (`Plan.ts:2227`).
- **Two cycle members that are both updated in place have no guaranteed order** between their reconciles. The Version-before-Service order holds only because a new Version is a replacement.
- **The A3 finding still applies.** A removed variable is deleted after the new Version is created.

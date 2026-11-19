# Building `Prisma.Compute` as a composite: what the Alchemy engine offers

Repository: `wip/alchemy` (shallow clone, HEAD `01792ec3`, so no git history was available). All paths are relative to that root. Read: `AGENTS.md` (Concepts, Reconciler doctrine, Provider Modes, Package Skills, PR and blog conventions), `.agents/skills/alchemy-provider/SKILL.md`, the core engine files listed in the brief, and the provider files cited below.

## Short answers

1. `Platform` is a wrapper around exactly one `Resource` type. It adds a runtime context, the class/tag declaration forms, the init Effect, and two hooks (`transformProps`, `onCreate`) that run while the resource is being declared and **may declare real child resources**. It does not bundle. Bundling is the provider's job.
2. Bindings are rows pushed onto `stack.bindings[hostFqn]` when `host.bind` runs. The planner resolves them and diffs them. Apply evaluates them right before `reconcile` and hands them only to the host provider's `diff`/`precreate`/`reconcile`/`delete`. No Output view of bindings exists. A provider can copy binding data into its Attributes, and one provider does. Any resource can be a bind target, not just a Platform. Prisma's own env bindings do not use `host.bind`. They flow through `RuntimeContext.set` into `Props.env`.
3. Composites are plain functions, or Platform hooks, that `yield*` children under `Namespace.push(id)`, so the children's FQNs are `<id>/<childId>`. There are many precedents: Cloudflare and AWS StaticSite, AWS FrameworkSite, AWS ECS Service ingress, Lambda Function domain, Cloudflare Worker SaaS domain, event sources that yield mappings, and Prisma bucket bindings that yield access keys.
4. Every Platform has its own provider. The closest thing to "a Platform that delegates" is effect-cluster's hosted platforms (Entity, Singleton). Their provider writes state only, and the actual deployment is done by child resources that receive the platform's env through `pool.bind`.
5. "Immutable version plus a live pointer" is modelled four ways in this repository. Lambda has separate `Version` and `Alias` resources; `Version` updates in place and defaults to `retain`. Cloudflare Worker uploads versions and deployments inside the Worker provider. Cloud Run handles revisions and traffic inside the Service provider. Prisma, API Gateway and Pages model a deployment as a resource that is replaced when its content changes. Only Lambda keeps old versions by design.
6. A `replace` diff is create-first unless the diff returns `deleteFirst: true`. The old generation is deleted in garbage collection after its dependents have been updated. `retain` skips the provider delete of the old generation but still drops the state row. An update diff may return `stables`, and the engine never checks that they really stayed stable.
7. The engine has three migration tools: type `aliases`, `renamedFrom` for a moved FQN of the same type, and `read` (adoption) with `Unowned`. It has no tool for "same FQN, different type": the new type's provider is silently handed the old type's row. There is no state-version upgrade hook. `providerVersion` is written to state but never read. The closest precedent for turning a monolith into a composite is ECS Service, which marks the new state shape and deletes the old inline infrastructure.
8. Scopes come from `Namespace.push(id)`. Decorations (`retain`, `protect`, `adopt`, `remote`, `renamedFrom`) are Effect context services. They are captured when a resource registers, so piping one onto a composite applies it to every child declared inside it.
9. Each child resolves its own provider mode. A dual-mode child goes local in dev, and a single-implementation (mode-agnostic) child stays live. The precedents put "run the app locally" in a dedicated `LocalProvider.make` resource (`Command.Dev`, `Website.Server`). The composite then chooses which children to declare by checking `AlchemyContext.dev` and `ProviderModePolicy`.
10. No written rule covers composites or deprecations. The written rules are: conventional-commit PR titles, a terse description with no test plan, the changelog generated from commit titles with breaking changes marked, JSDoc as the only reference-docs source, breaking changes in a `:::caution` callout in the beta blog post, and the gitignored `processes/` catalog.

---

## 1. What `Platform` is

**Signature.** `Platform` is a function of a resource type string, hooks, and optional static methods. It returns `any`, which is cast to the `Platform<...>` interface (`packages/alchemy/src/Platform.ts:252-290`):

```ts
export const Platform = <R extends ResourceLike<string, { env?: Record<string, any>; exports?: string[] | Record<string, any> } | undefined>>(
  type: R["Type"],
  hooks: {
    createRuntimeContext: (id: string) => BaseRuntimeContext;
    aliases?: string[];
    onCreate?: (resource: R, props: any) => Effect.Effect<void, never, any>;
    transformProps?: (id: string, props: any) => Effect.Effect<any, any, any>;
  },
  methods?: { [key: string]: any },
): any
```

**It is one Resource.** `Platform` declares a single resource class and nothing else (`Platform.ts:300-303`):

```ts
const resource = Resource(type, { aliases: hooks.aliases, requiresImplementation: true });
```

The final object merges the constructor, that `resource` class, and the methods (`Platform.ts:672-686`). So a Platform has exactly one Type, one provider (`Provider: Provider<Resource>`, `Platform.ts:153`) and one Binding contract.

**How it differs from `Resource`.** A `Platform` adds the following.

- **Declaration forms** (interface at `Platform.ts:144-250`; dispatch at `constructor`, `Platform.ts:319-449`):
  - The tag/class form: `class X extends P<X>()("id") {}` together with `X.make(props, impl)`, which returns a Layer (`Platform.ts:155-175, 200-217`).
  - The class-with-props form (`Platform.ts:176-198`).
  - The plain external form: `yield* P("id", props)` with no impl, which marks `isExternal: true` (`Platform.ts:327-343`).
  - The inline-impl form: `P("id", props, Effect.gen(...))` (`Platform.ts:437-447`).
- **The init Effect (`impl`).** It runs inside the Self layer, which is built in `makeClass().make` (`Platform.ts:463-659`). The sequence:
  1. Resolve the props, passing them through `transformProps` (`470-475`).
  2. Create the runtime context: `hooks.createRuntimeContext(id)` (`476`).
  3. Register the resource and run `onCreate` (`493-499`).
  4. Run `impl` with these services provided: `RuntimeContext`, `Self`, `Platform.Self`, an intercepting `ConfigProvider`, `ServerHost` when the context has `run`, and `planServices` during plan (`503-627`).
  5. If the impl returns a `fetch` handler or RPC methods, call `runtimeContext.serve(...)` (`514-532`).
- **Runtime env reaches the props.** Whatever the init recorded on the runtime context ends up in `Props.env` (`Platform.ts:630-637`):

  ```ts
  instance.Props = { ...props, env: { ...props?.env, ...runtimeContext.env },
    exports: runtimeContext.exports ? yield* runtimeContext.exports : undefined };
  ```

  A `Config` read during plan is bound into the runtime context through `ctx.set(key, Output.literal(Redacted.make(...)))` (`Platform.ts:550-554`). At runtime the same lookup reads `ctx.get` (`555-569`).
- **`createRuntimeContext`** is the per-platform object holding `env`, `set`, `get`, `serve`, `exports`, and `run`, `listen` or `hostServices` where they apply. Prisma's version is at `packages/prisma/src/Compute.ts:862-952`. Its `set` stores `env[KEY] = output.pipe(...)`, and its `exports` produces the runners entrypoint.
- **`host.bind`** is not Platform-specific. Every `Resource` instance has `bind` (`Resource.ts:228-232, 518-569`); see question 2.
- **Bundling of `main` is not done by `Platform`.** `Platform.ts` contains no bundler call. The provider bundles, for example the Prisma Compute live provider's `resolveArtifact(effectiveNews)` at `Compute.ts:2281` (bundling lives in `ComputeBuild.ts` and `ComputeArchive.ts`).
- **The two hooks may compose children.** The `onCreate` comment says: "the hook may yield child resources (e.g. an async Worker registering a `WorkflowResource`...)" (`Platform.ts:272-277`). The `transformProps` comment says: "the hook may compose REAL child resources (the `StaticSite` pattern) and return derived props that reference their Outputs. Implementations MUST be a no-op at runtime (guard on `globalThis.__ALCHEMY_RUNTIME__`)" (`Platform.ts:279-287`). `onCreate` runs only on the first registration of an FQN (`Platform.ts:388-418`, issue #2672).
- **`requiresImplementation: true`** makes `Plan.make` fail fast when a bare tag's `.make` Layer was never provided (`Resource.ts:284-297, 314-320`).

## 2. How binding data reaches the host provider

**Step 1: registration.** At declaration time a `Binding.Service` implementation calls ``host.bind`sid`(data)``. `bind` is a closure created in the `Resource` constructor. It appends to a stack-wide map keyed by the host's FQN (`Resource.ts:518-531`):

```ts
(stack.bindings[fqn] ??= []).push({ sid, data });
```

The template form turns its arguments into a sid string, using `LogicalId` or `id` for resources (`Resource.ts:532-569`). The host is found through `Binding.Host` (`Binding.ts:276-278`), which is `Self`. Implementations guard the call with `!globalThis.__ALCHEMY_RUNTIME__` (`AGENTS.md:28`).

**Step 2: dependency edges.** Bindings add upstream edges: `Output.upstreamAny(stack.bindings[resource.FQN] ?? [])` (`Plan.ts:1265`).

**Step 3: plan.** Each host's rows are resolved during that host's diff (`Plan.ts:1476-1484`):

```ts
const applyBindings = dedupeBindings(yield* resolveInput(stack.bindings[fqn] ?? []));
const newBindings = materializeStableRefs(applyBindings);
```

Then the rows are diffed against `oldState.bindings`, the rows persisted on the state row (`Plan.ts:1611-1622`). The provider's `diff` receives `oldBindings` and `newBindings` (`Plan.ts:1773-1785`). With no provider diff, any binding change alone produces `update` (`Plan.ts:1788-1796`).

**Step 4: apply.** Payloads that still hold Outputs are evaluated against upstream outputs right before reconcile (`Apply.ts:943, 1107`):

```ts
const bindingOutputs = excludeDeletedBindings(yield* Output.evaluate(node.bindings, outputs));
```

The provider receives them as `bindings` in `reconcile` (`Provider.ts:406-419`), and also in `precreate` and `delete` (`Provider.ts:372-383, 421-432`). The evaluated payload is persisted on the row.

**Is there an Output view of bindings?** No. Resource attribute access goes through `Output.PropExpr` over Attributes only (`Resource.ts:613-616`). Nothing exposes `stack.bindings` as an Output. Outside Plan and Apply, the only writer of `stack.bindings` is `Resource.ts:526` (searched with `stack.bindings|.bindings[` across `packages/alchemy/src`).

The only route is for the host provider to copy binding data into its Attributes. Precedent: effect-cluster's hosted platform reconcile returns `pool` from its bindings (`packages/effect-cluster/src/internal/HostedPlatform.ts:57-63`):

```ts
reconcile: ({ bindings }) => Effect.sync(() => { const attrs = { pool: undefined };
  for (const { data } of bindings) attrs.pool = data.pool ?? attrs.pool; return attrs; }),
```

**Can the target be something other than a Platform?** Yes. Any resource can be a target, because `bind` is on every `Resource`. Precedents:

- `Fly.App`, a plain `Resource` (`packages/fly/src/App.ts:226`), receives `app.bind(id, {...})` from the `Fly.Service` `transformProps` hook (`packages/fly/src/Service.ts:1094-1100`).
- `ApiGateway.RestApi` derives the deployment's dependency list from Method bindings (`packages/aws/src/ApiGateway/Deployment.ts`, JSDoc "Why no DependsOn?").
- effect-cluster binds onto a `Pool` and onto `database.shardGroups` (`packages/effect-cluster/src/internal/PoolHost.ts:179-188`).

A bind always targets one resource FQN. No group or namespace target exists.

**Prisma specifically.** Prisma bindings do not use `host.bind`. `Prisma.Connect` uses `output.bind(key)` under the host's `RuntimeContext` (`packages/prisma/src/Connect.ts:285-289`). `BaseExpr.bind` calls `ctx.set(key, this)` (`packages/alchemy/src/Output.ts:139-145`), Compute's `set` writes `env[KEY]` (`Compute.ts:892-911`), and Platform folds that into `Props.env` (`Platform.ts:630-635`). Compute's `bindings` argument (`{ env }`, `Compute.ts:657-659`) is merged by `activeBindingEnv` (`Compute.ts:2161-2173, 2270-2278`), but nothing in the repository was found that calls `host.bind` on a Compute.

The engine compares this captured env itself, so a changed value always deploys (`Plan.ts:1798-1805`, issue #1831). Consequence for the refactor: binding env is already ordinary props on the Platform resource (`news.env`). A composite can read it from the resource's props or from the runtime context and pass it as props to `EnvironmentVariable` children. It would not use the `bindings` channel.

## 3. Composite precedents

| Precedent | Where | Child naming | Outputs exposed | Bindings | Notes |
| --- | --- | --- | --- | --- | --- |
| `Cloudflare.Website.StaticSite` (plain function) | `packages/cloudflare/src/Website/StaticSite.ts:289-370` | `Command.Dev("Dev")` and `Command.Build("Build")` under `Namespace.push(id)`, so `<id>/Dev` and `<id>/Build`. The Worker stays at `id` in the caller's namespace (`299-305`). | The function **returns the Worker itself** (`346`), so the user's handle is the Platform resource. | Bindings go to the Worker, which is the returned host. | Moved the Worker from `<id>/Worker` to `<id>` with `renamedFrom` (`341-345, 369`). In dev it declares `Command.Dev` instead of `Build` and gives the Worker `dev: { mode: "external" }` (`307-325, 359-367`). |
| `Cloudflare.Website.Vite` | same directory | "`Vite` already passes `id` straight through to `Worker`" (`StaticSite.ts:305`) | returns the Worker | Worker | |
| `AWS.Website.StaticSite` (plain function) | `packages/aws/src/Website/StaticSite.ts:269-306` | `Bucket("Bucket")`, `AssetDeployment("Files")`, `Distribution("Distribution")`, `Invalidation(...)`, `KvEntries`, `Command.Dev("Dev")` in dev, all under `.pipe(Namespace.push(id))` (`306`). | **A record of children** `{ bucket, build, files, distribution, invalidation, kvNamespace, url, urls }` (`805-825`). | none | |
| `AWS.Website.<Framework>` (`makeFrameworkSite`) | `packages/aws/src/Website/FrameworkSite.ts:251-420` | `Server("Build")`, `LambdaFunction("Server")` or `WebFunction("WebServer")`, plus the StaticSite children. "Callers pipe `Namespace.push(id)` themselves... so resource FQNs are identical to the previous per-framework implementations" (`260-262`). | a record that includes `server` and `url` | user `env` is passed as **props** to the inner Lambda (`env: props.env`) | In dev it declares no cloud resources (`isLocal` at `278-279`, early return around `305-318`). |
| `AWS.ECS.Service` (Platform with hooks) | `packages/aws/src/ECS/Service.ts:1393-1411, 1702-1745` | `transformProps` composes Cloud Map, ELBv2 LB/TG/listener and SG children under `Namespace.push(id)` (`1741`), then rewrites props to reference their Outputs. `onCreate` composes autoscaling after the resource exists (`1402-1410`). | Child outputs flow in through rewritten props, and the Service's own Attributes carry `loadBalancerArn`, `listenerArn` and `ingressKind` (`895-910`). | stay on the Service | Typed errors raised inside the hook (`MixedListenerOwnership`, `1766-1772`) "surface through the deploy like any resource-construction error" (`1407-1408`). Composition is guarded: "Composition is a plan/deploy concern — never runs inside bundles" (`1707`). |
| `AWS.Lambda.Function` domain | `packages/aws/src/Lambda/Function.ts:1428-1431`; `FunctionDomain.ts:112-204` | `onCreate` declares `HttpApi("Api")`, `Certificate`, `DomainName-<host>`, `ApiMapping-<host>` and DNS alias records under `Namespace.push(id)` (`FunctionDomain.ts:204`). | children are referenced by Outputs of the Function (`qualifiedArnOf(fn)`) | | Skipped in local mode: `if ((fn.Mode ?? (yield* defaultProviderMode)) === "local") return;` (`FunctionDomain.ts:142`). The IAM Role and the function URL are **not** child resources. The Function provider creates them inline (`Function.ts:1711-1770`, `createRoleIfNotExists`). |
| `Cloudflare.Worker` SaaS domain and async bindings | `packages/cloudflare/src/Workers/Worker.ts:3058-3077`; `WorkerDomainDns.ts:17-18, 117, 165`; `WorkerAsyncBindings.ts:121-129` | `CustomHostname-<key>` and similar under `Namespace.push(id)`; Access `Application("Access")` under `Namespace.push(resource.LogicalId)`. | | | "Composition happens in the Worker's `transformProps` hook, at construct time: the WorkerProvider never sees `domain.dns`." |
| Event sources that yield mappings | `packages/aws/src/Lambda/QueueEventSource.ts:36-62` | `Mapping(\`${queue.LogicalId}-EventSource\`)` under `Namespace.push(host.LogicalId)`, so `<host>/<queue>-EventSource`. | | the same code also calls `host.bind` for IAM | "Namespaced under the host so the mapping's logical identity matches the previous Binding.Policy" (`38-39`). This preserved an identity across a refactor by choosing the namespace. |
| Prisma bucket bindings | `packages/prisma/src/BucketBinding.ts:14-28` | `<bucket>{Read,Write,ReadWrite}BucketAccessKey`, derived without the host so that the runtime and deploy halves agree. | | | |
| effect-cluster pool hosting | `packages/effect-cluster/src/internal/PoolHost.ts:162-200` | `Pool(options.id)`, `Random(\`${options.id}GatewayToken\`)`, then `options.nodes(...)` (host compute) | `resource.bind\`Pool\`(...)` reflects pool info back onto the entity | the entity's runtime env is forwarded by `pool.bind\`${hosted.name}\`({ entities, env })` | see question 4 |

**Child failure handling.** No composite handles a child failure itself. The engine runs every node concurrently, collects lifecycle failures, and fails the apply with the combined cause (`Apply.ts:529-571`). Garbage collection of old generations runs only after `executePlan` succeeds (`Apply.ts:355-371`). There is no rollback: `// TODO(sam): support roll back to previous state if errors occur during expansion` (`Apply.ts:366`). Siblings that do not depend on the failed child converge. Dependents fail through their failed `Deferred` (`Apply.ts:1510-1511`).

**Searches.** Searching for `Construct`, `Component(`, `Composite`, `Group` turned up no engine abstraction. The word "composite" is used informally ("Website composites", `SKILL.md:770`; "Compute is a composite over App + Deployment", `Compute.ts:2181`, which describes API usage, not graph nodes).

## 4. A Platform that delegates to child resources

No Platform in the repository lacks a provider of its own. `Platform()` always declares one resource with a provider (`Platform.ts:300`). Every hit for `Platform(` in `packages/*/src` (about 50 files) was checked against the `transformProps`/`onCreate` list.

The closest case is **effect-cluster's hosted platforms** (`Entity`, `Singleton`, `Cron`; `packages/effect-cluster/src/internal/HostedPlatform.ts:38-65`).

- The provider writes state only. `reconcile` derives `{ pool }` from bindings, and `delete` is `Effect.void`.
- The runtime context's `serve` hook, which runs during the Platform init at plan time, calls `deploy(base.env)` (`internal/HostedRuntime.ts:85-115`). That declares the child resources that actually run the code: `Pool`, a gateway token `Random`, and the host nodes, which are other Platforms such as Lambda or Worker.
- The child resources receive the entity's captured runtime env through `pool.bind` (`PoolHost.ts:172-200`).

So the user-facing Platform keeps the runtime, the init Effect and the env capture, while the cloud work happens in children.

The next closest cases are ECS Service and Cloudflare Worker (question 3). There, the Platform keeps its own real provider and the hooks add children around it.

## 5. "Immutable version plus a pointer to the live one" in this repository

| Cloud | Model | Old versions kept? |
| --- | --- | --- |
| **Lambda, inline** | `alias` prop on `AWS.Lambda.Function`. Reconcile publishes a version and points the alias at it (`Function.ts:2633-2712`; doc `234-249`: "rolling back is a single `UpdateAlias` call to a previous version. Published versions are retained."). | Yes |
| **Lambda, separate resources** | `AWS.Lambda.Version` (`packages/aws/src/Lambda/Version.ts:94-96, 151-164`) plus `AWS.Lambda.Alias` (`Alias.ts:168`). A code or config change to `Version` is an **update**, not a replace (`Version.ts:388-397`); only a function-name change replaces (`380-384`). Each update publishes a new number, and the previous number is no longer tracked but stays in AWS. The Alias diff replaces only on function or name change (`Alias.ts:226-240`); otherwise it updates the pointer in place. | Yes, explicitly: `defaultRemovalPolicy: "retain"` (`Version.ts:94-96`), and the JSDoc says "Moving or deleting an alias never deletes an older version" (`Version.ts:111-114`). |
| **Cloudflare Worker** | Inside the one Worker resource. The `version: { parent, traffic, alias, affinity }` prop (`Worker.ts:418-512, 608-615`). The provider calls `createScriptVersion` and then `createScriptDeployment` with a percentage split (`WorkerProvider.ts:2527-2572, 2820-2880`). A Worker with `version.parent` is a separate resource that uploads into another script; changing the parent replaces it. | Versions remain uploaded on Cloudflare. Alchemy does not track them. |
| **Cloud Run** | One `GCP.Run.Service`. Template changes create a new revision as an in-place update, and `traffic?: TrafficTarget[]` is a prop (`packages/gcp/src/Run/Service.ts:234-241, 313-322, 466-469`). | Cloud Run keeps revisions; Alchemy does not model them. |
| **Fly** | In-place inside `Fly.Service`. `deploy.strategy: "rolling" \| "bluegreen"` replaces Machines within reconcile (`packages/fly/src/Deployment.ts:1-7`, which is a policy helper, not a resource). There is no release resource. | No |
| **Prisma.Deployment** | Separate resource. Artifact, port or trigger changes **replace** it (`Deployment.ts:510-542`); start and promote changes update it (`543-560`). A failed status replaces "instead of trying to restart the failed generation or changing a stable ID during an update" (`500-506`). Delete destroys the deployment (`746-766`). | No: the default removal policy is destroy (`Deployment.ts:237`), so garbage collection destroys the superseded generation. |
| **API Gateway Deployment** | Replaced on changes; the Stage points at it (`packages/aws/src/ApiGateway/Deployment.ts:148, 266-283`). | No |
| **Cloudflare Pages Deployment** | "Deployments are immutable — every prop change triggers a replacement" (`packages/cloudflare/src/Pages/Deployment.ts:94-97`). Delete tolerates the active production deployment (`108-111`). | No |
| **App Engine Version** | Replaced with `deleteFirst: false` (`packages/gcp/src/AppEngine/AppsServicesVersion.ts:310-342`). | No |
| **Prisma.Compute today** | Inline. `destroyOldDeployment` defaults to false (`Compute.ts:517-522`), so the previous deployment is stopped, not destroyed. This is tracked in `previousDeploymentId` and `previousDeploymentAction` (`Compute.ts:611-618`). | The platform keeps it. |

Only Lambda `Version` keeps old versions so that a platform-side rollback works, by defaulting to `retain` and **updating** in place rather than replacing. A Prisma.Deployment modelled on it would need either the update-in-place form or `defaultRemovalPolicy: "retain"`. Today Prisma.Deployment replaces and destroys.

## 6. Replacement lifecycle

**Diff shapes** (`packages/alchemy/src/Diff.ts:11-36`):

```ts
export interface NoopDiff { action: "noop"; stables?: string[] }
export interface UpdateDiff { action: "update"; stables?: string[] }
export interface ReplaceDiff { action: "replace"; deleteFirst?: boolean; stables?: undefined }
```

**Ordering.** The default is create-first. The comment at `Apply.ts:1229-1243` says:

> "By default a replacement is create-first: the new generation is created here and the old generation(s) are reclaimed afterwards by `collectGarbage` (Phase 2)... Those providers return `{ action: "replace", deleteFirst: true }`. When `deleteFirst` is set we tear the previous generation(s) down BEFORE creating the new one, and commit the result as a terminal `created` state"

The planner copies `deleteFirst: diff?.deleteFirst ?? false` onto the node (`Plan.ts:1974-1980`). The user-facing doc gives the steps "Creates a new resource... Updates downstream resources... Deletes the old resource" (`website/src/content/docs/infrastructure-as-code/resource-lifecycle.mdx:82-93`). Interrupted states map back onto create, update or replace (`Plan.ts:1834-1965`). A provider-mode switch is always `replace` with `deleteFirst: false` (`Plan.ts:1764-1772`).

**Retain.** On a delete-first replacement, `deleteOldGenerations` skips the provider delete when the resource's policy is `retain` (`Apply.ts:1247-1249`). On a create-first replacement, garbage collection honours `retain` for the old generation (`Apply.ts:2231-2239`): "Retaining replaced resource (removal policy: retain)...". Orphans whose row says `retain` plan as `orphaned` instead of `delete` (`Plan.ts:2415`). Retain means: skip the provider's `delete`, and still drop the state row (`RemovalPolicy.ts:13-14`). `protect` fails the plan on replace or delete (`RemovalPolicy.ts:110-157`). The policy is read from the persisted row and is re-committed on a noop deploy (`Apply.ts:733-761`).

**Stables.** "A present `diff.stables` is authoritative for this update and overrides `provider.stables`" (`Plan.ts:901-905`). Stables exist so that downstream diffs see known values during the plan (`Plan.ts:907-932`). The engine does not check that a stable attribute stayed the same after an update: a search for `stable` in `Apply.ts` finds only readiness signals (`Apply.ts:444-521`). The convention is self-imposed. Prisma.Deployment replaces rather than "changing a stable ID during an update" (`Deployment.ts:500-503`), and a diff-time unresolved input falls back to `update` only when it is safe (`Version.ts:386-388`).

## 7. State migration

| Mechanism | What it does | Where |
| --- | --- | --- |
| Type aliases | `Resource<...>(type, { aliases: ["Old.Type"] })`, or `Platform(type, { aliases })`. Provider lookup falls back from the legacy name, and "The state row migrates to the new type on its next write". About 20 Cloudflare resources use it (for example `KV/Namespace.ts:120`). | `Resource.ts:267-283`, `Platform.ts:265-271`, `Provider.ts:128-135, 865-876` |
| `renamedFrom(...ids)` | Moves a row from a former FQN to the new FQN **only when the type matches modulo aliases**. A row at the new FQN with a different type is fatal; a former row with a different type is never migrated. | `Rename.ts:26-134`, `Plan.ts:674-765`, `website/.../renaming.mdx:93-176` |
| `read` returning attrs or `Unowned(attrs)` | Adoption when no row exists. `Unowned` requires `--adopt` or `adopt(true)`. | `Plan.ts:1494-1607`, `AdoptPolicy.ts:110-214` |
| `Resource.lookup(props)` | Read-only reference; never writes state. | `Resource.ts:86-101, 390-419` |
| `alchemy state delete` (`rm`) | "Delete state records without deleting cloud resources" (manual). | `packages/alchemy/src/Cli/commands/state.ts:177-200` |
| `alchemy state migrate` | Moves state between state-store backends, not between shapes. | `state.ts:354-375` |
| `providerVersion` | Written on every commit (`Apply.ts:809, 834, ...`) and never read. A search for readers of `providerVersion` found none. No upgrade hook exists. | `Provider.ts:122-127` |

**Same logical ID, different type.** The engine does not check this. `getPersistedRow` returns whatever row sits at the FQN (`Plan.ts:809-828`), and `diffResource` hands it to the new type's provider as `olds` and `output` (`Plan.ts:1491-1492, 1773-1785`). Apply then rewrites the row's `resourceType`. The only type guards are in the rename path (`Plan.ts:705, 716, 733, 748-757`) and in duplicate in-program declarations (`DuplicateLogicalIdError`, `Resource.ts:476-490`). A search of `src` and `test` for "type change", "changed type" and "different type" found only the rename error.

**Removing an FQN's declaration** plans an orphan delete using the old row's type and stamped mode (`Plan.ts:2370-2430`). If the type has no registered provider, the plan dies (`2381-2399`). So if `Prisma.Compute` rows disappear while the Compute provider is still registered, the engine calls Compute's `delete`, which runs `destroyApp(output.appId)` (`Compute.ts:2764`), unless the row was first redeployed with `retain`.

**Shape-change precedents in providers**:

- **ECS Service, inline ingress to composed children.** This is the direct analogue. A new attribute `ingressKind` marks rows of the new shape: "Absent on legacy state rows whose ALB/TG/listener were created inline... the marker gates the migration reap and the legacy delete path" (`packages/aws/src/ECS/Service.ts:904-910`). On the first reconcile under the new shape, `reapLegacyIngress` **deletes** the legacy inline resources (`Service.ts:2913-2958`, note "Migrating to composed load balancer resources — deleting the legacy inline ALB/TG/listener"). Delete tears down legacy inline ingress only for unmarked rows (`3712-3758`). The old infrastructure was destroyed and recreated, not adopted, and the change shipped as a "breaking redeploy" (`2919`).
- **DynamoDB Table** accepts a legacy wire shape in `olds` "so upgrading alchemy never plans a spurious table replacement" (`packages/aws/src/DynamoDB/Table.ts:599-604`).
- **Logpush Job and ObservabilityDestination**: "State written by earlier versions holds `destinationConf` as a plain string. Reconcile to re-read it as `Redacted`" (`packages/cloudflare/src/Logpush/Job.ts:310-315`).
- **ECS Task** sweeps revisions for "state rows written before reconcile-time revision reaping" (`packages/aws/src/ECS/Task.ts:1003-1006`).
- **Lambda event sources** preserved logical identity across a refactor by namespacing (`QueueEventSource.ts:38-39`).
- **Cloudflare StaticSite** used `renamedFrom` for an FQN move of the same type (`StaticSite.ts:341-345`).
- **Prisma App** has a `logicalId` prop that defaults to the FQN and is used to find the App after lost state (`packages/prisma/src/App.ts:77-85, 365-397`). A child declared at a new FQN would not match an App stamped with the old FQN unless `logicalId` is passed explicitly.

## 8. Scopes and naming

`Namespace.push(id)` provides a `Namespace` service whose parent is the current one (`packages/alchemy/src/Namespace.ts:12-30`). `toFqn` joins the path with `/` (`FQN.ts:50-54`); state files encode `/` as `__` (`FQN.ts:12`). A resource reads `CurrentNamespace` when it registers (`Resource.ts:465-466`). The convention, from every precedent in question 3, is that children of `api` become `api/<ChildId>` while the host keeps `api`.

Decorations are Effect context services captured at registration:

- `RemovalPolicy`: `Resource.ts:578-580`.
- `AdoptPolicy`: `Resource.ts:581`.
- `ProviderModePolicy` (`remote()`): `Resource.ts:472-473, 582`.
- `RenamePolicy`: `Resource.ts:588-598`.

So piping a decoration onto a composite Effect reaches every child registered inside it. `RemovalPolicy.ts:40, 121` says so: "Applies to every resource declared inside the piped effect, so it can decorate a single resource or a whole scope." `ProviderMode.ts:120-130` says the same for `remote()`. `adopt` is the same mechanism (`AdoptPolicy.ts:203-214`).

One caveat: `renamedFrom` on a whole scope would give every child the same former ids, which fails as "two resources claiming the same former FQN" (`Rename.ts:129`). Apply it per child. Conflicting `remote()` decorations on one FQN die with `ConflictingProviderModeError` (`Resource.ts:498-514`).

## 9. Dev mode for a composite

- **Each resource resolves its mode on its own.** A provider with `modes` uses `resource.Mode ?? runDefaultMode`, and a mode-agnostic provider gets `undefined` (`Plan.ts:542-557`). A dual child in dev therefore goes local. A single-implementation child "satisf[ies] any requested mode, never stamp[s], never replace[s] on a switch" (`AGENTS.md:974`).
- **`ProviderLayer.dual(cls, { live, local, dataPlane?, liveDataPlane? })`** registers both variants lazily, and mode-specific dependency layers must compose inside the `local` thunk (`packages/alchemy/src/Local/ProviderLayer.ts:1-110`, `AGENTS.md:972`). Switching a stamped row's mode plans a replacement, and the old generation is deleted by the provider of its stamped mode (`AGENTS.md:973`, `Apply.ts:1250-1256`).
- **`LocalProvider.make(cls, providersUrl, spec)`** is required "whose physical resource is a running process". The spec is `resolveConfig`, `start` and `stop`, and the helper generates the instance registry, the locks, the config-hash noop/restart logic and the sidecar RPC (`AGENTS.md:976-986`; `Local/LocalProvider.ts:258-290`). Reference uses: `Command.Dev` (`packages/alchemy/src/Command/Dev.ts:148-170`), `Website.Server` (`packages/alchemy/src/Website/Server.ts:280, 483-485`), the Cloudflare `LocalWorkerProvider`, and Neon `LocalFunctionProvider`.
- **Today's Prisma code.** `ComputeDevProvider` keeps its own `devProcesses` Map (`Compute.ts:957`, `startDev` at `2116`) and is registered with `dual` (`Compute.ts:2833-2837`). That does not follow the `LocalProvider.make` rule. `App`, `Deployment` and `EnvironmentVariable` already have stub local providers (`packages/prisma/src/internal/DevStub.ts:49-72`; registered at `App.ts:520`, `Deployment.ts:783-788`, `EnvironmentVariable.ts:476`). In dev they create nothing on Prisma and return `dev:` ids.
- **Where "run the app locally" goes in a composite, by precedent.** The monolith's local behaviour moves into one resource built with `LocalProvider.make`, either a dedicated one like `Command.Dev`, or the host Platform's own local variant. The composite then picks children by mode:
  - Cloudflare StaticSite: `ctx.dev && devCommand ? Command.Dev(...) : Command.Build(...)` (`StaticSite.ts:310-335`).
  - AWS FrameworkSite: `const remoted = yield* ProviderModePolicy; const isLocal = ctx.dev && remoted !== true;`, then it declares only the dev server (`FrameworkSite.ts:278-318`).
  - Lambda domain: it checks `fn.Mode ?? defaultProviderMode` (`FunctionDomain.ts:142`).

  If the composite keeps the Platform resource as the host, that resource's local variant can keep running the process, and the cloud children (App, Deployment, environment variables) either fall to their stubs or are not declared in dev.

## 10. Written conventions relevant to this refactor

- **Composites.** There is no written rule. The informal pattern comes from the code (questions 3 and 8) and from `SKILL.md:770` ("`<Provider>.Website.<Framework>` composites").
- **Breaking changes and renames.** "Fix public names now; renaming after release is a breaking change." (`SKILL.md:294`). Type renames use `aliases` (`Resource.ts:267-283`). FQN moves use `renamedFrom` (docs at `website/src/content/docs/infrastructure-as-code/renaming.mdx`).
- **Deprecation.** No rule was found in `AGENTS.md` or the skill. The only mentions are about deprecated cloud APIs being out of scope (`AGENTS.md:131, 167`; `SKILL.md:265, 290`).
- **PRs** (`AGENTS.md:1365-1425`):
  - Conventional-commit title.
  - No `#` or `##` headings; summary first with no heading.
  - Prefer code snippets; be succinct.
  - Never include a test plan or a TODO checklist.
  - Outstanding work means a draft PR, with the user told in chat.
  - Pass the body with `--body-file`.
- **PR size.** The only guidance is the provider skill's checkpoint rule: draft PRs pushed at wave boundaries, rebased and type-checked (`SKILL.md:126-153`).
- **Changelog.** `CHANGELOG.md` is generated by changelogen from commit titles at release (`.github/workflows/release.yml:114`, `scripts/release/`). Breaking changes appear under "🚨 Breaking Changes" (`CHANGELOG.md:3-20`), so the PR title should carry the `!` marker.
- **Docs.** JSDoc is the only API reference source, generated by `pnpm docs:gen` into `website/src/content/docs/providers/...`, which must not be edited by hand (`AGENTS.md:67-68, 184+`). The Prisma hub lives at `website/src/content/docs/prisma/` (folders `compute/`, `guides/`, `tutorial/`). The JSDoc bar is in `SKILL.md:890-896`.
- **Blog and release notes.** `website/src/content/docs/blog/YYYY-MM-DD-beta-NN.md`, with breaking changes "in a `:::caution` callout at the top" (`AGENTS.md:1426-1452`).
- **Catalog.** `processes/<Provider>/catalog/<service>.md` and `INDEX.md` are a local, gitignored order book (`SKILL.md:246-282`, `AGENTS.md:128`).
- **Tests.** A resource with a local provider needs `{Resource}.local.test.ts`, covering the local roundtrip and the `Alchemy.remote()` opt-out (`AGENTS.md:990-999`).

# C1 spec review — principal engineer

Reviewed: `spec.md` and `plan.md` in this folder, at commit 1c409bcd. Read: `CLAUDE.md`; the rules `no-bare-casts`, `test-import-patterns`, `exports-entrypoints`; ADR-0062, ADR-0060 (with their amendment notes), ADR-0042, ADR-0044, ADR-0013's amendment note; `core-model.md`'s Load and lowering sections; every file the spec changes, in full; the callers of `Load`, `lowering`, `lower`, `resource`, `ResourceNodeBase`, `serviceInputs`, `boundaryPortsOf`, `runPipeline` and `LowerOptions` across the repo. Probes were compiled with the repo's TypeScript 6.0.3 under `tsconfig.base.json`, against a copy of `core/src` patched to the spec's types. Naming and typology are left to the architect review.

## Summary

The design is sound in its shape: the second pass belongs in Load, the value types compile and behave as claimed, and a resource with slots flows through ordering, wiring checks and the topology without changes there. But four pinned mechanisms fail as written: the resource copy throws a `TypeError` on every frozen node, nested modules' `provision` cannot be sealed by the described return-value plumbing, a value inside a non-plain object escapes substitution, and an error thrown by `fn` reaches the user as a Composer bug.

## What looks solid

- **The second pass in Load, not in lowering.** The CLI's preflight, registry coverage and topology submission all read the parent's graph (`pipeline.ts:176`, `execute-deploy-destroy.ts` preflight loop). Resolving in lowering would leave them checking unresolved bindings. The choice is right.
- **The value types.** The probe confirms every claim in § 3.2 and § 4: `fn` receives `readonly [string]` for `[environment.name]` and `readonly [string, number]` for two dependencies; destructuring a second member of a one-member tuple fails to compile; `Value<number>` is refused where `Value<string>` is wanted, on both the environment branch and the computed branch; `Value<string>` is accepted as `Value<unknown>`; `Value<InputBinding>` inside the recursive alias compiles; `{ when: Value<Date> }` is refused as an `InputBinding`; a `Value<number>` is refused for a string param and accepted for a number param; `ModuleContext['environment']['name']` is `Value<string>`.
- **Ordering of a resource after its producer.** The producer → resource `dependency` edge makes `topoSort` place the resource after the service, and `lowering()`'s main loop sets `lowered` for the service (after `deploy` or `reserve`) before it reaches the resource. The hoisted `provision()` loop touches services only and does not affect this.
- **Downstream readers tolerate a resource with slots.** `composeApplicationTopology` maps ports and authored edges generically; `env-key-clash.ts` and `preflight-names.ts` read service input bindings and `graph.params` only; `isPostgresResourceNode` is structural and survives a copy.
- **Rejecting `stage`.** Nothing reads `LowerOptions.stage` (`generate-stack.ts:15` already says so). The Alchemy stage is not the environment name when a state container pins it (`execute-deploy-destroy.ts:495`), so threading `environment` explicitly instead of reading Alchemy's stage is the right call.
- **Memoising values by identity**, and the cycle check that turns a stack overflow into a named error.

## Findings

### F01. The resolved resource copy throws `TypeError` on every frozen node

- **Location:** spec § 6.4, last bullet; § 13 decision 8.
- **Issue:** The authored node is frozen, so `Object.getOwnPropertyDescriptors(node)` returns `options` as non-writable and non-configurable. `defineProperties` copies that, and the next line, `copy.options = resolvedOptions`, throws in strict mode. Every resource with a value in its options fails Load, which is the whole public URL case. Test 31 would fail and the implementer would stop. Run under Node: `TypeError: Cannot assign to read only property 'options' of object '#<Leaf>'`. A second hazard: a subclass of `ResourceNodeBase` with `#private` fields loses them on the copy, and its methods then throw `Cannot read private member`. Separately, replacing the `byId` entry is dead work: nothing reads `byId` after `evaluateValues`.
- **Suggestion:** Replace the copy line in § 6.4 with:

  ```ts
  const copy = Object.freeze(
    Object.create(Object.getPrototypeOf(node), {
      ...Object.getOwnPropertyDescriptors(node),
      options: { value: Object.freeze(resolvedOptions), enumerable: true, writable: false, configurable: false },
    }),
  );
  ```

  Delete "and the `byId` entry". Add to § 6.3: "A class built on `ResourceNodeBase` must not use `#private` fields: Load copies a node whose options hold a value, and a copy carries own properties only." Make test 31's class call `freezeNode(this)` in its constructor, as `PostgresResourceNode` does, so the test exercises the frozen case.

### F02. An error thrown by `fn` reaches the user as a Composer bug

- **Location:** spec § 5.2, "An exception thrown by `fn` propagates out of `Load` unchanged"; test 15.
- **Issue:** ADR-0044 says a foreign error is "wrapped exactly once — at the site that understands it, into a structured error carrying the original as `cause`" (line 35), and a non-structured error reaching the process boundary "is by definition a bug: the CLI prints `Error: <message>` plus a report hint" (line 52). `runPipeline`'s callers rethrow anything that is not a `CliStructuredError` (`execute-deploy-destroy.ts:362-366` and the catch around `runPipeline`). Throwing is the obvious way for an author to say "this environment has no URL" (ADR-0062: fail rather than pick a default), so this path will be hit on purpose, and it will tell the user to report a Composer bug. `evaluateValues` is the one site that knows which binding the throwing `fn` serves. (A module body that throws has the same problem today; this slice adds a second site and pins the wrong behavior for it.)
- **Suggestion:** Give `LoadError` an optional cause: `constructor(message: string, options?: { readonly cause?: unknown })`, passing it to `CliStructuredError`. In § 5.2 replace the sentence with: "An exception thrown by `fn` is wrapped once in a `LoadError` whose `cause` is the thrown value, with the message `The resolve() function for <site> threw: <the thrown error's message>.`" Add that row to the § 5.3 table. Exception: a `LoadError` thrown from inside `fn`, which is the sealed `provision` error, propagates as is. Rewrite test 15 to assert the wrapper's message and that `error.cause` is the author's error instance.

### F03. Sealing cannot reach nested modules' `provision` as described

- **Location:** spec § 5.4.
- **Issue:** `loadModule` receives only the root `flatten`'s return value (`load-module.ts:809-823`). A nested `flatten` is called from inside the parent's `provision` closure (`load-module.ts:660-674`), and its return value goes into `brandedOutputs`. So "`flatten` returns a `seal()`, and `loadModule` keeps every `seal`" needs a shared array threaded through every `flatten` call, which the spec does not say. As written, the root's `fn` can call a `provision` that a nested module leaked to it, and a nested `fn` can call its own `provision`, and neither is sealed. Test 18 would catch the second case, but the spec gives the implementer no correct way to pass it.
- **Suggestion:** Replace § 5.4 with: "`loadModule` creates `const loading = { sealed: false };` and passes it to `flatten` as a new last parameter, which every recursive `flatten` call forwards. The first statement of the `provision` closure is `if (loading.sealed) throw new LoadError(<the provision-after-load message>)`. `loadModule` sets `loading.sealed = true` after `assertDependencyDag(edges)` and before `evaluateValues`." One flag, one write. `flatten`'s return type does not change. Add a test: a nested module's body hands its `ctx.provision` to the root through a closure, and a root-level `fn` calls it; Load throws the sealed message naming the nested module.

### F04. A value inside a non-plain object is found by the walk but not substituted

- **Location:** spec § 5.2 steps 1 and 3.
- **Issue:** Step 1 says the walk uses "the same walker `deepValues` already uses", and also says "plain objects by key". `deepValues` (`load-module.ts:223-231`) descends into every object, including class instances and `Date`. Step 3 rebuilds only plain objects and arrays and keeps "everything else by reference". A value inside a non-plain object is therefore collected, evaluated, and left in the graph unsubstituted. The Prisma Cloud serializer treats a value as a plain object (it is an object literal), so an unsubstituted `environment.name` serializes silently as `{"origin":{"kind":"environment","fact":"name"}}` (`serializer.ts:504`), and only the service's schema stands between that and a deploy.
- **Suggestion:** Pin one predicate and use it for the walk, the substitution and the result check in F05: "A plain object is one whose prototype is `Object.prototype` or `null`. The walk descends into arrays and plain objects only. It stops at a `Value`, a `SecretSource` and a `ParamSource`, and does not descend into any other object." Do not reuse `deepValues`: write `collectValues` in `evaluate-values.ts` with that predicate. A value inside a non-plain object then stays where it is, and the serializer rejects the non-plain object loudly, as it does today.

### F05. The check on `fn`'s result is too narrow

- **Location:** spec § 5.2 step 2 ("check result"), § 5.3 rows for `undefined`, a `Value` and a `Promise`.
- **Issue:** Three gaps.
  1. `Value<InputBinding>` admits `SecretSource` and `ParamSource`, so `resolve([environment.name], ([n]) => envSecret(n === 'production' ? 'PROD_KEY' : 'DEV_KEY'))` type-checks and deploys. That fixes a meaning for "a resolve() function that returns a source", which § 2 and § 10 say this slice does not decide and the module-input project will redesign. Worse, returning a forwarded `ctx.secrets` ref from `fn` fails with "declares secret but never forwards it", because usage is marked at `provision()` time (`load-module.ts:599-602`), before `fn` runs. The author did forward it, so the message is wrong.
  2. A function, a class instance, a symbol or a `bigint` is accepted and fails later: in the serializer at preflight for an input binding, or in `buildConfig` inside the Alchemy child for a param. That is after `connect` has created the Project and Branch.
  3. `undefined` is checked at the top only. `{ a: undefined }` passes, and JSON drops the key without a word.
- **Suggestion:** Replace the three checks with one, run on every `fn` result using the F04 predicate: "The result must be plain data: a string, a finite number, a boolean, `null`, an array of plain data, or a plain object whose values are plain data. A `SecretSource` or `ParamSource` anywhere in the result is refused with its own message." Messages for § 5.3:
  - `The resolve() function for <site> returned undefined<at path>. A value that does not exist for this environment must be expressed in the schema, not left undefined.`
  - `The resolve() function for <site> returned a value instead of a plain result<at path>. List that value as a dependency and return its real value.`
  - `The resolve() function for <site> returned a Promise. resolve() runs synchronously at Load.`
  - `The resolve() function for <site> returned a secret or param source<at path>. Bind envSecret() or envParam() directly; resolve() computes plain values.`
  - `The resolve() function for <site> returned <a function | a class instance | a symbol | a bigint><at path>. resolve() returns plain data: strings, numbers, booleans, null, arrays and plain objects.`

  Here `<at path>` is empty at the root and ` at "hosts.0"` inside. Recognise a Promise as an object with a callable `then`. Narrow the types to match: add `export type PlainValue = string | number | boolean | null | readonly PlainValue[] | { readonly [key: string]: PlainValue };`, and use `Value<PlainValue>` in `InputBinding` and in `ResourceOption` in place of `Value<InputBinding>` and `Value<ResourceOption>`. Note for P1: `publicUrl.prismaBuild()` must return plain data to pass this check.

### F06. Every `fn` runs at least twice per deploy, in two processes

- **Location:** spec § 5.2, § 7.3; ADR-0062's sentence "Only the fully resolved graph is handed to Alchemy".
- **Issue:** The CLI parent Loads in `runPipeline`, and the Alchemy child Loads again in `lowering()` (`deploy.ts:632`). `destroy` does both too. `prisma dev` repeats them on every rebuild (`execute-dev.ts:494`). Preflight, coverage and the topology submission check the parent's graph; the child deploys its own. A `fn` that reads the clock, a random number, a file, or an environment variable that differs between the two processes (the child gets extra transport variables) deploys a graph nobody checked. Also, `destroy` evaluates values: a `fn` that throws for an environment it no longer recognises blocks that environment's teardown.
- **Suggestion:** Add to § 5.2: "Load runs each `fn` once per Load, and a deploy Loads twice: in the CLI and in the deploy engine's process. `destroy` and every `prisma dev` rebuild Load too. `fn` must be a pure function of its dependencies." Add the same two sentences to the guide section in § 9 (`building-an-app.md`), and say there that `destroy` runs every `fn` for the environment it removes. This is a documented constraint, not a mechanism, which is the cheapest fix. Passing the parent's results to the child was considered and costs more: values have no stable identity across processes.

### F07. Requiring `LowerOptions.environment` breaks the public escape hatch and falls between dispatches

- **Location:** spec § 7.1, § 9, § 13 decision 5; plan D1 and D3.
- **Issue:** Four problems.
  1. `lowering()` and `lower()` are public through `@prisma/composer/deploy`, and `core-model.md` calls `lowering()` the hand-composed escape hatch. A required field breaks every hand-written caller's typecheck, even callers whose graph binds no value. At runtime the requirement buys nothing: the generated stack files are run without a typecheck.
  2. `core-model.md:650` still lists `stage?: string` in `LowerOptions`, and § 9 does not list that block.
  3. The phrase "every `lowering()` and `lower()` call in tests" includes about 13 calls in `packages/1-prisma-cloud/1-extensions/target/src/__tests__/control-lowering.test.ts`. Plan D1 owns § 7.1 but hands off only `@internal/core` checks. D2 runs the target package's `bun test`, which does not typecheck. D3's root `pnpm typecheck` then fails in a file outside D3's scope, and its implementer stops.
  4. D1's `evaluateValues` signature takes `resources`, which have no `options` until D2.
- **Suggestion:** Make it `readonly environment?: string;`, the same as `LoadOptions` and for the same reason, and change § 13 decision 5 to match. If it stays required, say in § 9 that this is a breaking change to `lower()`/`lowering()` and update the `core-model.md` `LowerOptions` block either way. In the plan, D1 names `control-lowering.test.ts` as a file it edits and adds root `pnpm typecheck` to its hand-off. D1's `evaluateValues` takes `inputBindings` and `params` only, and D2 adds `resources`.

### F08. The `provision()` id check is pinned where it can never fire

- **Location:** spec § 5.3, paragraph under the table ("before the `isConfigKeySegment` check for `id`").
- **Issue:** The first check on `id` is `typeof id !== 'string' || id.length === 0` (`load-module.ts:490-492`), and it comes before `isConfigKeySegment`. A value is an object, so it gets "provision() requires a non-empty id". Test 19 fails, and the implementer has to choose where the check goes.
- **Suggestion:** "The `id` check is the first statement after the sealed check, before the `typeof id !== 'string'` check."

### F09. The resource factory and base class do not compile as pinned

- **Location:** spec § 6.3; § 11.5 resource lines.
- **Issue:** Under the probe, `frozenShallowCopy(def.inputs ?? {})` yields `D | {}`, and assigning it to `D`, `DepBindings<D>` or `O` fails (TS2322, "'{}' is assignable to the constraint of type 'D', but 'D' could be instantiated with a different subtype"). The no-bare-casts rule then forces a `blindCast` whose reason the spec does not pin. Separately, the type test "`deps: { target: ref }` with no `inputs` is an error" cannot pass. With `inputs` omitted, TypeScript infers `D` as the constraint `Deps`, so `DepBindings<Deps>` accepts any key. With `NoInfer` on `deps`, `D` becomes `Record<never, never>`, and an object literal is not excess-checked against `{}`. Both variants compile the call without error. The runtime check in test 27 is the real guard.
- **Suggestion:** Pin three casts in § 6.3, for example `blindCast<D, 'an omitted inputs map is the empty Deps; the deps-match check above guarantees the keys agree at runtime'>(frozenShallowCopy(def.inputs ?? {}))`, with the same pattern for `deps` and `options`. In § 11.5 delete "`deps: { target: ref }` with no `inputs` is an error". Add "a ref of the wrong contract on a declared slot is an error", which the probe confirms works.

### F10. Four tests cannot be built as described

- **Location:** spec § 11.
- **Issue and suggestion:**
  - **Test 16.** `dependencies` is `Object.freeze([...])` and `origin` is frozen, so `push` throws `TypeError`. Replace the construction with a forged value. The brand is `Symbol.for('prisma:value')`, so a test can build one: `const v = { [Symbol.for('prisma:value')]: true, origin: { kind: 'computed', dependencies: [] as unknown[], compute: () => 'x' } }; v.origin.dependencies.push(v);`
  - **Test 30.** A resource's deps are fixed when it is constructed, which needs the producer's ref first. So a service that depends on that resource cannot be authored without forging. Say so: "wire `{ id: 'shop.site' }` into an untyped slot of `shop.web`".
  - **Test 37.** No `runPipeline` test exists, and `runPipeline` needs a config file on disk (`checkConfigSource`) and an assembler. Name the file, `cli/src/__tests__/pipeline.test.ts`, and the fixture: a `prisma.config.ts` under `__tests__/fixtures/`, plus a stub `runAssembler` passed through `PipelineDeps`.
  - **§ 11.5.** The deps-without-inputs line; see F09.

### F11. A failing dependency's `fn` is reported as the bound value's `fn`

- **Location:** spec § 5.2 step 2, the note on `site`; § 5.3 messages.
- **Issue:** Suppose `shout` over `greeting` is bound at `input key "greeting"`, and `greeting`'s `fn` returns `undefined`. The message is "The resolve() function for input key "greeting" … returned undefined". The author opens `shout`'s function, which does not return `undefined`. Reporting under the first site is fine, since Load stops at the first error. Naming the wrong function is the problem.
- **Suggestion:** Track depth: `visiting.length > 1` means a dependency failed. For a dependency, the result-check and throw messages begin `A resolve() function that <site> depends on …` instead of `The resolve() function for <site> …`. Add a test: a two-level chain whose inner `fn` returns `undefined`.

### F12. A resource slot's connection contract is never checked

- **Location:** spec § 6.5 ("`buildConfig` stays service-only").
- **Issue:** For a service, `buildConfig` (`deploy.ts:364-427`) enforces that the producer supplies every param the slot's connection declares, and fails with an error naming the edge. A resource gets nothing. Its descriptor reads `ctx.lowered.get(producer)` raw, so a producer that under-delivers reaches the descriptor as `undefined`, with no named error. The ADR-0031 minting loop also skips resource consumers (`deploy.ts:678`), so a `provision` need on a resource slot gets no value, silently.
- **Suggestion:** Cheapest: split the inputs half of `buildConfig` into `export function connectionInputs(node: ServiceNode | ResourceNode, id: NodeId, graph: Graph, lowered: ReadonlyMap<NodeId, Outputs>, provisioned: ReadonlyMap<string, unknown>): Record<string, Record<string, unknown>>`, which `buildConfig` calls and a resource descriptor may call. Then extend test 34 to assert that a producer missing a declared param fails with the existing "did not supply it" message. If that is out of scope, § 6.5 must say both gaps out loud, and P1's spec must close them.

### F13. Types a pack needs are not exported

- **Location:** spec § 3.4, § 6.2.
- **Issue:** § 6.2 exports `DepBindings` from `node.ts`, but § 3.4 does not add it, `ResourceOptions` or `ResourceOption` to `exports/index.ts`. P1 builds `publicUrl` in the Prisma Cloud extension on `ResourceNodeBase<C, D, O>`, and it cannot name `O`'s bound.
- **Suggestion:** Add `DepBindings`, `LoadOptions`, `ResourceOption` and `ResourceOptions` to the type exports in § 3.4.

### F14. The example and QA steps leave decisions open

- **Location:** spec § 7.3, § 8, § 11.7, § 12.
- **Issue:** § 7.3 cites `execute-dev.ts` lines 177 and 480; the calls are at 178 and 494. § 8 does not say where the new smoke assertion goes. If it joins the polling condition, a wrong `environment` field loops for 180 seconds and then reports "never served greeting", which names the wrong problem. § 11.7's "the integration suite that deploys the example, if any" has no target: no integration test deploys `env-param`. § 12's dev check needs `ENV_PARAM_GREETING` set (dev preflight refuses an unset env-sourced param), and it needs a way to read the body, because `smoke.ts` uses the Management API.
- **Suggestion:** Cite the calls by content (`runPipeline(input.entry, …)`), not line. In § 8: "after the greeting matches, check `body.environment`; on a mismatch print `FAIL - ${environment} serves environment ${JSON.stringify(body.environment)}, expected "deployed to ${environment}"` and exit 1." Delete the "if any" clause. In § 12: "With `ENV_PARAM_GREETING=hi`, run `prisma dev`, then `curl "$(prisma dev url)"` and expect `"environment":"deployed to dev"`. Stop it, then repeat with `--environment test`."

## Deferred (out of scope)

- **Version skew between the CLI and the app's `@prisma/composer`.** The stack file imports the app's own `lower()` (`generate-stack.ts:84`). An older CLI Loading an app that uses `resolve()` fails with a `TypeError` on `environment.name`, not a named error. This belongs with the existing extension-compatibility check (`shared.ts`, `DEPS.EXTENSION_INCOMPATIBLE`), not this slice.
- **A value inside a source's payload.** The walk stops at sources, so it would hide one. No typed path puts one there (`envParam` and `envSecret` take strings). Revisit when the module-input project makes sources into values.
- **A finer error code than `COMPOSE.GRAPH_INVALID` for value failures.** That needs an ADR-0044 registry amendment. One code with a `cause` (F02) is enough now.
- **The topology content hash changes** for any graph with a resource slot. That is expected, and the platform stores the hash opaquely.

## Answers to the nine questions

1. **Types.** They compile and behave as claimed, with two exceptions. `resource()` and `ResourceNodeBase` need three unpinned casts (F09). The type test "`deps` with no `inputs` is an error" cannot pass (F09). `Value<InputBinding>` admits sources and nested values, which F05 narrows. `Value<never>`, from an `fn` that only throws, is assignable everywhere; that is harmless.
2. **The walk.** A `deepValues`-style walk finds a value at the root, in arrays and in objects. It also descends into non-plain objects, which substitution does not rebuild (F04). Stopping at a source hides a value in a payload; that is fine for now (Deferred). Memoising by identity is enough, because values are frozen and a value's computation is fixed. Reporting under the first site is fine, since Load stops at the first error. Naming the outer `fn` when a dependency fails is misleading (F11).
3. **Sealing.** Not covered as written. A nested `flatten`'s return value never reaches `loadModule`, so its seal is lost. One shared flag fixes it (F03). No path runs `fn` before sealing: `evaluateValues` is the only caller of `compute`, and `resolve()` never calls `fn`.
4. **Resources.** These all hold: wiring, `validateWiring` with `targetKind: 'resource'`, `wiringEdges`, `recordAuthoredWiring` (a forwarded input keeps its identity through `frozenShallowCopy`), `assertDependencyDag`, `topoSort` order, and lowering order, including `lowered` of a producer service. The topology, `env-key-clash.ts` and `preflight-names.ts` do not break. The copy keeps `isPostgresResourceNode` and the brand, but throws as pinned (F01). Replacing `byId` does nothing (F01). Unchecked: the slot's connection contract (F12).
5. **`LowerOptions`.** What breaks: core `lowering.test.ts`, target `control-lowering.test.ts` (about 13 calls, which the plan does not own), and hand-written `lower()`/`lowering()` callers. `core-model.md` keeps a stale `stage` (F07). Removing `stage` is safe: nothing reads it, and the docs' "Driving deploys from code" uses the `deploy()` operation, not `lower()`. `runPipeline` reaches all three callers; the line numbers are off (F14). TypeScript catches a missed caller, because the parameter after `environment` is an object.
6. **No environment.** Not reachable from a command: the CLI and both generated stack files pass it. It is reachable from a direct `Load(root)` call, for example an author's own unit test, and for that caller the message is honest. `COMPOSE.GRAPH_INVALID` is acceptable for the result checks. It is wrong to let a user `fn`'s own exception escape unwrapped: ADR-0044 makes that a reported bug (F02).
7. **Cheapest alternatives.**
   - Second pass in lowering: rejected correctly; preflight needs the resolved graph.
   - Prototype-preserving copy versus a `Graph.resourceOptions` list, like `inputBindings`: the list avoids copying but leaves raw values on `ctx.node.options` for a descriptor to misread. Keep the copy with F01's fix.
   - `options` on the resource versus at `provision()`: on the node is right, since the resource's wiring is its own and `publicUrl({ url })` is a factory argument.
   - Sealing via collected closures versus one shared flag: the flag is cheaper and correct (F03).
   - Required versus optional `LowerOptions.environment`: optional is cheaper and consistent with `LoadOptions` (F07).
8. **Tests.** Test 16 is unimplementable as described. Test 30 needs a forged ref. Test 37 has no file or harness. One § 11.5 line cannot pass (F09, F10). Test 17 is implementable. Missing failure-mode tests:
   - a leaked nested `provision` called from a root `fn` (F03);
   - a value inside a class instance in a binding (F04);
   - `fn` returning a source, a function, or nested `undefined` (F05);
   - a failing dependency `fn`'s message (F11);
   - a thrown error's `cause` (F02);
   - Loading the same root twice, to prove the seal does not leak across Loads;
   - a producer under-delivering to a resource slot (F12);
   - the evaluated stack file passing `environment` to `lower()`: extend `stack-file-import.test.ts`'s stub to echo `opts.environment`, rather than only string-matching in tests 35 and 36;
   - destroy passing the environment into Load.
9. **Example and QA.** Yes: `prisma dev` proves "differs between two environments" without Prisma Cloud credentials, because dev containers are purely local (`execute-dev.ts`, "Containers — purely local"). It needs `ENV_PARAM_GREETING` set and a `curl` of `prisma dev url` (F14). The smoke assertion holds against the Branch resolution: `smoke.ts` and the `deploy` script both read `ENV_PARAM_ENVIRONMENT` and both default an empty value to `production`. Place it after the greeting match, with its own failure message (F14).

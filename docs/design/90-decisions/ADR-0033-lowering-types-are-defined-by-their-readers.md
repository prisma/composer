# ADR-0033: Every value in the lowering pipeline is typed by the code that reads it

## Decision

The lowering SPI has several places where one piece of code hands a value to
another. **At each of them, the type is defined by the code that reads the
value, not by the code that produces it.** No single shared record is used in
more than one of those places.

Concretely, replacing `LoweredNode` (`{ outputs: Record<string, unknown> }`):

```ts
// 1 — a descriptor hands values between its own phases. Typed by the descriptor
// that writes AND reads them; core passes P and S through without inspecting either.
export interface ServiceLowering<P = unknown, S = unknown> {
  provision(ctx: LowerContext): Effect.Effect<P, unknown, unknown>;
  serialize(ctx: LowerContext, provisioned: P, config: Config): Effect.Effect<S, unknown, unknown>;
  package(ctx: LowerContext, input: PackageInput): Effect.Effect<Artifact, unknown, unknown>;
  deploy(ctx: LowerContext, provisioned: P, artifact: Artifact, serialized: S):
    Effect.Effect<Outputs, unknown, unknown>;
}

// 2 — the extension's application hook hands its product to that extension's
// own descriptors. Core types nothing here; the extension defines its own
// product type and narrows to it with its own guard.
readonly application: unknown;

// 3 — one node hands values to the nodes wired downstream of it. Name-keyed and
// unknown-valued: the consumer's connection declaration is the contract,
// resolved by param name at runtime.
export type Outputs = Readonly<Record<string, unknown>>;
```

The **lowering loop is the only router**. It alone knows that `deploy`'s return
feeds `buildConfig` for dependent nodes. Descriptors do not know `buildConfig`
exists. A future consumer of a descriptor's output must declare its own
interface and appear as a visible routing edit in the loop.

Two of these are decided here and implemented in later slices: the connection
contract becomes **enforced** — a producer that fails to supply a param the
consumer's connection declares fails the deploy naming the edge (S2) — and
**deployment results** become core-declared types the loop assembles at full
context (S3). Neither is implemented by this ADR.

## Reasoning

### What went wrong

`LoweredNode` was one type serving three unrelated contracts:

1. **Intra-descriptor phase handoffs** — `provision` → `serialize`/`deploy`.
   Same party writes and reads; core never looks inside. Forcing them through
   the shared record made descriptors cast to recover types they had produced
   themselves two phases earlier.
2. **A node's outputs for its dependents** — `deploy`'s return, stored in the
   `lowered` map, read by `buildConfig` by param name. The only role core
   genuinely consumes.
3. **Reporting** — the reverted `NodeReport` (PR #101), possible only because a
   shared untyped record accepts a new field without any consumer's signature
   changing.

A shared bag is a *producer-side* type: it describes what someone hands over,
not what anyone needs. That is what let one type serve three consumers — and
what let reporting data be added to the type dependents' connections resolve
against, without any reviewer seeing an interface change.

### The evidence: a type lie the bag hid indefinitely

Migrating the first descriptor off `LoweredNode` immediately surfaced a bug
that had been live and invisible.

Compute's `provision` yields an Alchemy `ComputeService` and stores `svc.id`.
`ComputeServiceAttributes` declares `id: string`, so `serviceId` looked like a
`string` — and `deploy` read it back as one:

```ts
computeServiceId: provisioned.outputs['serviceId'] as string,   // the lie
```

`svc.id` is **not** a `string`. Alchemy's `Resource` type maps every attribute
through `Output` (`Resource.d.ts:95-100`), so `svc.id` is an `Output<string>` —
an unresolved, lazy reference (see the appendix). The cast laundered that
reference into a `string` at the read site, and it compiled for one reason:
the consuming prop is `Input<string>`, which accepts **both** a `string` and an
`Output<string>`. Nothing in the pipeline ever objected.

Typing the handoff honestly deletes the cast rather than relocating it:

```ts
export interface ComputeProvisioned {
  readonly serviceId: Output.Output<string>;  // what it actually is
  readonly projectId: string;                 // CLI env, genuinely a string
}
// deploy, now:
computeServiceId: provisioned.serviceId,      // no cast; Input<string> accepts it
```

### The thesis: deliberate and audited, not absence of claims

The tempting conclusion — "a shared bag lets you lie; a typed handoff doesn't"
— is refuted by our own code. `compute.serialize` keeps a `blindCast` that
claims `Output<string>` for a provisioner ref — a value that arrives through a
different `unknown`-typed channel, which
[ADR-0031](ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md)
keeps deliberately opaque. It is the same kind of unchecked claim
that `as string` was. **We are keeping it.**

The distinction that matters is not whether an unchecked claim exists. It is
whether the claim is **named, justified, and singular**:

- The provisioner-ref cast is **one site**, carrying a written justification of
  why no guard is possible. A reviewer can evaluate that argument. A grep finds
  every instance. It is a decision on the record.
- The bag made the same kind of claim **anonymously, at every read site, with
  nothing recording that a claim was being made at all.** `outputs['serviceId']`
  reads as ordinary field access. Nothing marks it as the moment someone decided
  an `unknown` was a `string`. No reviewer was ever asked.

That is why `serviceId` survived code review and `keyOuts` is fine. The goal is
not zero unchecked claims — it is that every one is deliberate and auditable.

### Three handovers, three mechanisms

The three places differ in what the type claims, and in what stops the claim
from being wrong:

| Where a value is handed over | The type claims | What checks it |
| --- | --- | --- |
| **Between a descriptor's phases** (`P`, `S`) | Precise types | The **compiler** — the same descriptor writes and reads them, so it can check both ends |
| **Application hook → its extension's descriptors** (`ctx.application`) | Precise: `CloudApplication.projectId: string` | A **runtime guard** (`isCloudApplication`) — the value passes through core as `unknown`, so the compiler cannot follow it |
| **A node → the nodes wired downstream of it** (`Outputs`) | **Nothing** — the values are `unknown` | Nothing needed. `unknown` cannot lie |

The third row is where the argument actually lands. `warm.url` (postgres) and
`creds.accessKeyId` (s3-credentials) are *also* unresolved `Output<string>`s —
exactly like `serviceId`. They were never mis-typed, and could not have been:
they flow into `Outputs`, which claims nothing about them. Core cannot know
extension types, and which producer feeds which consumer is decided by the
user's graph at runtime, so `Outputs` says it does not know, and the value is
resolved by name against the consumer's declared params instead.

**The bug could only ever have lived where a precise claim was made with no
mechanism checking it.** The application hook's product is a precise claim too
— checked by a guard rather than by the compiler, which is why there are three
mechanisms and not two.

## Consequences

### Alchemy execution facts this rests on

Verified against `alchemy@2.0.0-beta.59`; S2 and S3 build on these rather than
re-deriving them.

- **The whole stack effect runs before anything is applied.**
  `deploy = evalStack(stackEffect) → Plan.make → Apply.apply`
  (`src/Deploy.ts:25-30`). Our entire `lowering()` generator completes before
  the first platform call.
- **Yielding a resource returns a lazy proxy**, whose property reads produce
  `Output.PropExpr` references (`src/Resource.ts:275-283`).
  `deployment.deployedUrl` inside a descriptor is symbolic, not a URL.
- **Therefore phase-handoff types legitimately carry unresolved `Output<T>`
  references.** A handoff type promising resolved values is lying — this is the
  same lazy-Output truth as the execution model, surfacing in the SPI's types.
  `ComputeProvisioned.serviceId: Output<string>` is the correct type, not a
  compromise.
- **Resolved values reach program code in exactly one place**: apply evaluates
  whatever the stack effect returned and returns that resolved structure
  (`src/Apply.ts:198`). It also unconditionally persists it via `state.setOutput`
  (`src/Apply.ts:203`) — alchemy's cross-stack-reference mechanism — so whatever
  crosses that boundary must be plain data.
- **The stack effect now returns `undefined`.** `Apply.apply` short-circuits on
  a falsy plan output (`src/Apply.ts:191-193`): no `setOutput` write, and the
  CLI skips its `Console.log`. This removes the `{ outputs: {} }` dump printed
  after every deploy. Existing `alchemy_stack_output` rows go stale but harmless.
- **Per-resource change status (created/updated/noop/skipped) is not returned to
  the program.** It lives in apply's tracker and is emitted as status-change
  events to alchemy's CLI session service (`src/Apply.ts:184-185`, `:415-421`).
  Capturing it requires wrapping that service or an upstream change.

#### Actions — how resolved values reach program code after all

The facts above say resolved values are unreachable from the stack effect. An
**Action** is the exception alchemy provides, and S3's deploy report is built on
it. Each of these was verified by a throwaway probe that applied a real stack
against alchemy's in-memory state, not by reading the types:

- **An Action whose input references a not-yet-created resource plans, and runs
  during apply after the resources it references.** An Action is a graph node
  that runs an Effect with its resolved input during plan/apply
  (`src/Action.ts:12-13`); its upstream edges are derived from the Output
  references found in its input (`Output.upstreamAny(action.Input)`,
  `src/Plan.ts:543`), which is what orders it after them. Probed on a fresh
  stack where the referenced resource did not yet exist: it planned and ran.
- **The runner receives resolved values, arbitrarily deep.** Apply evaluates the
  action's input against its tracker (`src/Apply.ts:1190`) and invokes the body
  with the result (`src/Apply.ts:1205`); the runner's parameter is typed `In`,
  the resolved shape, while the call site takes
  `{ [k in keyof In]: Input<In[k]> }` (`src/Action.ts:39` and `:133`). Probed
  two levels deep — `entries[].entities[].id`, handed over as an
  `Output<string>`, arrived in the runner as a real `string`.
- **Alchemy hashes the RESOLVED input and noops on an unchanged hash.** Plan
  resolves the input, then hashes that (`src/Plan.ts:1043-1044`), and an Action
  whose prior run has the same hash is planned as a noop unless `--force`
  (`src/Plan.ts:1069-1071`); apply persists the resolved snapshot alongside the
  hash (`src/Apply.ts:1199-1200`, `src/State/ActionState.ts:28-30`). **This is why a
  nonce evaluated at stack-effect time works**: it changes the resolved input,
  so the hash differs and the body runs on an otherwise unchanged redeploy.
  Established with a control, not by observing a re-run: three deploys — fresh
  (ran), unchanged with a new nonce (ran), unchanged with the *same* nonce (did
  **not** run). The third is what proves the noop is real and the nonce is what
  defeats it; without it, "it ran" would be consistent with actions always
  running.
- **`Input<T>` maps `readonly T[]` correctly**, so an Action's `In` may use
  `readonly` arrays and match the rest of the codebase. The reasoning that says
  otherwise is a trap worth recording: `readonly T[]` genuinely fails the array
  branch's `T extends any[]` test (`src/Input.ts:23`) and falls through to the
  object branch — but that branch is `{ [K in keyof T]: Input<T[K]> }`
  (`src/Input.ts:28`), a *homomorphic* mapped type over a naked type parameter,
  and TypeScript special-cases those over arrays: elements are mapped, and both
  array-ness and the `readonly` modifier survive. It never maps over `length` or
  `map`. Probed for teeth rather than compilation: the `readonly` form accepts a
  nested `Output<string>`, rejects a wrong type and an excess key at that same
  nested position, and stays unassignable to a mutable array — which also rules
  out a silent collapse to `any`.

### The registry's type safety rests on the loop, not the compiler

Descriptors with different `P`/`S` assign into one
`Record<string, NodeDescriptor>` only through TypeScript's **method
bivariance** — which is why `ServiceLowering` must use method syntax; a
property-arrow form is checked contravariantly and the assignment fails.

This is **unsound by construction**, and deliberately accepted. Core calls
`descriptor.serialize(ctx, provisionedNode, config)` with `provisionedNode`
typed `unknown`, so the compiler would not object if the loop ever threaded the
wrong node's provisioned value into a descriptor. The loop is correct today;
nothing but the loop makes it correct.

This is the price of a heterogeneous registry core cannot type. It is recorded
here so that anyone editing the lowering loop — S2 and S3 both do — knows what
they are holding.

### `ComputeSerialized` crosses a module boundary — and that is a tripwire

One producer-side shape is imported across modules: `s3-store`'s
`S3StoreSerialized extends ComputeSerialized`. This is legitimate because
`s3-store` **composes compute's own descriptor** — it delegates to compute's
hooks and extends their product. Same party, not an unrelated consumer.

**The tripwire:** a third descriptor importing `ComputeSerialized` *without*
composing compute is the shared bag reforming. The answer then is its own
handoff type, not a widened shared one.

For the same reason, `computeDescriptor` returns its precise descriptor type
rather than the erased `NodeDescriptor`. The registry erases `P`/`S` on
assignment anyway, but `s3-store` needs them visible; annotating
`NodeDescriptor` would force `s3-store` to cast them straight back —
putting back into s3-store the exact cast-to-recover-your-own-type problem this
ADR exists to remove.

### General

- Each of `LoweredNode`'s three roles now has its own consumer-declared type;
  no descriptor casts to recover a value it produced itself.
- A new consumer of a descriptor's output requires a declared interface and a
  visible routing edit in the loop. The dumping-ground regression that produced
  `NodeReport` becomes structurally impossible.
- **The descriptor names what is publishable.** Core never infers meaning from
  output keys: `url` means a public endpoint because the descriptor said so.
  No core-level rule is safe — `url` on compute is an endpoint, on postgres it
  would be a connection string.
- An extension whose application hook does not run yields `ctx.application ===
  undefined` (previously `{ outputs: {} }`). Prisma-cloud's descriptors go
  through `projectIdOf`'s guard, which fails and names the hook that did not run
  — correct, since
  those descriptors require the hook.

## Alternatives considered

- **`NodeReport` on `LoweredNode`** (PR #101) — rejected: reporting data on the
  type dependents' connections resolve against, untyped, and meaningless on
  two of the three phases. This
  ADR supersedes that approach.
- **A separate `describe()` SPI hook** — rejected: the resource handles live
  inside `deploy()`'s effect; `describe()` would need them handed back out,
  which is returning them with extra plumbing.
- **Full generic threading of the application type** through
  `ExtensionDescriptor`/`NodeDescriptor` — rejected: the registry is
  heterogeneous, and the assignment would lean on method bivariance in
  contravariant positions across packages. `ServiceLowering<P, S>` is fine
  because producer and consumer are the same descriptor; the application type
  has no such guarantee. Hence `unknown` plus an extension-owned guard.
- **Keeping `serviceId: string` and casting** — rejected: it would have forced
  the deleted cast's reintroduction. The accurate type removes it.

## References

- `packages/0-framework/1-core/core/src/deploy.ts` — the SPI and the lowering loop.
- `packages/1-prisma-cloud/1-extensions/target/src/descriptors/` — the migrated descriptors.
- [ADR-0005](ADR-0005-users-build-the-framework-assembles.md) — users build, the framework assembles.
- [ADR-0031](ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md) — provisioner refs are opaque by design.
- alchemy `2.0.0-beta.59`: `src/Deploy.ts`, `src/Resource.ts`, `src/Apply.ts`; `lib/Resource.d.ts`.
- Composer PR #101 — the superseded `NodeReport` attempt.
</content>
</invoke>

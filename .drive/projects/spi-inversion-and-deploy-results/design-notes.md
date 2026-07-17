# Design notes — SPI inversion & deployment results

The settled argument from the design session (2026-07-17), recorded so
slices don't re-derive it. The ADR (S1) distills the durable decisions;
this file keeps the full reasoning and the dead ends.

## Principles inherited

- ADR-0005: users build, the framework assembles — deterministic steps, no
  guessing. A renderer that walks our own graph (not alchemy's output) is
  the reporting expression of this.
- `architecture.config.json` layering: the CLI (framework/tooling) must not
  import prisma-cloud; core stays presentation-free.
- Repo cast rules: no bare `as`; the SPI must not force descriptors to cast.

## The corrected execution model (verified, alchemy 2.0.0-beta.59)

> **Citation drift, corrected 2026-07-17.** S1-D3 re-derived every line
> number below against the installed source rather than trusting this file,
> and most had drifted a few lines. **ADR-0033 carries the corrected
> citations and is the authority**; the ones in this section are indicative.
> Corrections: `Deploy.ts:25-30`; `Apply.ts:191-193` (short-circuit);
> `Apply.ts:198` + `:203` (evaluate, then `setOutput`); `Resource.ts:275-283`
> (unchanged); and the status-change emit exists at **two** sites —
> `Apply.ts:415-421` (per-resource `report()`) and `Apply.ts:184-185`
> (terminal flush) — where this file cited only the first. The *facts* below
> all re-verified; only the line numbers moved. Lesson for S2/S3: cite
> against the installed source at write time, not against this file.

The design initially assumed each `yield*` in a descriptor returns after
alchemy applies that resource, resolved values in hand. **Wrong.** Verified
against alchemy source:

- `deploy = evalStack(stackEffect) → Plan.make → Apply.apply`
  (`src/Deploy.ts:25–32`). Our entire `lowering()` generator runs to
  completion before any platform call.
- Yielding a resource returns a Proxy whose property reads produce lazy
  `Output.PropExpr` references (`src/Resource.ts:275–283`).
  `deployment.deployedUrl` in a descriptor is symbolic, not a URL.
- Resolved values reach the program in exactly one place: apply evaluates
  **whatever the stack effect returned** against its internal tracker and
  returns that resolved structure (`src/Apply.ts:195–205`). It also
  unconditionally persists that value via `state.setOutput`
  (`src/Apply.ts:203`) — alchemy's cross-stack-reference mechanism.
- Per-resource phase outcomes (created/updated/noop/skipped) are **not**
  returned to the program. They live in apply's tracker and are emitted as
  status-change events to alchemy's CLI session service
  (`src/Apply.ts:415–421`). Capturing them means wrapping that service or
  an upstream change.

Consequences:

- The association (node → primitives) forms at full context inside the
  lowering loop, but as symbolic Output references; values materialize when
  the stack's return value is evaluated.
- Returning address-keyed primitives from the stack effect is **alchemy's
  designed mechanism** for getting resolved values out — not a transport
  hack. `lowering()` returning hardcoded `{ outputs: {} }` is us opting out
  of it.
- Because alchemy persists the stack output, the value crossing the stack
  boundary must be plain data. That is a rule about *alchemy's channel*,
  not about our domain types: `DeploymentResult` (node-bearing) is
  assembled after `deploy()` returns, in the same child process, by joining
  the resolved primitives to the graph.

## The three roles of `LoweredNode`

One type (`{ outputs: Record<string, unknown> }`, `deploy.ts:116–118`)
serves:

1. **Intra-descriptor phase handoffs** (`provision` → `serialize`/`deploy`).
   Same-party producer and consumer; core threads them opaquely. Forcing
   them through the bag makes descriptors cast to recover their own types
   (`compute.ts:155–161`).
2. **Inter-node wiring** (`deploy` → `lowered` map → `buildConfig`). The
   only role core reads — by param name, per the consumer's connection
   declaration.
3. **Reporting** — the reverted `NodeReport`, possible only because a
   shared bag accepts new fields without any consumer's signature changing.

## Key decisions

- **Dependency inversion at every seam; interfaces live with consumers.**
  Phase-handoff types: descriptor-owned, generic in the SPI
  (`ServiceLowering<Provisioned, Serialized>` in spirit), opaque to core.
  Wiring: the connection declaration is the interface (consumer side, in
  core's graph model); across the extension seam it is necessarily
  runtime-checked (schemas), not TypeScript-checked — core cannot know
  extension types and the producer/consumer pairing is decided by the
  user's graph. Primitives/results: declared by the deploy-result subsystem
  in core. Formatting: declared by the CLI beside the renderer.
- **The lowering loop is the sole router.** deploy's product splits into
  wiring (→ `lowered`, for dependents) and primitives (→ results).
  Descriptors don't know `buildConfig` exists; neither knows reporting
  exists. A future consumer must declare an interface and appear as a
  visible routing edit in the loop — the dumping-ground regression becomes
  structurally impossible.
- **`DeploymentResult` per node** — graph node + typed primitives
  (`kind`, platform `id`, `url` only when the descriptor declares it
  public) + a diagnostics slot populated later. No aggregate noun; the run
  yields a collection. "Deployment" alone is banned — it collides with the
  `Prisma.Deployment` alchemy resource.
- **Descriptor names what is publishable** (the allowlist lesson): `url`
  means a public endpoint on compute and would mean a connection string on
  postgres, so no core-level rule is safe.
- **Renderer runs in the deploy child**, wired through the generated stack
  file; it walks our module tree and prints authored names with ids/URLs.
  The stack's own output shrinks to primitives (or nothing beyond them),
  killing the raw alchemy dump.
- **Wiring enforcement** (pending operator confirmation): after a producer
  lowers, core checks its wiring outputs satisfy every param the consumer's
  connection declares (except provisioned ones); a gap is a `LowerError`
  naming edge, param, and both nodes — at deploy time, where the mistake
  is, instead of `undefined` in a booted service's env.

## Shaping addendum (2026-07-17, slice grounding)

Facts established while pinning the slice specs, superseding two earlier
leanings:

- **The render vehicle is an alchemy Action, not a post-apply step.** The
  bin (`src/Cli/commands/deploy.ts`) has no post-apply hook: it imports the
  stack module's default export, plans, applies, `Console.log`s a non-
  undefined output, done. Actions (`src/Action.ts`) are alchemy's "run
  during apply with resolved inputs" primitive: recorded on the stack,
  given upstream edges from their input's Output references
  (`src/Plan.ts:539-546`), executed by apply with the resolved input, with
  their output tracked like a resource (`src/Apply.ts:1103-1232`). An
  action noops when its input hash matches prior state
  (`src/Plan.ts:1069-1082`) — a `Date.now()` nonce in the input forces the
  report to run every deploy.
- **Parent-process readback via `getOutput` was rejected on three verified
  grounds**: our pg state layer requires alchemy's `Stack` service
  (`state/layer.ts:47` does `yield* Stack`) so the parent would fake it;
  the layer acquires the deploy lock on build (`state/layer.ts:76`); and
  the parent would have to replicate alchemy's stage derivation
  (`--stage` absent → `STAGE` config → `dev_${USER}`,
  `src/Cli/commands/_shared.ts:85-110`) to key the read.
- **The stack effect returns `undefined` from S1 on.** `Apply.apply`
  short-circuits on a falsy plan output (`src/Apply.ts:189-191`): no
  `setOutput` write, and the bin skips its `Console.log`. This kills the
  `{ outputs: {} }` dump one slice early and makes S3's action the only
  output channel.
- **Action inputs must be plain data + alchemy Inputs.** Plan-time
  `hashInput(resolvedInput)` serializes the input — graph nodes (functions,
  Standard Schemas) must never ride in it. Addresses + primitives in the
  input; the graph joins in the runner via closure.
- **`ctx.application` is typed `unknown`, narrowed by an extension-owned
  guard** (`CloudApplication`/`projectIdOf`). Full generic threading of the
  application type through `ExtensionDescriptor`/`NodeDescriptor` was
  rejected: the registry is heterogeneous, and the assignment would lean on
  method bivariance in contravariant positions across packages. The
  `ServiceLowering<P, S>` generics are fine because producer and consumer
  are the same descriptor; the registry stores them at the `unknown`
  defaults through method bivariance (kept deliberately — noted in S1).

## Alternatives considered

- **`NodeReport` on `LoweredNode`** (PR #101): rejected — reporting data on
  the wiring contract, untyped, meaningless on two of three phases.
- **A separate `describe()` SPI hook**: rejected — the resource handles
  live inside `deploy()`'s effect; `describe()` would need them handed back
  out, which is just returning them with extra plumbing.
- **Transporting results to the CLI parent** (stdout parsing → JSON file →
  state-store `getOutput` readback): all rejected — the child already holds
  both the Graph and the results; every transport was solving a problem
  that doesn't exist. The state-store version also let a serialization
  concern dictate the domain model ("can't hold a Node because Postgres").
- **Making the whole `DeploymentResult` the stack output**: rejected —
  alchemy persists stack output unconditionally, and nodes carry functions/
  schemas. Plain primitives cross; the join to nodes happens on our side.

## Open questions

- Operator confirmation on wiring enforcement (S2 contingent).
- `Output.evaluate` behavior on plain values mixed into the returned
  structure — verify early in S3.
- Whether `ApplicationDescriptor`/provisioner surfaces get full generic
  treatment or a minimal rename (S1 decides from their actual consumers).

## References

- `packages/0-framework/1-core/core/src/deploy.ts` — SPI + loop.
- `packages/1-prisma-cloud/1-extensions/target/src/descriptors/compute.ts`
  — the cast-recovery example (lines 155–161).
- alchemy `2.0.0-beta.59` `src/Deploy.ts`, `src/Resource.ts`,
  `src/Apply.ts` — execution-model evidence.
- ADR-0005, ADR-0031; `architecture.config.json`.

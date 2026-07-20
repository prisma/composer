# S3 — DeploymentResult and rendered deploys

## At a glance

A node's final lowering phase reports the platform primitives it became,
distinctly from its wiring outputs. The lowering loop assembles them; an
alchemy **Action** — declared last in the stack effect, forced to run every
deploy by a nonce — receives the *resolved* primitives during apply, joins
them to the graph it holds by closure, and invokes a CLI-supplied renderer.
The user sees their own topology with ids and public URLs; alchemy's raw
stack-output dump stays dead (the stack still returns `undefined`).
Supersedes PR #101.

**Mechanism rationale (recorded so it isn't re-litigated):** the stack
effect runs before apply, so program code can't see resolved values after
the fact; the bin has no post-apply hook; parent-side state readback needs
a faked `Stack` service, re-takes the deploy lock, and must replicate
alchemy's `dev_${USER}` stage derivation. Actions are alchemy's designed
"run during apply with resolved inputs" primitive — verified in
`src/Action.ts` / `src/Plan.ts:1040-1100` / `src/Apply.ts:1103-1232`
(2.0.0-beta.59). Actions noop when their input hash is unchanged, hence
the nonce.

## Chosen design

### Core types — `packages/0-framework/1-core/core/src/deploy.ts`

**Amended 2026-07-17 (F5, review) — `primitives` is required, not optional.**
The original pin had `primitives?`, with the loop reading
`result.primitives ?? []`. That lets a descriptor assert *"this node became
no platform primitives"* **by staying silent** — no error, no type
complaint, no test failure.

That is the project's own thesis turned against its own code. ADR-0033 says a
claim must be **named, justified, and singular**, and that the bag's sin was
letting claims be made *anonymously, with nothing recording that a claim was
being made at all*. An omitted optional field is exactly that. The live
evidence: commit `0fe22f2`'s message records that rebuilding s3-store's
result by hand "would have silently dropped them" — the author's care
prevented a drop the **type** should have made impossible, which is the
substitution this project exists to reverse. `s3-credentials` already models
the honest form: `primitives: []`, deliberately, with a comment.

Zero churn: all seven construction sites (five descriptors + two core test
fakes) already supply it explicitly. Making it required breaks nothing and
constrains only what comes next — D4's work and any third-party extension.

**Amended 2026-07-17, before implementation** — S1-D2 established that
resource attributes are `Output<T>`, not `T` (alchemy maps every attribute
through `Output`; `Resource.d.ts:95-100`). The originally pinned
`DeployedPrimitive.id: string` had the same defect S1's
`ComputeProvisioned.serviceId: string` did: a descriptor constructing a
primitive holds `svc.id`/`deployment.deployedUrl`, which are **unresolved
references**. So the primitive needs two shapes — the resolved one the
report consumer sees, and the construction-side one a descriptor returns.
This is not a workaround; it is the same lazy-Output truth the execution
model already records.

```ts
/**
 * One platform thing a node became, RESOLVED — what the report consumer
 * sees. The descriptor names it; core never infers. `url` is present ONLY
 * when the descriptor declares the address publicly reachable — a
 * connection string is never a `url`.
 */
export interface DeployedPrimitive {
  readonly kind: string;
  readonly id: string;
  readonly url?: string;
  readonly details?: Readonly<Record<string, string>>;
}

/**
 * What a descriptor RETURNS: the same shape, but every field may still be
 * an unresolved reference, because the stack effect runs before apply.
 * Alchemy's `Input<T>` mapping is deep and recursive (`Input.ts:11-29`:
 * the object branch is `{ [K in keyof T]: Input<T[K]> }`), so this is
 * exactly what the Action's input position accepts — and `Output.upstreamAny`
 * walks it to give the action its upstream edges on every referenced
 * resource, which is what makes apply run it last.
 */
export type ReportedPrimitive = Input<DeployedPrimitive>;

/**
 * What a node's final lowering phase produces: wiring for dependents,
 * primitives for reporting. `primitives` is REQUIRED — a node that became no
 * platform primitives says so out loud with `[]`.
 */
export interface LoweredResult {
  readonly wiring: WiringOutputs;
  readonly primitives: readonly ReportedPrimitive[];
}

/** What one graph node became — the deploy subsystem's own result type. In-process only. */
export interface DeploymentResult {
  readonly address: string;
  readonly node: ServiceNode | ResourceNode;
  readonly primitives: readonly DeployedPrimitive[];
}
```

`LowerOptions` gains:

```ts
/** Invoked once per deploy, during apply, with every node's resolved results in topo order. Presentation belongs to the caller (the CLI wires its renderer here); core never formats. */
readonly report?: (results: readonly DeploymentResult[]) => void;
```

### SPI change

- `Lowering` (resources): returns `LoweredResult` (was `WiringOutputs`).
- `ServiceLowering.deploy`: returns `LoweredResult`. `provision`/`serialize`/
  `package` unchanged.

### Loop change — `lowering()`

- Per node: `const result = yield* …; lowered.set(id, result.wiring);` and
  collect `entries.push({ address: id, primitives: result.primitives ?? [] })`
  in topo order.
- After the loop, **only when `opts.report !== undefined`**, declare the
  action (inline form, `Action('composer-deployment-report', runner)`,
  imported from `alchemy`):
  - **Input** (plain data + alchemy Inputs ONLY — never graph nodes: the
    plan hashes the resolved input, and nodes carry functions/schemas).
    Declare the action's `In` in **resolved** terms — that is what the
    runner receives:

    ```ts
    interface ReportEntry {
      address: string;
      primitives: DeployedPrimitive[];   // resolved — the runner's view
    }
    // In = { nonce: number; entries: ReportEntry[] }
    ```

    The call site passes `{ nonce: Date.now(), entries }` carrying
    `ReportedPrimitive`s; the deep `Input<>` mapping on the input position
    accepts their unresolved fields. The nonce defeats the input-hash noop
    so the report runs on unchanged redeploys.

    **Declare `In`'s arrays `readonly`** (`readonly ReportEntry[]`,
    `readonly DeployedPrimitive[]`), matching `LoweredResult` /
    `DeploymentResult` and the codebase's `readonly`-throughout style.

    **Amended 2026-07-17 (D1 probe — the earlier pin was wrong).** The spec
    previously required mutable arrays, reasoning that `Input<T>`'s array
    branch tests `T extends any[]`, which `readonly T[]` fails, so it would
    fall to the object branch and map over array *members* (`length`, `map`)
    rather than elements. **The premise is right; the conclusion is wrong.**
    It does fall to the object branch — but that branch is
    `{ [K in keyof T]: Input<T[K]> }`, a *homomorphic* mapped type over a
    naked type parameter, and TypeScript special-cases those over arrays: it
    maps over **elements**, preserves array-ness, and preserves the
    `readonly` modifier. It never touches `length`/`map`/`filter`.

    Probed, and probed for *teeth* rather than mere compilation: both forms
    accept a nested `Output<string>`, both reject `id: 42`, and both reject
    an excess key at the same nested position. `Input<readonly P[]>` stays
    array-like and stays readonly (assigning it to `P[]` is correctly
    rejected — which also rules out a collapse to `any`).

    Same shape as S1's `serviceId` defect: **a claim derived by reading
    types instead of compiling them.**
  - **Runner**: receives the resolved input; closes over `graph` and
    `opts`; joins via the pure helper below; calls `opts.report(results)`;
    returns `undefined`.
  - `yield*` the action call so it lands in the stack's plan; its input
    referencing every primitive gives it upstream edges on every reporting
    resource, so apply runs it after them.
- The stack effect still returns `undefined` (no `setOutput`, no bin dump).
- Extract the join as an exported pure function so it is unit-testable
  without alchemy:

```ts
/** Joins resolved report entries back to their graph nodes. Skips addresses the graph no longer holds (defensive: entries are data, the graph is truth). */
export function joinDeployment(
  graph: Graph,
  entries: readonly { address: string; primitives: readonly DeployedPrimitive[] }[],
): readonly DeploymentResult[]
```

- The gen-block's closing type assertion updates for the yield of the
  action effect (whose requirements include alchemy's `Stack` context) —
  keep the existing single-assertion idiom.
- Tests that run `lowering()` without `opts.report` never construct the
  action and stay sync-runnable — this conditionality is REQUIRED, not an
  optimization.

### Descriptor primitives — pinned per descriptor

| Descriptor | `primitives` |
| --- | --- |
| compute `deploy` | `[{ kind: 'compute-service', id: provisioned.serviceId, url: deployment.deployedUrl }]` |
| s3-store `deploy` | base compute's primitives, unchanged (delegation passes them through with the wiring spread) |
| postgres | `[{ kind: 'postgres-database', id: db.id }]` — **no `url`** (connection string is not public) |
| prisma-next | `[{ kind: 'postgres-database', id: db.id }]` |
| s3-credentials | `[]` — a minted keypair has nothing publishable; secret material must never appear in a primitive |

Wiring returns wrap accordingly: e.g. compute deploy returns
`{ wiring: { url: deployment.deployedUrl, projectId: provisioned.projectId }, primitives: […] }`.

### Renderer — `packages/0-framework/3-tooling/cli/src/render-deployment.ts`

```ts
/** Renders a deploy's results as the app's own topology. Pure — returns the string; the caller prints. */
export function renderDeployment(appName: string, results: readonly DeploymentResult[]): string
```

Pinned format — tree by dot-address segments, box-drawing guides, one line
per primitive `kind id`, URL indented on its own line when present, nodes
without primitives listed with `(no primitives reported)`:

```
storefront-auth
├─ auth
│  └─ api   compute-service cps_abc123
│           https://xyz.ewr.prisma.build
├─ db       postgres-database pdb_def456
└─ web      compute-service cps_ghi789
            https://uvw.ewr.prisma.build
```

The default report callback (same file):

```ts
/** The report hook the generated stack file wires into LowerOptions. */
export function deploymentReport(appName: string): (results: readonly DeploymentResult[]) => void
```

— prints a leading blank line then `renderDeployment` output via
`console.log`.

### Wiring it through — generated stack + public package

- `packages/9-public/composer/package.json` gains an export path
  `"./report"` mapping to a new build entry that re-exports
  `deploymentReport` (and `renderDeployment`) from `@internal/cli`'s
  module. Follow the existing per-entry build convention in that package
  (mirror how `./deploy` is produced).
- `generate-stack.ts`'s template adds
  `import { deploymentReport } from '@prisma/composer/report';` and, inside
  the options literal, `report: deploymentReport(<quoted name>),` (the same
  `name` already rendered into options). Snapshot tests in
  `generate-stack.test.ts` update.
- `run-alchemy.ts` and `main.ts` are untouched — rendering happens in the
  child, inside apply.

### PR #101

Close with a comment linking this slice's PR and one sentence: superseded
by the consumer-declared-seams design (ADR-0033); `NodeReport` is
withdrawn.

## A bound S2's review established — the line rendering must not cross

**S2's guard enforces that a producer *declared* a key. It does NOT enforce
that the key resolves to anything real.** Presence-only against lazy proxies
catches a missing key but not a mis-named attribute read: `{ url: svc.typoAttr }`
returns a `PropExpr` — the resource proxy's `get` trap fabricates one for any
absent property (`Resource.ts:283`) — so it is non-`undefined`, passes the
guard, and fails at apply. That is inherent to the seam and consistent with
the guard's own comment; it is not a defect.

**The consequence for S3: rendering must never present a wiring value as
verified.** S2's enforcement is not evidence a wiring value is trustworthy.
This is another reason the reported primitives come from the descriptor
naming them deliberately (`ReportedPrimitive`), resolved by apply, rather
than from anything scraped out of `WiringOutputs`.

## ADR-0033's alchemy appendix gets S3's verified facts

ADR-0033's appendix exists so S2/S3 build on recorded facts rather than
re-deriving them. S3 establishes four more, all probe-verified in D1 —
**append them** (don't restate the seam design; the ADR's decision is
unchanged):

1. An `Action` whose input references a not-yet-created resource **plans**
   and **runs during apply**, after the resources it references.
2. Its runner receives **resolved** values, arbitrarily deep —
   `entries[].primitives[].id` arrives as a real `string`.
3. Alchemy persists the **resolved** input snapshot and hashes *that*
   (`State/ActionState.ts`), noop-ing the action when the hash is unchanged.
   A nonce evaluated at stack-effect time therefore defeats the noop.
4. `Input<T>` maps `readonly T[]` correctly — the object branch is
   homomorphic over a naked type parameter, so elements are mapped and both
   array-ness and `readonly` survive.

Cite against installed source at write time, not against these notes —
S1-D3 found most of `design-notes.md`'s line numbers had drifted.

## Docs debt — S3 owns its own

`.agents/rules/user-facing-surface-changes.mdc` is `alwaysApply: true`.
S3 changes what a user observes on every deploy (a rendered topology
replacing alchemy's dump) and adds a public export path
(`@prisma/composer/report`). **Both `docs/guides/**` and
`skills/prisma-composer/SKILL.md` must be updated in this PR** — a named
condition here because S2's review caught the project silently carrying this
debt with no slice owning it.

## Specification warning inherited from S1 — read before trusting any type here

**A cast in the code this spec is written against is evidence that someone
made a claim, not evidence that the claim was true.** S1 pinned three types
by reading existing casts as type facts and was wrong all three times (see
[../../learnings.md](../../learnings.md)). `DeployedPrimitive`'s split into
resolved + `ReportedPrimitive` already applies the lesson once.

So: **derive every type here from the producing expression, with a probe,
before writing code against it.** Specifically distrust: `deployment.deployedUrl`
and `db.id` (both `Output<string>`, not `string`); anything a declared prop
type appears to promise, since `Input<T>` accepts `T | Output<T>` and will
swallow both truth and lie. If a pinned type here is contradicted, **halt** —
same as S1-D2 did. That halt paid for itself twice.

## Coherence rationale

One reviewer can hold it: one SPI return-type change, five mechanical
descriptor edits, one new pure renderer, one action declaration, one
template line. The alchemy-facing novelty (the Action) is isolated to ~15
lines in `lowering()` with its mechanism documented in the ADR appendix.

## Scope

**In:** everything above.
**Deliberately out:** per-node `ok`/diagnostics (fail-fast decision
pending — the `DeploymentResult` shape deliberately leaves room, adding a
field later is non-breaking); created/updated/noop change status
(CLI-event-only in alchemy — recorded non-goal); any `--json`/parent-process
consumer (future transport, own design); destroy-path reporting (the bin
zeroes actions on destroy — nothing renders, correct).

## Pre-investigated edge cases

| Case | Ruling |
| --- | --- |
| Action noops on unchanged input | Verified `Plan.ts:1069-1082` — hash-compared against prior state. The `Date.now()` nonce forces `run` every deploy. (`Date.now()` is fine here — it's a report trigger, not artifact input; determinism rules govern artifacts.) |
| Graph nodes in action input | FORBIDDEN — plan-time `hashInput` serializes the resolved input; nodes carry functions/Standard Schemas. Addresses + primitives only; the join uses the closure. |
| Output ordering vs alchemy's TUI | The action runs inside the apply session, so the summary may print before alchemy's final status flush. Verify visually in D4; if interleaving is ugly, accepted for this slice and recorded as an upstream ask — do NOT reach for stdout piping. |
| Plan-time `resolveInput` on first deploy | Action inputs referencing not-yet-created resources must still plan (alchemy's own feature contract for actions). D1 includes a probe verifying an action with resource-referencing input plans+runs on a fresh stack; if it fails, STOP → discussion mode (spec amendment), do not improvise a fallback. |
| `Input<T>` vs `readonly` arrays | **Settled by D1's probe: `readonly` works — use it.** `readonly T[]` does fall to `Input<T>`'s object branch, but that branch is homomorphic over a naked type parameter, which TypeScript special-cases over arrays: elements are mapped, array-ness and `readonly` survive. Verified to still reject `id: 42` and excess nested keys. The earlier mutable-array pin was wrong. |
| Deep `Input<>` resolution at runtime | **Settled by D1's probe.** A nested `Output<string>` at `entries[].primitives[].id` — two levels deep — arrives in the runner as a real `string`. This is the claim the whole `ReportedPrimitive`/`DeployedPrimitive` split rests on, and it holds at runtime, not merely at the type level. |
| Nonce vs the action's input-hash noop | **Settled by D1's probe, with a control.** Fresh deploy → ran. Unchanged redeploy + new nonce → ran. Unchanged redeploy + **same** nonce → **did not run**. The third case is what proves the noop is real and the nonce is precisely what defeats it. Alchemy persists the **resolved** input snapshot and hashes that (`State/ActionState.ts`), which is why a `Date.now()` evaluated at stack-effect time is sufficient. |
| `lowering()` unit tests | Sync tests run without `report` and never touch alchemy context; the report path is covered by `joinDeployment` (pure), renderer (pure), generate-stack snapshots, and D4's live deploy. |

## Slice-DoD

- A real deploy of `examples/storefront-auth` (or the dogfood app) prints
  the pinned tree with real ids/URLs after apply, on BOTH a changed and an
  unchanged (all-noop) redeploy.
- No alchemy stack-output blob in the deploy output.
- PR #101 closed with the supersession comment.

## References

- Project spec: [../../spec.md](../../spec.md) · design notes § "The
  corrected execution model".
- alchemy `2.0.0-beta.59`: `src/Action.ts:85-135`, `src/Plan.ts:1040-1100`,
  `src/Apply.ts:1103-1232`, `src/Cli/commands/deploy.ts:171-175`.
- `packages/0-framework/3-tooling/cli/src/generate-stack.ts:50-70`.

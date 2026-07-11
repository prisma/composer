# System Composition — Design Notes

The design lives in ADR-0016 and `docs/design/10-domains/system-composition.md`.
This file records implementation-level calls, the seams, and the points held
for operator confirmation.

## Held for operator confirmation (blocking implementation start)

1. **Breaking `system()` reshape, no legacy form.** `system(name, body)` is replaced
   by `system(name, { deps?, expose? }, body)` with the new body shape
   (`{ inputs, provision }` in, outputs returned). The two existing call
   sites + fixtures migrate; no 2-arg overload survives. Confirm.
2. **Load validation rule set** (system-composition.md § Load): dangling
   declared input; missing/unsatisfied expose return; root-deployed system with
   non-empty deps; forwarding cycles. All hard errors. Confirm the set —
   especially that a *declared but unforwarded* input is an error rather than
   a warning (rationale: a boundary that promises an input it ignores lies to
   its consumers).
3. **Auth-system v1 `db` posture.** Boundary input (needs the resource-slot work
   landed) vs internally owned (works today, boundary is expose-only, `db`
   input added when slots land). The plan is adaptive; confirm which to aim
   at for H3, given the state of the resource-decoupling session.
4. **Resource-slot seam.** The parallel resource-decoupling session defines
   the slot type services (and therefore system boundaries) use for resource
   inputs. Provide its shape (or its branch) when settled so H1's `Deps`
   handling composes with it; H1 proceeds on ConnectionEnd inputs regardless.

## Implementation calls (made here, flag on divergence)

- **`InputRef`** — the body's `ctx.inputs` entries are branded wiring values
  carrying (system identity, input key). During Load, when the enclosing scope
  wires the system's input, the ref resolves to the actual producer; forwarding
  edges are recorded so cycle detection sees through boundaries. The brand
  must satisfy the same `Wiring<D>` assignability as a `RefPort` (an InputRef
  of a contract-typed input carries that contract's `Req`).
- **Body executes during Load only**, exactly once per provision, pure by
  convention (same expectation as today's system body); nothing composition adds
  runs at runtime.
- **Addresses**: parent address + `.` + provision id (existing separator).
  The serializer's config-key derivation already splits on `.` — H1 must
  re-prove key derivation and collision behavior at depth ≥ 2 with tests.
- **`SystemNode<D, E>`** carries the boundary types; stays a plain frozen node
  (body closure excepted, as today). `isNode`/brand unchanged.
- **Bundle keys** (H2): the full dot-joined address, since provision ids are
  only unique per scope.
- **Workspace-package system** (H3): built via its own `build` script at repo
  build time (turbo), standing in for publish-time building; peer-dep ranges
  declared as they would be for npm.

## Coordination facts (rebase baseline: two branches land first)

**Update (2026-07-10): #21 and #22 are MERGED to main (`c7400ed`).** #21 grew
before landing — it UNIFIED `ConnectionEnd`+`ResourceEnd` into one
`DependencyEnd` (`kind: 'dependency'`; `dependency()` is the slot factory;
`resource()` takes `provides: Contract`; `provision(id, resource)` returns the
contract flattened onto the ref; `Wiring<D>` uniform; `Edge.kind` =
`'input'|'dependency'`; new `topoSort`/`assertDependencyDag`/id-checks) and also
carried the deploy-state/lock layer (ADRs 0009–0012). H1 was PORTED onto that
unified model — the connection/resource branching below collapsed to one
`satisfies()` check, and resource-slot forwarding across a system boundary now
works (no `never` soft-block). The system-boundary ADR renumbered to **0014** (#21
took 0009–0013). The pre-unification detail below is retained for history.

System-composition rebases onto BOTH, in this order:

**PR #21 — resource decoupling** (`claude/resource-dependency-declaration-52bb98`).
Landed shapes H1/H2/H3 compose with: `provision<T>(id, resource: ResourceNode<T>):
ResourceRef<T>` (appended FIRST in the overload set); `Deps` =
`ResourceEnd | ConnectionEnd` (`ResourceNode` removed — member swap, not
additive); `ResourceNode` reshaped identity-only with literal `T`; `Wiring<D>` =
intersection adding required `ResourceRef<NoInfer<T>>` entries; `loadSystem`
RESTRUCTURED (`Provisioned.node: ServiceNode | ResourceNode`, `byId` map,
kind-branched wiring loop, new `'resource'` edge kind, resources as top-level
graph nodes); serializer unchanged. H1 already shapes to this: `InputRef` is
connection-contracts-only; forwarded refs dereference to real producer
addresses before the wiring backstops; producer tracking is an id→node map.

**PR #22 — always-system root** (`claude/delete-example-apps-f54df6`). The deploy
root MUST be a system; a bare `compute()` service is no longer independently
deployable — Load rejects a non-system root with a "wrap it in a system" error. This
is a DECISION, not drift. Consequences already merged on #22's line (do NOT
re-implement or duel-edit): the service-root pipeline path is gone (singular
`bundle` shape, `isSystemRoot` branching, `resolveBundle` removed — baseline is
bundles-keyed-by-address only); ADR-0007, deploy-cli.md, core-model.md amended;
`examples/prisma-app-hello` and the smoke example DELETED, and the e2e workflow's
hello job (Deploy/Redeploy-noop/Destroy) removed with them.

**Operator-owned, do NOT touch on our branch:** the ADR-0003 amendment. Its
lines 79–89 still bless "a self-contained service deploys as a complete
standalone application" — now false under always-system-root. The operator amends
it on the #22 line (reframing the operational root as always a system, keeping the
unwired-connection-input guidance). H-series text that leaned on the
standalone-service promise: none survives in our docs (checked); any that
appears at rebase is updated in lockstep, not independently.

**Rebase fallout for H2/H3 fixtures & proofs:**
- `prisma-app-hello` no longer exists — repoint any fixture/smoke reference to
  `examples/storefront-auth` (the surviving system example) or stand up a minimal
  single-service system where a smaller fixture is wanted.
- The redeploy-noop CI proof is GONE by design (couldn't live on
  storefront-auth's non-deterministic Next build). Redeploy idempotency is a
  Deployment-provider property (`artifactHash`-keyed) — its replacement is a
  `prisma-alchemy` unit test, a follow-up, NOT a live-cloud e2e. Do not
  reintroduce a noop assertion into the workflow.
- Baseline to code against: always-system root, bundles-keyed-by-address only.

## Risks

- **Parallel-session collision** on `node.ts`/`graph.ts` — coordinate rebase
  order with the operator; H1 should not start until the resource-decoupling
  session's landing plan is known.
- **Type-level cost** of `SystemContext`/`Wiring` inference at depth — R6's
  contract types are already heavy; type-level tests must include a
  three-level nesting case to catch instantiation-depth surprises early.
- **Address depth vs config-key limits** — env-var name length is finite;
  deep nesting produces long keys. H1 tests document the practical bound
  rather than discovering it in production.

## Extension-config redesign (2026-07-10, operator-ruled)

Node-owned loads (was ADR-0017) failed empirically: `import(this.targetModule)`
resolves from CORE's location; core depends on no extension, so the live e2e
deploy died at `Cannot resolve the target module "@prisma/app-cloud/target"`
while the same specifier resolves fine from the app root. Two prior designs on
this seam also failed or were rejected (entry-anchored `createRequire` paths:
rejected — manual path anchoring; loader thunk with a literal import: breaks
the bundler firewall).

Ruling: adopt prisma-next's control/execution-plane split verbatim.
`prisma-app.config.ts` at the app root (c12, walk-up discovery — see
prisma-next `config-loader/src/load.ts` and `PrismaNextConfig` descriptors)
statically imports **extension** descriptors; registries keyed by
(extension ID, node ID) = the node's `extension` (renamed from `pack`) +
`type`. The **target concept dies** (no fromEnv, no one-target rule; mixed
platforms per app intended; providers compose; ONE explicit `state:` — the
alchemy state ledger is platform-agnostic). Nodes revert to pure data.
Terminology: "extension" everywhere. Full spec:
`slices/extension-config/spec.md`. Changing recorded decisions is fine —
rewrite/delete ADRs; do not preserve superseded designs out of reverence.

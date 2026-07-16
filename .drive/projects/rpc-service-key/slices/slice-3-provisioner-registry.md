# Slice 3 — provisioner registry (refactor slice 2's facet)

Replaces slice 2's `ConfigParam.autoProvision: 'per-binding-key'` string facet
with the opaque-need + target-registry mechanism of
[ADR-0031](../../../docs/design/90-decisions/ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md).
Behaviour is identical end to end (same live proof); only how a provisioned
param is *identified and resolved* changes. Refactor from the green slice-2 base
(PR #93) — it lands by amending #93, so the facet→registry churn squashes away.

## The mechanism (build exactly this)

Two moves, mirroring `secretSource` (opaque branded slot) and node descriptors
(checked registry with loud resolution):

1. Core carries **one** opaque field — `ConfigParam.provision?: ProvisionNeed` —
   and never another. The `autoProvision` union is deleted.
2. The target **registers** a provisioner under the need's brand; **core**
   resolves the brand against the *consumer's* extension registry and mints each
   edge's value, failing the deploy loudly on an unregistered brand or a
   cross-extension edge.

### Core — `@internal/core`

**`node.ts`** — a new opaque branded need, copied from `SecretSource`/`secretSource`/`isSecretSource` (same file, ~line 35):

```ts
const PROVISION_NEED: unique symbol = Symbol.for('prisma:provision-need');
/** A param value the framework mints. Opaque to core: it forwards the payload to the resolved provisioner and never reads it. */
export interface ProvisionNeed<T = unknown> {
  readonly [PROVISION_NEED]: true;
  /** Selects the provisioner in an extension's `provisions` registry. */
  readonly brand: symbol;
  /** Provisioner-defined; core never reads it. */
  readonly payload: T;
}
export function provisionNeed<T = undefined>(brand: symbol, payload?: T): ProvisionNeed<T> { … }
export function isProvisionNeed(v: unknown): v is ProvisionNeed { … }
```

**`config.ts`** — replace the facet: delete `autoProvision` from `ConfigParam`, `ParamOptions`, and `withFacets`; add `readonly provision?: ProvisionNeed` to `ConfigParam` + `ParamOptions`, copied through `withFacets` (spread-when-defined, same as `optional`/`default`). Keep `serviceKey` `optional: true` (a provider with zero consumers still leaves nothing to fill, and boot stays lenient).

**`app-config.ts`** — `ExtensionDescriptor` gains:
```ts
/** Param provisioners this extension supplies, keyed by need brand (ADR-0031). Core resolves a param's ProvisionNeed against the CONSUMER extension's map. */
readonly provisions?: ReadonlyMap<symbol, ProvisionerDescriptor>;
```

**`deploy.ts`** — the provisioner hook + a provision phase in `lowering()`:

```ts
export interface ProvisionerDescriptor {
  /** Mint one stable value for one faceted edge; yields the platform resource, returns an opaque ref core forwards into config. */
  provision(ctx: ProvisionEdge): Effect.Effect<unknown, LowerError>;
}
export interface ProvisionEdge {
  readonly edgeId: string;          // `${consumerAddress}.${input}` — stable resource key
  readonly consumerAddress: string;
  readonly providerAddress: string;
  readonly input: string;
  readonly need: ProvisionNeed;     // opaque payload forwarded to the provisioner
}
```

In `lowering()`, **after** the `application` hooks and **before** the node loop:
- Enumerate provision edges: every `dependency` edge whose consumer input's connection params contain a param with a `provision` need.
- For each, resolve `need.brand` in the **consumer node's** extension's `provisions` map. Two loud failures (new `LowerError`s, symmetric with `unknownNodeTypeError`):
  - brand not in that extension's `provisions` → `unknownProvisionerError(brand, edgeId)`.
  - consumer and provider nodes have different `extension` → `crossExtensionProvisionError(edgeId)` ("cross-extension provisioned edges aren't supported yet").
- Invoke the resolved `provisioner.provision(edge)` → ref; store in a `provisioned: Map<string, unknown>` keyed by `edgeId`.
- Add `provisioned` to `LowerContext` (alongside `application`, `lowered`).

**`buildConfig`** — when resolving a connection param that carries a `provision` need, source its value from `provisioned.get(edgeId)` (the minted ref) instead of the producer node's outputs. This *fills* the consumer's param through the normal channel — so the consumer's env var is written by the existing param loop, and slice 2's target-side consumer block disappears. `buildConfig`'s signature gains the `provisioned` map.

### rpc — `@internal/rpc`

- Define and export the brand + need constructor:
  ```ts
  export const RPC_PEER_KEY: unique symbol = Symbol.for('prisma:rpc/per-binding-key');
  export const perBindingToken = () => provisionNeed(RPC_PEER_KEY);
  ```
- `rpc()`: `serviceKey: string({ optional: true, provision: perBindingToken() })`.

### Target — `@internal/prisma-cloud`

- **Provisioner impl** — wrap the existing `ServiceKey` resource as a `ProvisionerDescriptor`: `provision(edge)` yields `Prisma.ServiceKey(\`servicekey-${edge.edgeId}\`, {})` and returns `.value`. The mint (32-byte hex) + stability stay in the `ServiceKey` resource, unchanged — **keep the resource id scheme identical (`servicekey-${edgeId}`) so existing deploys don't re-mint keys.** This impl is generic (executes the need; doesn't branch on RPC); it's merely *registered* under RPC's brand.
- **`control.ts`** — register it: `provisions: new Map([[RPC_PEER_KEY, serviceKeyProvisioner]])` (import `RPC_PEER_KEY` from `@internal/rpc`). **Remove** the `application.provision` service-key minting (core mints now); the DATABASE_URL poison stays.
- **`descriptors/compute.ts` serialize** — **remove** the consumer-side block (core fills the param via `buildConfig`). **Keep** the provider-side accepted-set block, but source refs from `ctx.provisioned` (find this node's inbound provisioned edges via `ctx.graph`) instead of the old application-outputs map. Encoding (JSON array via `Output.all`/`map`) and the env var name stay here — landing is the target's (ADR-0019).
- **`compute.ts` run()** — unchanged (still re-stashes the accepted-keys var address-free).
- **`service-keys.ts`** — `serviceKeyEdges()` now detects a faceted edge by `param.provision?.brand === RPC_PEER_KEY` (not the deleted string). Still used by the provider-side serialize; core's generic enumeration is separate (core keys off *any* `provision` need, not RPC's brand).

## Tests

- **Core**: `ProvisionNeed` opacity (core never reads payload); provision-phase resolution — a need whose brand isn't registered fails with `unknownProvisionerError`; a cross-extension provisioned edge fails with `crossExtensionProvisionError`; a resolved edge mints once and fills the consumer param in `buildConfig`.
- **rpc**: `serviceKey` carries `provision: perBindingToken()` with brand `RPC_PEER_KEY`; the facet field is gone.
- **Target**: the serialize end-to-end tests from slice 2, retargeted — consumer key + provider accepted-set still written, values trace to the `ServiceKey` resource; the provider set has both keys for two consumers; **resource ids unchanged** from slice 2.
- Delete slice 2's `autoProvision`-specific assertions.

## Live proof (unchanged DoD)

Redeploy `examples/storefront-auth`: round trip 200, anonymous 401, no-op redeploy
stable — **and confirm the second deploy against a slice-2-provisioned stack is a
no-op** (resource ids stable ⇒ keys not re-minted across the refactor). Destroy.

## Landing

Amend PR #93 on `claude/rpc-service-key-slice2`: the facet commit + this refactor
commit squash-merge to one clean commit shipping the registry design. Retitle #93
to drop "slice 2 = facet"; update its body to ADR-0030 + ADR-0031. Re-verify CI +
live, then re-arm auto-merge.

# Slice 2 — deploy provisioning (turn the key on end-to-end)

Wires slice 1's inert enforcement to real, auto-provisioned per-binding keys, and
proves it with a live deploy. Spans core (one facet), the rpc authoring package
(set the facet), the Prisma Cloud target (mint + wire), and the lowering (a new
resource).

## Design (settled — build exactly this)

**Mint once per edge, both ends read the same value.** For each RPC dependency
edge (consumer→provider), one stable random key is minted at deploy and held in
deploy state. The consumer gets *its* key on the existing `serviceKey` connection
param (slice 1); the provider gets the *set* of its inbound edges' keys in a
reserved var `serve()` already reads.

Data flow, all inside the Prisma Cloud extension except the facet:

1. **Facet (core, generic).** A connection param can be marked auto-provisioned.
   `rpc()` sets it on `serviceKey`. The target reacts to the facet, never to
   "rpc" — keeps ADR-0030's "not RPC-special-cased" promise.
2. **Mint in the application pre-pass.** `prismaCloud().application.provision`
   (runs once, graph-wide, before every node) enumerates faceted edges and mints
   one `ServiceKey` resource per edge, exposing them in its outputs. Both ends
   reach these via `ctx.application` — no cross-node ordering concerns.
3. **Consumer serialize** writes its edge's key to its `serviceKey` env var.
4. **Provider serialize** writes the JSON-array of its inbound edges' keys to the
   reserved accepted-keys var.
5. **Provider `run()`** re-stashes that var address-free so `serve()` reads it.

### 1. `ServiceKey` resource — NEW `packages/1-prisma-cloud/0-lowering/lowering/src/compute/ServiceKey.ts`

Copy `packages/1-prisma-cloud/1-extensions/target/src/s3-credentials-resource.ts`
almost verbatim — same mint-once-stable lifecycle:

```ts
export type ServiceKeyProps = Record<never, never>;
export interface ServiceKeyAttributes { readonly value: string }
export type ServiceKey = Resource<'PrismaCloud.ServiceKey', ServiceKeyProps, ServiceKeyAttributes>;
export const ServiceKey = Resource<ServiceKey>('PrismaCloud.ServiceKey');

/** A fresh 256-bit key as 64 lowercase hex chars (Web Crypto — no node import). */
export function mintServiceKey(): ServiceKeyAttributes {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return { value: Array.from(b, x => x.toString(16).padStart(2, '0')).join('') };
}

export const serviceKeyProviderService: Provider.ProviderService<ServiceKey> = {
  list: () => Effect.succeed([]),
  reconcile: ({ output }) => Effect.sync(() => output ?? mintServiceKey()),  // stable across redeploys
  delete: () => Effect.void,
};
export const ServiceKeyProvider = () => Provider.effect(ServiceKey, Effect.succeed(serviceKeyProviderService));
```

- Export `ServiceKey`, `ServiceKeyProvider`, `mintServiceKey` from `compute/index.ts` and the lowering package `src/index.ts` (mirror how `S3Credentials`/`EnvironmentVariable` are exported).
- Register `ServiceKeyProvider()` in `target/src/control.ts`'s `providers()` `Layer.mergeAll(...)`.

### 2. The facet — core `packages/0-framework/1-core/core/src/config.ts`

- `ConfigParam`: add `readonly autoProvision?: 'per-binding-key';` (opaque to core).
- `ParamOptions`: add the same optional field; `withFacets` copies it through exactly like `optional`/`default` (spread only when defined).
- No other core change. `buildConfig` still leaves the faceted param `undefined` (no producer output named `serviceKey`); slice 1's serialize-skip handles that; the consumer serialize below writes the real value.

### 3. `rpc()` — `packages/0-framework/2-authoring/rpc/src/rpc.ts`

`serviceKey: string({ optional: true, autoProvision: 'per-binding-key' })`.

### 4. Edge helper + minting — `target/src/control.ts` application.provision

A shared helper (put in a new `target/src/service-keys.ts`, imported by both control.ts and compute.ts):

```ts
/** Faceted RPC edges as { edgeId, consumerAddress, input, providerAddress }. edgeId = `${consumerAddress}.${input}`. */
export function serviceKeyEdges(graph: Graph): ServiceKeyEdge[] { /* scan graph.edges; for each dependency edge, read the consumer node's inputs[input].connection.params.serviceKey?.autoProvision === 'per-binding-key' */ }
export const serviceKeyEnvName = (address: string) => configKey(address, { owner: 'service', name: 'RPC_ACCEPTED_KEYS' }); // COMPOSER_<addr>_RPC_ACCEPTED_KEYS
```

In `application.provision`, after the DATABASE_URL poison, mint one `ServiceKey`
per edge and add to the returned outputs:

```ts
const serviceKeys: Record<string, Output<string>> = {};
for (const e of serviceKeyEdges(graph)) {
  const key = yield* Prisma.ServiceKey(`servicekey-${e.edgeId}`, {});
  serviceKeys[e.edgeId] = key.value;      // an alchemy Output<string>
}
return { outputs: { projectId, serviceKeys } };
```

(`graph` is on the application `ctx`.) Keep the existing `projectId` output.

### 5. compute serialize — `target/src/descriptors/compute.ts`

`serialize` already gets `ctx`; destructure `id`/`address`/`graph`/`application`
from it. After the existing param + secret loops, add TWO blocks. Import
`Output` from `alchemy/Output`.

**Consumer side** — for each of this node's own inputs whose `serviceKey` param
carries the facet, write the key from the pre-pass:

```ts
for (const input of autoProvisionInputs(node)) {           // inputs with a faceted serviceKey param
  const edgeId = `${address}.${input}`;
  const keyOut = (application.outputs['serviceKeys'] as Record<string, Output<string>>)?.[edgeId];
  if (keyOut === undefined) continue;                       // no key minted (shouldn't happen for a wired edge)
  const key = configKey(address, { owner: { input }, name: 'serviceKey' }); // COMPOSER_<addr>_<input>_SERVICEKEY
  records.push(yield* Prisma.EnvironmentVariable(`${key}-var`, { projectId, key, value: keyOut, class: cls, ...branch }));
}
```

**Provider side** — if any faceted edge has `providerAddress === address`, write
the accepted set:

```ts
const inbound = serviceKeyEdges(graph).filter(e => e.providerAddress === address);
if (inbound.length > 0) {
  const keyOuts = inbound.map(e => (application.outputs['serviceKeys'] as ...)[e.edgeId]);
  const acceptedJson = Output.map(Output.all(...keyOuts), (vals) => JSON.stringify(vals));
  const key = serviceKeyEnvName(address);                   // COMPOSER_<addr>_RPC_ACCEPTED_KEYS
  records.push(yield* Prisma.EnvironmentVariable(`${key}-var`, { projectId, key, value: acceptedJson, class: cls, ...branch }));
}
```

`Output.all(...outs)` + `Output.map(all, JSON.stringify)` resolve at apply to the
JSON array `serve()` parses. Do NOT route either var through `paramEntries` — they
are written directly here.

### 6. compute `run()` — `target/src/compute.ts`

The accepted-keys var is address-scoped at deploy; `serve()` reads it address-free
(one service per instance, same as config). In `run()`, after `stashSecrets`, add:

```ts
const accepted = process.env[serviceKeyEnvName(address)];
if (accepted !== undefined) process.env[serviceKeyEnvName('')] = accepted; // COMPOSER_RPC_ACCEPTED_KEYS
```

`serviceKeyEnvName('')` === slice 1's `RPC_ACCEPTED_KEYS_ENV`
(`COMPOSER_RPC_ACCEPTED_KEYS`). Assert this equality in a test so the writer and
reader can't drift (import the constant from `@internal/rpc`).

## Tests

- **Lowering** — `ServiceKey` resource: `reconcile` mints on first create, returns
  `output` unchanged on redeploy (mirror the S3Credentials test).
- **Target serialize** (`control-lowering.test.ts` harness) — a two-service graph
  (consumer with `rpc()` dep on a provider): assert the consumer gets a
  `COMPOSER_<consumer>_<input>_SERVICEKEY` row, the provider gets a
  `COMPOSER_<provider>_RPC_ACCEPTED_KEYS` row, and the values trace back to the
  minted `ServiceKey`(s). Two consumers of one provider → two distinct edge keys,
  provider's set has both.
- **run() stash** — address-scoped accepted var re-emits address-free under
  `RPC_ACCEPTED_KEYS_ENV`.
- **rpc()** — the `serviceKey` param carries `autoProvision: 'per-binding-key'`.

## Live proof (the DoD)

Deploy `examples/storefront-auth` (has a web→auth rpc edge):
- Wired round trip still returns `ok` (the web app calls auth with its key).
- A direct `curl -XPOST https://<auth-url>/rpc/verify -d '{...}'` with no/junk
  bearer → `401`.
- Second redeploy re-versions nothing (keys stable in state; no-op holds).

Use `~/.config/prisma-compose/deploy.env` for creds
(`PRISMA_DEPLOY_ENV=~/.config/prisma-compose/deploy.env`, never print values).

## Sequencing / safety

The end state has every provider carrying an accepted set, so enforcement is
always active. Decide with the live behaviour in front of us whether a provider
with zero consumers (empty set) should deny all external calls; ship as-is
(empty set = pass-through) if unsure, and note it.

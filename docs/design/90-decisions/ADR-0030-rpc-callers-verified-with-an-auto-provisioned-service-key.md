# ADR-0030: RPC callers are verified with an auto-provisioned per-binding service key

## Decision

Every RPC binding carries a distinct, framework-minted **service key** — an
unguessable random value the deploy provisions automatically. The consumer's
generated client sends it on every call; the provider's `serve()` handler
rejects any request that doesn't carry one of the keys issued to its callers,
before it dispatches. Nothing in application code declares, names, reads, or
even sees the key.

```ts
// Provider — unchanged authoring. serve() now refuses a caller that
// doesn't present a key issued to it (401), before any handler runs.
export const api = compute({ name: 'api', expose: { orders }, /* … */ });
export default serve(api, { orders: { place: async (input, deps) => /* … */ } });

// Consumer — unchanged authoring. The hydrated client attaches the key
// on every call; the developer never touches it.
const client = orders;                 // rpc(orders) dependency, hydrated
await client.place({ sku, qty });      // sends Authorization: Bearer <service-key>
```

The key rides the **same wire the binding's URL already rides**: it is a second
connection parameter on the RPC dependency (`serviceKey`, alongside `url`),
serialized to a reserved `COMPOSER_*` environment variable and hydrated into the
client through the framework's host shim — the developer's code never reads the
environment (see the *No globals* principle). Its value is minted at deploy and
kept in the hosted deploy state store, so it is stable across
redeploys and never appears in the Prisma Cloud project's own variable list.

## Reasoning

A Prisma Compute service is reachable at a public HTTPS URL. Transport is
already encrypted, but nothing stops an anonymous request on the internet from
reaching an exposed `/rpc/<method>` endpoint. We want the provider to answer
only its **wired peers** — the services this application actually connected to
it — and to turn away everyone else. The bar is deliberately low: prove "you are
a service this app wired to call me," not "you are a specific principal with
specific rights." An unguessable shared value does exactly that and no more.

**Why a distinct key per binding, not one per provider.** The natural cheap
design gives each provider a single key that all of its consumers share. We go
finer: each consumer→provider edge gets its own key. The wiring cost is small —
the provider validates an incoming key against the *set* of keys it issued
(a constant-time membership check) instead of against a single value — and it
buys real least-privilege: two consumers of the same provider hold different
keys, so one leaking its key never lets it impersonate the other, and a single
edge can be rotated without touching the rest. A consumer only ever physically
holds keys for the providers it declared as dependencies, so an application can
never reach a provider it wasn't wired to — that property holds at either
granularity, but per-binding is the one that also isolates peers from each
other.

**Why it is not a secret in the ADR-0029 sense.** [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md)
draws a hard line: for a real secret, the framework carries the *name* and never
the *value* — the value is provisioned out of band and injected by the platform,
so it never lands in deploy state, generated programs, or logs. A service key is
different in kind. It is not a credential protecting data at rest; it is a
per-deployment capability token whose only job is to separate a wired peer from
an anonymous caller over an already-encrypted channel. That lower bar lets the
framework do the thing ADR-0029 forbids for secrets: **mint the value itself and
keep it in deploy state.** The deploy state store is the framework-owned
`prisma-composer-state` database in the stage's Branch (ADR-0034) — not a
resource a developer declares or reads — so the value stays out of the surface
a developer works with, and "transient state for this deployment" is exactly
what it is.

**Why the env-var rail, not the artifact.** The value has to reach both running
instances. A Compute version takes its environment from the project's config
variables — there is no version-scoped env channel — so the only two doors into
a running instance are a project environment variable or a file baked into the
deploy artifact. Baking it in keeps it out of the project's variable list, but a
per-deploy value baked into the artifact changes the artifact's hash on every
deploy, which breaks no-op-redeploy detection, and it splits one value across two
independently built artifacts. The env-var rail is the one the binding's URL
already uses, it keeps the artifact reproducible, and one more reserved
`COMPOSER_*` variable is consistent with the config the framework already writes
there. The value being visible to someone with project access is acceptable
given what the value is.

**Why enforcement lives in `serve()` and the client, not in a proxy.** The RPC
kind already owns both ends of the wire — `serve()` generates the provider's
fetch handler and `makeClient` generates the consumer's. Attaching the key on
the way out and checking it on the way in is a few lines at each end, needs no
new network hop, and keeps the check adjacent to the dispatch it guards. The
provider compares with a constant-time equality so the check itself leaks
nothing about which keys are valid.

**Where the per-binding value comes from.** A binding's URL is a single value the
provider produces and every consumer copies — it flows cleanly as one provider
output. A per-binding key cannot: each consumer needs a *different* value, so it
is not a provider output at all but a value scoped to the *edge*. The framework
mints one key per RPC edge at deploy, wires that edge's key into the consumer's
`serviceKey` connection parameter, and aggregates every inbound edge's key into
the provider's accepted-set variable. The `serviceKey` param declares this as a
**provisioning need** ([ADR-0031](ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md)):
an opaque, branded value core forwards to whichever provisioner the deploy target
registers under that brand. So the mechanism is generic — core never learns what
an RPC is, and the target's per-edge provisioner never learns it either; RPC only
supplies the brand and the wire contract.

## Consequences

- An RPC provider answers only wired peers. An anonymous or wrong-key request
  gets `401` before any handler runs. This is on by default for every RPC
  binding; there is no opt-in and no authoring change.
- The key's value lives in deploy state. Anyone who can read the workspace's
  deploy state, or the provider's project environment, can read a key. That is
  the accepted bound: a service key gates access, it does not protect data.
- Rotation is: destroy the edge's key (or the binding) and redeploy, which mints
  a fresh value. Because both ends are wired from the same deploy, they are never
  out of step mid-rotation.
- The provider carries one accepted key per inbound RPC edge. Adding a consumer
  re-versions the provider, because the provider must learn the new caller's key
  — the correct behavior, not a surprise.
- The key authorizes at the service level, not per method: `serve()` flattens
  every exposed contract into one `/rpc/<method>` namespace, so a valid key
  reaches every method on the service. Per-method scoping is a separate authz
  feature and is out of scope; a provider that wants two independently gated
  surfaces exposes two services.

## Alternatives considered

- **One key per provider, shared by all its consumers.** Simpler — the key is a
  plain provider output that flows exactly like the URL, and the provider checks
  a single value. Rejected because it gives up per-peer isolation for a wiring
  saving that turned out to be small: a set-membership check and per-edge minting
  are not much more than a scalar and one mint.
- **A real ADR-0029 secret.** Model the key as a `secret()` need bound to a
  platform variable. Rejected: ADR-0029 secrets are provisioned out of band —
  there is no path for the framework to *mint* the value, which is the whole
  ask — and the redaction/pointer machinery is weight this capability token
  doesn't need.
- **Bake the key into the deploy artifact.** Keeps it out of the project's
  variable list. Rejected: a per-deploy value in the artifact changes its hash
  every deploy (breaking no-op redeploys) and would have to be injected into two
  separately built artifacts. The predictable, reproducible choice is the env
  rail.
- **Per-method capability keys.** Distinct authorization per exposed method.
  Rejected as out of scope: that is an authorization system, well beyond an
  unguessable value, and the same effect is available today by splitting a
  service.

## Related

- [ADR-0031](ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md) —
  the general provisioning-need/registry mechanism this key is the first use of.
- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) — the secret slot this
  qualifies: a service key is a minted, deploy-state value, deliberately *not* a
  name-only secret.
- [ADR-0034](ADR-0034-deploy-state-lives-in-the-stage-branch.md) — the
  per-stage hosted state store the key's value lives in.
- [ADR-0015](ADR-0015-dependencies-resolve-to-bindings-clients-are-app-side.md) —
  the binding the key rides on, alongside the URL.
- [ADR-0019](ADR-0019-the-target-owns-config-serialization.md) — the target owns
  serializing the `serviceKey` parameter and the accepted-set variable.
- The *No globals — all dependencies are injected* architectural principle — why
  the key reaches the client through hydration, never `process.env` in user code.

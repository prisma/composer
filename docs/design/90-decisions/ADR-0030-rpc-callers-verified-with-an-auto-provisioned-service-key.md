# ADR-0030: RPC callers are verified with an auto-provisioned per-binding service key

## Decision

Every RPC binding carries a distinct **service key** — an unguessable value the
deploy **generates** automatically. The consumer's generated client sends it on
every call; the provider's `serve()` handler rejects any request that doesn't
carry one of the keys issued to its callers, before it dispatches. Nothing in
application code declares, names, reads, or even sees the key.

```ts
// Provider — unchanged authoring. serve() refuses a caller that doesn't
// present a key issued to it (401), before any handler runs.
export const api = compute({ name: 'api', expose: { orders }, /* … */ });
export default serve(api, { orders: { place: async (input, deps) => /* … */ } });

// Consumer — unchanged authoring. The hydrated client attaches the key on
// every call; the developer never touches it.
const client = orders;                 // rpc(orders) dependency, hydrated
await client.place({ sku, qty });      // sends Authorization: Bearer <service-key>
```

A service key is a **generated param** (see the glossary's *params and their
sources*): a value the target produces at deploy from information the wiring
supplies — here, the RPC edge — and keeps in deploy state so it is stable across
redeploys. It rides the same wire the binding's URL already rides: a second
connection parameter on the RPC dependency (`serviceKey`, alongside `url`),
serialized to a reserved `COMPOSER_*` variable and hydrated into the client
through the framework's host shim. It is **not a secret** (below): the framework
generates it and stores it, which is exactly what a secret must never be.

## Reasoning

A Prisma Compute service is reachable at a public HTTPS URL. Transport is
encrypted, but nothing stops an anonymous internet request from reaching an
exposed `/rpc/<method>` endpoint. We want the provider to answer only its
**wired peers** and turn away everyone else. The bar is deliberately low: prove
"you are a service this app wired to call me," not "you are a specific principal
with specific rights." An unguessable shared value does exactly that and no more.

**Why a distinct key per binding, not one per provider.** The cheap design gives
each provider a single key all consumers share. We go finer: each
consumer→provider edge gets its own. The wiring cost is small — the provider
validates an incoming key against the *set* it issued (a constant-time
membership check) — and it buys real least-privilege: two consumers hold
different keys, so one leaking never lets it impersonate the other, and a single
edge rotates without touching the rest.

**Why it is a generated param, not a secret.** A secret ([ADR-0029]) is
environment-sourced: the framework carries its *name* and never its value, so
the value never lands in deploy state. A service key is the other family
entirely. There is no external holder to reference — the framework itself
produces the value — so it must be stored to be stable, and it lives in deploy
state by design. That makes it a config param the system generates and owns, not
a secret. It is redactable for display if we choose, but redaction is a facet;
it does not make a generated value a secret. The deploy state store is the
framework-owned `prisma-composer-state` database in the stage's Branch
([ADR-0034]) — not a resource a developer declares or reads — so "transient
state for this deployment" is exactly what it is.

**Why the env-var rail, not the artifact.** The value has to reach both running
instances. A Compute version takes its environment from the project's config
variables, so the two doors into a running instance are a project variable or a
file baked into the artifact. A per-deploy value baked in changes the artifact's
hash every deploy (breaking no-op-redeploy detection) and splits one value
across two independently built artifacts. The env-var rail is the one the URL
already uses, keeps the artifact reproducible, and one more reserved `COMPOSER_*`
variable is consistent with the config the framework already writes there. The
value being visible to someone with project access is acceptable given what it
is: a peer-vs-anonymous gate, not data protection.

**Why enforcement lives in `serve()` and the client.** The RPC kind owns both
ends of the wire — `serve()` generates the provider's handler, `makeClient` the
consumer's. Attaching the key on the way out and checking it on the way in is a
few lines at each end, needs no new hop, and keeps the check adjacent to the
dispatch it guards. The provider compares with constant-time equality so the
check leaks nothing about which keys are valid.

**Where the per-binding value comes from.** A binding's URL is one value the
provider produces and every consumer copies. A per-binding key cannot be a
provider output — each consumer needs a *different* value, scoped to the *edge*.
The framework generates one key per RPC edge at deploy, wires that edge's key
into the consumer's `serviceKey` parameter, and aggregates every inbound edge's
key into the provider's accepted-set variable. `serviceKey` is a **generated
param** ([ADR-0042]'s generated source, the generic mechanism formerly framed as
a provisioning need in [ADR-0031]): an opaque, branded value core forwards to
whichever generator the target registers under that brand. Core never learns
what an RPC is; the target's per-edge generator never learns it either. RPC
supplies only the brand and the wire contract.

## Consequences

- An RPC provider answers only wired peers; an anonymous or wrong-key request
  gets `401` before any handler runs. On by default, no authoring change.
- The key's value lives in deploy state. Anyone who can read the workspace's
  deploy state, or the provider's project environment, can read a key — the
  accepted bound: a service key gates access, it does not protect data.
- Rotation is: destroy the edge's key (or the binding) and redeploy, which
  generates a fresh value. Both ends wire from the same deploy, so they are
  never out of step mid-rotation.
- The provider carries one accepted key per inbound edge. Adding a consumer
  re-versions the provider — the correct behavior, not a surprise.
- The key authorizes at the service level, not per method: `serve()` flattens
  every exposed contract into one `/rpc/<method>` namespace, so a valid key
  reaches every method. Per-method scoping is a separate authz feature, out of
  scope; a provider wanting two independently gated surfaces exposes two
  services.

## Alternatives considered

- **One key per provider, shared by all consumers.** Simpler — a plain provider
  output that flows like the URL. Rejected: it gives up per-peer isolation for a
  small wiring saving.
- **A secret ([ADR-0029]).** Model the key as an environment-sourced secret the
  operator provisions. Rejected: a service key has no external holder — the
  framework must *generate* it, which the secret rail deliberately cannot do
  (a secret's value never enters state). Generating and storing the value is
  the whole ask, and that is what makes it a generated param rather than a
  secret. The redaction/pointer machinery of a secret is also weight this
  peer-gate token doesn't need.
- **Bake the key into the deploy artifact.** Keeps it out of the project's
  variable list. Rejected: a per-deploy value changes the artifact hash every
  deploy and would inject into two separately built artifacts.
- **Per-method capability keys.** Distinct authorization per method. Rejected as
  out of scope: that is an authorization system; the same effect is available by
  splitting a service.

## Related

- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md) — the input model
  and its generated source; what a service key *is*.
- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) — a secret: the
  environment-sourced, never-stored value a service key is deliberately *not*.
- [ADR-0034](ADR-0034-deploy-state-lives-in-the-stage-branch.md) — the per-stage
  state store the key's value lives in.
- [ADR-0015](ADR-0015-dependencies-resolve-to-bindings-clients-are-app-side.md) —
  the binding the key rides on, alongside the URL.
- The *No globals* principle — why the key reaches the client through hydration,
  never `process.env` in user code.

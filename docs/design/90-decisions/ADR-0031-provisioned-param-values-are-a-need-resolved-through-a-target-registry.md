# ADR-0031: A framework-provisioned param value is an opaque need resolved through a target registry

## Decision

Some connection parameters carry a value the **framework mints** rather than a
value a producer node hands over — a per-binding auth token
([ADR-0030](ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md))
is the first. Such a param declares a **provisioning need**: one opaque, branded
value that core forwards but never inspects. The deploy target registers a
**provisioner** under that brand; core resolves the need against the target's
registry, and a need with no matching provisioner fails the deploy loudly.

```ts
// The authoring layer declares a NEED as a value (not a magic string). The
// brand is its own; the payload is whatever its provisioner will read back.
export const RPC_PEER_KEY = Symbol.for('prisma:rpc/per-binding-key');
const serviceKey = string({ optional: true, provision: provisionNeed(RPC_PEER_KEY) });

// The target REGISTERS an implementation under that brand — it *provides* the
// strategy; the declaration only *references* it.
const prismaCloud = { /* ExtensionDescriptor */
  provisions: new Map([[RPC_PEER_KEY, perBindingStableValueProvisioner]]),
  // …nodes, application, providers, preflight
};

// Core resolves: for a faceted edge, look up need.brand in the consumer
// extension's `provisions`. Missing → deploy fails, naming the brand and edge.
```

Core carries exactly **one** field for this — `ConfigParam.provision?: ProvisionNeed` — and never gains another. Everything a strategy varies (how the value is minted, its size, whether it is per-edge or per-provider, how it is kept stable, how a set is encoded, when it rotates) lives inside the opaque need or its provisioner, never as a new field on the param.

## Reasoning

Start from the problem this replaces. The value on this kind of param can't come from where a normal param's value comes from. A normal connection param (a URL) is filled by the producer node's output and copied to every consumer; core's `buildConfig` does that by name. A minted per-binding value has no producer and differs per consumer, so it needs its own source — and that source is target machinery (an Alchemy resource in deploy state), which core, being target-agnostic, cannot contain.

The naive fix is a flag on the param that a target recognizes — `autoProvision: 'per-binding-key'`. That works for one strategy and rots for the next. It is an **enum typed in core**: every future strategy, from any target, widens core's union, which is exactly the shape [ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md) rejected for param *types*. And it is an **unchecked reference**: the string resolves through nothing, so on a target that doesn't implement it the param silently stays empty and the security it was meant to add silently doesn't apply.

Both faults have one cause — a param *naming* a behavior that lives elsewhere, with nothing enforcing the link. The framework already has the right answer twice:

- **Secrets** ([ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md)) make the wiring value a single opaque `SecretSource<T>` — a brand plus a payload core forwards and never reads; the target defines both the constructor and the reader. Core's surface never changed again no matter how many source kinds exist.
- **Node descriptors** ([ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md)) make a node *reference* an implementation by `(extension, type)`; core resolves it through the config's registry and fails loudly on a miss (`unknownNodeTypeError`).

A provisioning need is those two moves applied to a param value. From secrets it takes the **opaque branded slot**: `ProvisionNeed` is a brand plus a payload core never inspects, so core's type never accretes. From node descriptors it takes the **checked registry**: the brand resolves through the extension's `provisions` map, and a need no configured extension satisfies is `unknownProvisionerError`, not a silent no-op. The declarer *provides* a need value and the target *provides* a registered implementation — neither side is a bare string, and the link between them is enforced at deploy.

**The what/how boundary that keeps it at one field.** A param declaration owns the *what* — the semantic contract the declarer needs ("a shared unguessable value, distinct per binding"). The provisioner owns the *how* — mint mechanics, byte length, storage medium, stability across redeploys, rotation schedule. The test for whether something belongs on the param is mechanical: *does core need to read it to do its job?* `optional` and `default` pass — `coerce()` reads them at boot. A provisioning strategy fails — core only forwards it. So "minted on odd days," "64 bytes," "HSM-backed" are never new param fields; they are provisioner policy, invisible to core. This is the rule that answers "how many facets will this accrue?" with *none more*.

**The framework decides what the value is; the target decides where it is stored.** Core enumerates the needs in the graph, resolves each against the **consumer's** extension registry (the consumer is the node that declares the need and must ultimately hydrate the value), invokes the resolved provisioner to mint each edge's value, and threads results into the wiring — the consumer's param is filled like any other input (which removes the need for the value to be an unfilled optional), and the provider is handed its inbound edges' values. Only the storage itself — which environment variable holds the value, and in what encoding — stays the target's, exactly as [ADR-0019](ADR-0019-the-target-owns-config-serialization.md) already assigns it.

**Cross-extension edges fail closed.** A need lives on an edge whose two nodes may belong to two different extensions. Resolving against the consumer's extension is deterministic, but a value minted by one target and validated by another is a cross-target contract with no second target yet to prove it against. Rather than guess that shape, core rejects a provisioned edge that spans two extensions with a clear "not supported yet" error. The registry and the resolution rule are designed so that lifting this restriction later adds a code path, not a redesign.

## Consequences

- Core's provisioning surface is fixed at one opaque field and one registry; new strategies never touch core.
- A provisioned param on a target that doesn't register its brand fails the deploy with a named error, instead of silently shipping an unprovisioned (e.g. unauthenticated) endpoint.
- The provisioner owns mint, size, stability, aggregation, and rotation; changing any of them is a target-only change.
- A provisioned edge that crosses two extensions is a loud, deliberate deploy error until multi-target provisioning is designed.
- The declaring package owns the brand and the need constructor; the serving target imports the brand to register under it — the same writer/reader-share-a-key discipline the config channel already uses.

## Alternatives considered

- **A named facet on `ConfigParam`** (`autoProvision: 'per-binding-key'`). Rejected: an enum typed in core that every strategy widens, and an unchecked reference that fails open. This ADR exists to replace it.
- **A `default`-style value or mint callback at the declaration.** A `default` is plane-free — one value, no state, no coordination. A provisioned value is a deploy-plane artifact: per-edge cardinality, persisted state, two-ended distribution — none of which a value or a lone callback can express, and none of which the declaration site (below the target, unable to touch deploy state) could provide. A callback would supply the trivial part and leave cardinality and wiring to an unnamed rule — the same strategy with the name erased.
- **A framework-mutable registry targets push into at import time.** Rejected for the reason ADR-0017 rejected ambient node registration: import-order-dependent global state. The registry is declared on the `ExtensionDescriptor` the config statically lists; core owns resolution.
- **Full cross-target value threading now.** Deferred: no second target exists to design it against; fail closed instead.

## Related

- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) — the opaque branded slot this reuses; a secret's value is sourced out-of-band, a provisioned value is minted by the framework.
- [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md) — the statically-listed registry with loud resolution this extends from nodes to param provisioners.
- [ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md) — the no-enum-in-core principle applied to provisioning strategies.
- [ADR-0019](ADR-0019-the-target-owns-config-serialization.md) — where a value is stored (which environment variable, in what encoding), which stays the target's.
- [ADR-0030](ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md) — the first need: RPC's per-binding service key.

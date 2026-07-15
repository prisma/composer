# Spec — RPC service keys

## Purpose

A Prisma Compute service is reachable at a public HTTPS URL, so an exposed
`/rpc/<method>` endpoint answers anyone on the internet. Make an RPC provider
answer only its **wired peers**: the consumers this application actually
connected to it. The framework mints a distinct unguessable **service key** per
RPC binding at deploy, the client sends it, the provider checks it. No authoring
change; on by default.

The design decision and its rationale are recorded in
[ADR-0030](../../../docs/design/90-decisions/ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md).
This spec is the build contract for it.

## Requirements

1. **Client attaches, server verifies.** The consumer's hydrated RPC client
   sends its binding's key on every call as `Authorization: Bearer <key>`.
   `serve()` rejects a request whose bearer token is not one of the keys issued
   to the provider's callers with `401`, before it parses the body or dispatches.
   The comparison is constant-time.
2. **Per binding.** Each consumer→provider RPC edge gets a distinct key. The
   provider verifies against the *set* of keys issued to its inbound edges
   (membership), not a single value.
3. **Auto-provisioned, no authoring surface.** The developer never declares,
   names, reads, or sees the key. It is minted at deploy and wired to both ends
   by the framework.
4. **Rides the binding's env rail.** The consumer's key is a `serviceKey`
   connection parameter alongside `url`, serialized to a reserved `COMPOSER_*`
   variable and hydrated into the client through the host shim — never read from
   `process.env` in user code (No-globals principle). The provider's accepted set
   is a reserved `COMPOSER_*` variable read by `serve()` through the same shim.
5. **Value in deploy state, stable across redeploys.** The key is minted once per
   edge and held in the workspace-hosted deploy state store, not the user-facing
   Prisma Cloud project. A no-op redeploy stays a no-op (the key doesn't churn);
   the two ends never disagree mid-deploy.
6. **Generic, not RPC-special-cased in core/target.** Core and the Prisma Cloud
   target handle "a connection parameter auto-provisioned per binding" as a
   generic facet. Only the `@internal/rpc` package knows this facet means "RPC
   peer key" and enforces it on the wire.

## Non-goals

- **Per-method / per-contract authorization.** The key gates at the service
  level. Splitting a service is the way to get independent surfaces.
- **Protecting data at rest / a real secret.** The key is a capability token; its
  value legitimately lives in deploy state (contrast ADR-0029 secrets).
- **Rotation UX.** Rotation is "destroy the key/binding and redeploy." No rotate
  command in scope.
- **Non-RPC transports.** HTTP (`http()`) bindings are untouched here.

## Definition of Done

- Deploying `examples/storefront-auth` (or an equivalent two-service example)
  provisions per-edge keys, and the live round trip still succeeds with
  enforcement on: a wired consumer call returns `ok`, and a direct anonymous
  `curl` to the provider's `/rpc/<method>` returns `401`.
- A second no-op redeploy re-versions nothing (keys are stable in state).
- Unit + type tests cover the `@internal/rpc` enforcement and the target wiring.
- ADR-0030 merged; this spec's requirements each map to a shipped, tested slice.

## Key risk

The per-edge value channel (requirement 6). A binding's URL is one provider
output every consumer copies; a per-binding key is scoped to the *edge*, so it is
not a provider output and does not flow through the existing
producer-output→consumer-param path in `buildConfig`. Slice 2 introduces the
generic edge-scoped provisioned-value mechanism and the provider-side
aggregation. This is where the design earns or loses its "dead simple" claim;
plan it against the real `buildConfig`/`serialize`/graph code before writing it.

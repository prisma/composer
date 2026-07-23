# Project: wired-egress — design record

> Status: **design settled in discussion (Will + agent, 2026-07-23),
> project not yet planned or started.** This document records the full
> design state so a fresh agent can pick up the conversation without the
> original transcript. Companion: `design-notes.md` (how the design got
> here, rejected alternatives), `origin.md` (where this came from and
> what already landed elsewhere).

## Purpose

Make a service's exposed ports real at the transport level. Today,
serving HTTP on the platform port is ambient authority — every Composer
service listens on its one injected port, every exposed rpc port of the
service shares one flat dispatch namespace (`POST /rpc/<method>`) behind
one flat accepted-key set, and the service URL is public by default. A
consumer wired to one port holds a bearer key the wire accepts for every
method of every port; port-level least privilege exists only in the
typed client. The principle "no globals — all dependencies are injected"
already governs config, secrets, and clients; this project extends it to
the listen socket: **listening is a capability the wiring grants, not a
right the service exercises.**

Forcing example: the auth module's `admin` port (revoke sessions, ban
users) ships in the same service as its public login API. "Isolation by
politeness" is the wrong trust model for it.

## The settled model

1. **rpc ports: mount-iff-wired, zero new authoring.** A consumer edge is
   the justification for a port to exist on the network. The lowering
   mounts an rpc port iff ≥1 consumer wired it; the mount's accepted keys
   are exactly that port's edge keys (ADR-0030 keys are already minted
   per binding). An unwired admin port is not 401-protected — it is
   **absent**. The rpc binding itself carries the egress information to
   the consumer (address in its `url` connection param, as today).
2. **Public egress is the one new representation.** "Expose publicly" is
   the boundary to the world outside the topology — the only consumer
   with no in-graph edge. It becomes an explicit binding the root
   supplies at `provision()` (need/source split, same rail family as
   ADR-0029 `envSecret` / ADR-0032 `envParam`; the source is
   target-owned). A non-rpc surface with no binding — public or
   in-graph — is not served. (Will, verbatim intent: "RPC binding can
   carry egress information; it's only for the 'expose publicly' — the
   boundary to the world outside our topology — that we lack a
   representation.")
3. **Strongest wiring for auth** (recommended example shape): do NOT bind
   auth's `api` port to public egress — wire it only to the consumer
   app's `authApi()` edge, key-checked like any edge. The auth service
   then has no public surface of its own; public exposure happens at the
   storefront, which mounts the proxy on its own origin.

## The serving design (settled at sketch level)

`serve()` today conflates three jobs; only one is rpc-specific. Split:

1. **Mount table, minted at lowering (framework-owned data).** Per
   exposed port with a binding: `{ port, prefix, keys }` — prefix
   deterministic from the port name (`/session`, `/admin`, `/api`), keys
   = that port's edge keys (empty for a public-egress mount). Delivered
   two ways: the provider receives the mount table on the config rail
   (address-free stash), and **the consumer's `url` connection param is
   minted with the prefix already inside it**. This is the design's
   contract: no consumer-side change, ever — every `DependencyEnd`
   hydrates from `{url}` and stays ignorant of mounting.
2. **A generic, protocol-blind router** in a new authoring package
   (sibling of service-rpc, working name `@internal/serving`):

   ```ts
   interface PortServer { fetch(request: Request): Promise<Response> }

   serveMounts(service, {
     session: rpcPort(sessionHandlers),   // service-rpc's contribution
     admin:   rpcPort(adminHandlers),
     api:     betterAuthPort(auth),       // any protocol, same seam
   }): (request: Request) => Promise<Response>
   ```

   Per request: match prefix → no mount wired? 404 (the PortServer for an
   unwired port is never constructed) → check the mount's keys
   (constant-time set membership, lifted OUT of serve() and applied
   uniformly) → strip prefix → dispatch. Router owns `/health` uniformly.
3. **`serve()` shrinks to `rpcPort()`** — dispatch, arktype validation,
   idempotency cache. It stops owning the listener, the bearer check, and
   the flat method namespace (which dissolves serve()'s cross-port
   method-name-uniqueness restriction).
4. **Key header moves off `Authorization`.** A mount whose protocol needs
   `Authorization` for itself (Better Auth behind the proxy edge) can't
   share it; since this is a wire change anyway, the router checks a
   dedicated header (working name `x-composer-service-key`) for all keyed
   mounts, returning `Authorization` to protocols.
5. **Admin-path payoff:** tier 2/3 admin surfaces (web UI, dashboard
   cards serving static assets + a data endpoint) are just more
   `PortServer`s — mounted iff wired, keyed like any mount. Streams could
   later migrate its bespoke `API_KEY`/argv arrangement onto the router.

## Platform grounding (ignite, verified 2026-07-23)

- **No multi-port, none specced.** One `httpPort` scalar per version, one
  port mapping attached at version creation, Foundry `Endpoint` = one
  single-label hostname prefix → one version (wildcard TLS forecloses
  nesting), `ComputeService` has a single `endpointDomain`. No
  `ports[]`/named-endpoint construct anywhere in the compute API,
  manifest, or endpoint model.
- **No private networking / in-workspace addressing**; every service URL
  is public by default, no opt-out. A "private network provided with
  every Prisma project" + inter-service invocation appear only in the
  2026 product-strategy doc as future work.
- **Consequence — v1 lowering:** per-mount path prefixes on the single
  public listener. Mount set + per-mount key sets derive from wiring;
  "absent" means not-routed (404 at the router, handler never
  constructed), not not-listening. The authoring model is invariant; the
  lowering upgrades to real per-port listeners without authored-code
  changes if the platform grows multi-port.
- **Platform ask sent** (Will, 2026-07-23, to the platform team):
  requested the far-less-onerous-than-private-networking capability —
  multiple port mappings per version, each independently addressable;
  ports-only is sufficient (listener separation; auth stays per-surface
  in-process). Status at time of writing: message sent, meeting
  requested, no response yet. The lowering's mount-to-address mapping is
  the only part that changes with their answer.

## Enforcement layering (state this in any ADR; do not oversell)

- **Process layer: listening stays ambient, permanently.** ADR-0005 (the
  framework never wraps/transforms user code) means a service author can
  always bypass `serveMounts()` and listen directly. The router is how a
  *cooperating* service serves, not a sandbox.
- **Platform layer (today):** every listener is publicly reachable — a
  rogue/buggy service can expose its own data on its public URL. The
  floor below the app process requires the platform (private-by-default,
  declared egress, or per-port control) — that's the platform ask.
- **What wired egress DOES guarantee:** inbound trust — consumers only
  call URLs handed to them through bindings, presenting keys minted for
  those edges; a rogue listener gains no callers and holds no keys to
  other services' mounts (it can expose itself, not reach or impersonate
  others). And module-boundary integrity: for first-party modules we
  author the entrypoint, so "unwired admin port is absent" holds
  wherever the paved road is used.

## Effects on existing code

- **email:** redeploys with no authoring change; its `outbox` port
  becomes absent-unless-wired — the least-privilege claim in its design
  (D4) becomes transport-true.
- **auth:** S1 shipped flat dispatch with an in-module fetch router
  (`/api/auth` public, `/rpc/*` flat-keyed) — this project re-plumbs the
  transport underneath it; the recommended proxy-only wiring lands here.
  The `findUser` rename (see origin.md) stays — clearer name regardless.
- **serve() consumers generally:** wire-format change (paths + key
  header). Pre-1.0, all consumers in-repo; a dual-accept window is
  probably unnecessary — confirm at pickup.

## Open questions / grounding at pickup

1. Does the rpc provisioning rail's `edge` expose the target-port
   identity (needed to partition keys per mount), or does it need to
   grow it? (`provisioned-edges.ts` / `service-keys.ts` in the target.)
2. Mount-table storage shape on the config rail: one JSON row vs
   per-port rows — decide against the serializer's provider-param
   machinery.
3. Public-egress source naming + authoring shape (`ingress`/`egress`
   option at provision? a `publicHttp()` source?) — target-owned, mirror
   the envParam/envSecret split.
4. Key header final name.
5. ADR shape: amend ADR-0030 vs a new egress ADR referencing it (likely
   new ADR + amendment note).
6. Platform response — if multi-port arrives, the mount→address mapping
   in the lowering changes; nothing else does.

## Suggested slice sketch (to be re-derived at planning, not binding)

1. `@internal/serving` (router + PortServer + mount table read) +
   `rpcPort()` split + target lowering (mount minting, url prefixes,
   per-mount keys, key header) + email/auth migrated + integration proof
   ("wired-to-session cannot reach admin"; "unwired port is 404").
2. Public-egress representation (need/source + lowering) + auth
   proxy-only example wiring.
3. ADR + admin-path convention handoff + streams migration (optional).

## Definition of done (sketch)

- A consumer wired only to a non-admin port cannot reach an admin mount
  (real serve/makeClient integration test, and deployed smoke).
- An unwired port does not exist on the deployed service (404, handler
  never constructed).
- email + auth redeploy on the new transport with no authoring changes
  beyond entrypoint composition (`serveMounts`).
- serve()'s cross-port duplicate-method restriction lifted.
- ADR recording the model + the enforcement layering.

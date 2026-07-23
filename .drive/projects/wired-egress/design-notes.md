# wired-egress — design notes (how the design got here)

> Discussion record, 2026-07-23 (Will + agent, inside the auth-module
> project — see `origin.md`). Read `spec.md` first; this file explains
> why the losers lost and preserves the reasoning a fresh agent needs to
> continue the conversation faithfully.

## The path

1. **Trigger:** implementing the auth module, flat rpc dispatch
   (`POST /rpc/<method>`) collided `session.getUser` with
   `admin.getUser` at `serve()` construction. Interim fix shipped in
   auth S1: admin op renamed `findUser`.
2. **Will's probe ("outputs should be isolated") surfaced the deeper
   gap:** ADR-0030 keys are minted per binding but pooled into ONE flat
   accepted set per service (`COMPOSER_RPC_ACCEPTED_KEYS`), checked
   before dispatch service-wide. A consumer wired only to `session`
   holds a key the wire accepts for `POST /rpc/banUser`. Port isolation
   was type-system deep only. Same holds for email's outbox today.
3. **Agent's first proposal — REJECTED:** port-scoped dispatch
   (`/rpc/<port>/<method>`) + per-port key partitioning. Will's
   objection, which reshaped the design: that hardens the flat listener
   but keeps *serving* as ambient authority. His model: exposure is a
   **wiring concern** — the module should be handed egress bindings;
   "we've been treating serving HTTP on port 80 as a global right,
   where really it should be wired up." If you expose two output ports
   you should be handed two egress dependencies; the orchestrator (root
   wiring) supplies the binding that hooks a port to the outside world.
4. **Refinement (agreed):** rpc ports need no new authoring — the
   consumer edge IS the egress information, so mount-iff-wired derives
   everything from the graph. Only "expose publicly" (a consumer with no
   in-graph edge) lacks representation and gets one: an explicit
   root-supplied binding on the envSecret/envParam rail pattern.
5. **Platform check** (Will: "can we just put them on different ports on
   the same address? Check ./ignite"): no — one port mapping per
   version, one public URL per service, public by default, no private
   networking, none of it specced to change (details in spec.md). So v1
   lowers to per-mount path prefixes on the single listener; the
   authoring model is invariant to the platform's answer.
6. **Generic serving question** (Will): serve() is one protocol's
   helper; he wanted a tool any future node type can use. Settled: the
   mount table + protocol-blind router + `PortServer` seam +
   `rpcPort()` split (spec.md § serving design). Key insight that keeps
   consumers generic: the mount prefix rides inside the minted `url`
   connection param, so no consumer ever learns mounting exists.
7. **Ambient-listening honesty check** (Will: "there's nothing to stop
   me listening on port 80, right?"): correct, and permanently so at the
   framework layer (ADR-0005 — we never wrap user code). The
   enforcement-layering statement in spec.md § Enforcement came from
   this exchange: wired egress guarantees inbound trust and first-party
   module-boundary integrity; the floor below the app process is
   platform work.
8. **Platform ask sent** (Will, same day): deliberately scoped SMALLER
   than private networking — "something as simple as binding different
   API servers to different ports would be sufficient"; ports-only gives
   listener separation, auth stays per-surface in-process, and per-port
   reachability / the strategy doc's project private network can come
   later. Meeting requested with compute networking/ingress owners.
9. **Branch-out:** Will called it out of the auth project into its own
   project (this workspace).

## Rejected alternatives (with reasons)

- **Path-scoped dispatch + per-port key partitioning** (agent draft v1):
  hardens the shared listener instead of removing its ambient existence;
  admin port still exists on the public URL, just 401s. Superseded by
  mount-iff-wired.
- **Boot-time serving decisions / config flags for exposure**: exposure
  must be visible in the wiring graph (review surface), not in runtime
  config.
- **Waiting for platform private networking**: the ask is deliberately
  smaller (ports), and even with zero platform change the wired-egress
  authoring model + path-prefix lowering delivers mount-iff-wired and
  per-mount keys now.
- **Keeping `Authorization` for service keys**: collides with protocols
  that need the header themselves (Better Auth bearer). Dedicated header
  chosen since the wire changes anyway.

## Constraints a fresh agent must not violate

- ADR-0005: never wrap/bundle user code — the router is opt-in
  cooperation, not enforcement; don't design as if it were a sandbox.
- ADR-0016: module boundary = service boundary; ports are surfaces of
  ONE service — don't split ports into services to get isolation.
- ADR-0030 stays the key-mint mechanism; this project re-partitions
  acceptance, it does not reinvent minting.
- Consumer-side invariant: no DependencyEnd learns about mounts; the
  prefix rides in the minted url. Breaking this forfeits the design's
  main simplicity win.
- Per-METHOD authz remains explicitly out of scope (ADR-0030's
  deferral stands; this project is per-PORT).

## Related admin-path note

"Admin ports are reachable only if wired — the existing dependency model
doing the access control" was a deferral in the admin-path strategy
writeup; this project makes it the literal mechanism. Hand the settled
convention to the admin-path design pass when tier-1 conventions are
standardized (auth + email are the proving modules).

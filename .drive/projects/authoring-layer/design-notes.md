# Authoring Layer — Design Notes

The design is settled and recorded in the canonical docs — this file does not restate
it, it points to it and records the build-decision history.

## Canonical design (source of truth)

- [`docs/design/10-domains/core-model.md`](../../../docs/design/10-domains/core-model.md)
  — **the build contract**: all types, the six package entries with dependency
  weights, the target-pack contract, the worked prisma-cloud pack, the five enforced
  invariants, extension points.
- [`core-and-targets.md`](../../../docs/design/03-domain-model/core-and-targets.md) —
  thin core / target-pack split; lowering is routing; runtime is a dumb loop.
- [`authoring-surface.md`](../../../docs/design/03-domain-model/authoring-surface.md)
  — the developer-facing narrative (ports, direction-from-position, Load/Hydrate).
- [`architectural-principles.md`](../../../docs/design/01-principles/architectural-principles.md)
  — no-globals, **runtime-agnostic**, no-target-knowledge, wiring-precedes-execution.

## Decision history (chronological)

1. **Descriptors are pure tagged data; hydration is keyed separately** (first build).
   Survives, refined: nodes carry a `type` routing key; the pack's runtime resolves it.
2. **MakerKit does not bundle** (operator correction). Core's `/build` entry was a
   principle violation; the app owns bundling and the artifact envelope.
3. **Core is target-agnostic; lowering is routing** (operator correction). Core's
   `lower()` importing prisma-alchemy was a principle violation; the vocabulary
   (`compute`, `postgres`) moved to a target pack that carries routing metadata.
   KISS shape set by the operator: the pack provides `postgres()` and `compute()`.
4. **Alchemy stays in core** (`@makerkit/core/deploy` imports it): it is the
   target-neutral provisioning engine per layering.md claim 3, not a deployment target.
5. **Runtime-agnostic** (operator principle): no Bun/Node coupling in any shipped
   entry, even type-only. The DB client factory is app-supplied
   (`runtime({ clients })`); `postgres<C>()` lets the app declare its client type.

## Superseded

The first slice-1 build (PR #6 code: core-owned `lower()` → prisma-alchemy, `/build`
bundler, pack-fixed `Bun.SQL` client) — superseded by decisions 2, 3, 5. Its
graph/Load mechanics, no-globals shim boundary, and test discipline (import-split
guard, side-effect-free-import test) carry forward into the rebuild.

6. **Connection primitive design settled** (operator discussion): three execution
   paths — provision / deploy / run — with core the only actor on all three; the
   pack satisfies an SPI ("packs provide the tools, Core utilizes them; the pack
   is never the actor"). Service SPI splits into provision (identity) /
   writeConfig (values into the runtime env, via the pack's one shared name
   mapping) / deploy (build → running version); core's per-service sequencing
   provision → writeConfig → deploy makes the PRO-211 fresh-deploy race
   structurally impossible. Consumers declare `http()` connection ends (hydrate
   to a plain client; typed generated clients deferred to the interface work);
   the minimal `hex()` wires producer → consumer; connection edges must form a
   DAG (address-at-deploy-time wiring; checked at Load). Recorded in
   core-model.md §§ Three execution paths / Lowering / worked instance.

7. **Project = application; DATABASE_URL forbidden and poisoned** (operator
   decisions). One PDP Project per MakerKit application — all services co-locate
   as Apps with their own Databases; the Project is the config-namespace and
   secret-visibility boundary. The platform's default DATABASE_URL/_POOLED are
   never read: MakerKit writes user-level poison values ("" preferred, "-"
   fallback) at project provision so reliance is impossible. Every database URL
   is an explicit per-service variable through writeConfig. The one-project-per-
   service layout of R1–R3 is retired (it was a slice-1 expedient, wrongly
   rationalized). Target SPI gains application.provision (once, before services);
   postgres resource lowering creates a real Database + Connection. Recorded in
   05-prisma-cloud/* and core-model.md.

8. **Deployment identity = graph address (via a printed bootstrap); config
   ownership splits core=structure / pack=encoding; the node carries its own
   runner** (operator discussion, R4). Exhaustively recorded in
   [`slices/r4-connection-primitive/design-note.md`](slices/r4-connection-primitive/design-note.md);
   contract in core-model.md. In brief:

   - **Identity = address.** The R4 spec's reserved-identity-variable mechanism was
     proven impossible from PDP source (every App in a Project boots a
     byte-identical env — a shared "who am I" key is last-write-wins); user-supplied
     ids were rejected (registry hexes collide). A node's identity is its **address**
     (path of provision ids from the app root, assigned by Load from graph position).
     It reaches the VM through the only per-service channel — the artifact.
   - **The node carries its runner.** `main.ts` is a pure re-export of the Service;
     `compute()` returns a runnable subclass whose `run(address)` is the boot loop,
     so the app bundle already holds the runtime (ONE copy of core). The pack's
     `package` SPI (core is the actor) prints a two-line, zero-dep bootstrap
     (`import main from "./main.js"; main.run(address)`) and wraps the bundle in
     the target envelope (compute.manifest.json + deterministic tar). `runHost` and
     the public `/runtime` entry are deleted; `ServiceNode.run(deps,ctx)` renamed
     `invoke`.
   - **Config: core=structure, pack=encoding.** Core owns the shape (`configOf`),
     builds a fully-typed `Config` from the graph at deploy, and hydrates at boot;
     the pack **serializes** that typed Config to env strings (deploy) and
     **deserializes** it back (boot) through one serializer — so the pack owns validation
     (it reverses its own encoding) and core never touches a string or a platform
     key. Replaces R3's `ConfigAdapter`(get→strings)+core-coercion; visibility/
     interception survive via `configOf` + the typed-Config boundary.
   - **Amends decision 2:** the app owns source → bundle only; the artifact envelope
     was target vocabulary and moves to the pack. `LowerOptions` carries bundles,
     not tars.
   - **Rejected on the way:** push mechanisms (codegen/define/virtual module —
     makerkit feeding the app build); bundle-imports-the-hex pull (forced an
     interface/implementation file split and an inverted grammar the operator judged
     unintuitive — services stay one-file, self-describing); runHost inlined into the
     bootstrap (a second copy of core in the artifact — collapsed by moving `run`
     onto the node).

9. **MakerKit owns the deploy entrypoint; `connections.ts` folded away** (operator
   corrections, R4 docs pass). Directional — the invocation change is a LATER slice,
   but the docs now describe the correct model:
   - **No user-written stack file.** The standard deploy path is `makerkit deploy`
     over a declarative `makerkit.config.ts` (`{ app, target, name, bundle(s) }`);
     the CLI reads it and calls `lower()` internally. `lower()`/`lowering()` stay in
     `/deploy` as the mechanism + the escape hatch for hand-composed/mixed stacks.
     Listed as a named extension point; until it lands, examples keep an interim
     `alchemy.run.ts` calling `lower()`.
   - **`connections.ts` deleted from the model.** It held `const db =
     postgres({client})` in a separate file whose only claimed job — isolating the
     driver import — is void (the service module imports it anyway). The connection
     definition lives inline in `service.ts`. R4 examples fold it in.

10. **Config vs secrets; MakerKit wires secrets, never sources or persists them**
    (operator discussion, R4 propagation/Finding-2 thread). The realizations that
    resolved Finding 2:
    - **Most "env vars" are graph-materialized wires, not user config.** What
      `serialize` writes is mostly connection/resource addresses MakerKit computes
      from the topology. A wire's change is a graph event, detected by the source
      node's **provenance** (its identity/version) — never by fingerprinting the
      value. So nothing value-derived (not the value, not a hash) is ever persisted:
      a hash of a secret is itself a leak, and storing the value would put a
      credential in Alchemy's unencrypted state.
    - **Secrets are platform-sourced, always.** A true secret never enters MakerKit's
      graph or deployment state. The user — or a third-party manager (e.g. Doppler)
      integrated at the platform — puts it in the platform's secret store; MakerKit
      only **wires the platform secret to the consumer's DI** (no-globals holds: user
      code never reads env; MakerKit injects). MakerKit sources it, never.
    - **Provisioned credentials become platform secrets.** The intended handling for
      a MakerKit-provisioned credential (a database URL): write it to the platform
      secret store transiently during provisioning, then wire it by reference like
      any platform secret — a transient deploy-time value, never persisted in Alchemy
      state. (Deployment is expected to run in CD or a PDP-side orchestration system.)
      Hardening follow-up, not R4.
    - **Finding 2 resolution:** the environment edge guarantees **ordering** (the
      fresh-deploy race — R4's headline, unaffected). Propagating a wire whose value
      genuinely changes is via source-version provenance — a **deferred follow-up**,
      narrow because promoted endpoints are stable; secrets rotate through the
      platform. No prisma-alchemy change in R4; the overclaim was scoped down in
      core-model.md + alchemy-lowering.md, and the config/secret split recorded in the
      glossary.

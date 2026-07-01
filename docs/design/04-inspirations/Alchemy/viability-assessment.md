# Viability: use Alchemy instead of building MakerKit?

Date: 2026-06-29. Subject: Alchemy v2 (`2.0.0-beta.59`, "Infrastructure-as-Effects").

## Correction (2026-06-29, after checking with the Metal team)

Two facts arrived after this was written and undercut its framing. **The
recommendation below is being revised; read this first.**

- **There is no orchestrator/provisioner yet.** Foundry deploys *Compute only* —
  it is not the general provisioning system this doc assumed we'd "hand the
  artifact to." A provisioner API still has to be built.
- **Prisma already ships Alchemy wrappers** for Prisma Postgres and Prisma
  Compute. So "no Prisma providers" (divergence #3) is wrong, and Prisma has
  already partly committed to Alchemy as a user-facing surface.

Consequence: the strongest non-circular reason for "MakerKit as a separate
artifact-emitter" — an existing server-side orchestrator to feed — does not
exist. The live question is no longer "Alchemy vs MakerKit" but **where
provisioning state and reconciliation live: server-side (platform-owned) or
client-side (Alchemy's current model)** — a question grounded in Prisma being a
managed, multi-tenant platform, not in how we define MakerKit. The likely shape:
MakerKit = Prisma's opinionated layer on Alchemy/Effect (definition language +
the existing Prisma providers + topology extraction) **plus** a server-side
orchestrator that ingests the serialized resource graph. An Effect decision ADR
still follows.

## Recommendation

> Superseded in part by the correction above — retained for the reasoning, not
> the verdict.

**No — don't adopt Alchemy as MakerKit's foundation. Build MakerKit, treat
Alchemy as the reference design, and separately decide whether to adopt Effect.**

Alchemy and MakerKit agree almost exactly on the *programming model* but
disagree on the *system boundary*. Alchemy is a provisioning engine: the program
defines infrastructure **and applies it** against cloud APIs, owning state and
reconciliation. MakerKit explicitly does **not** provision — it emits a static
topology artifact and hands provisioning to Prisma's platform (Foundry) or the
local emulator (`prisma dev`). That boundary is the entire reason MakerKit
exists as a distinct thing, and it's the part Alchemy can't give us without
being turned inside out.

The genuinely valuable, reusable idea underneath Alchemy is **Effect** (its
Layer-based DI, typed errors, streams). That is separable from Alchemy the IaC
tool, and is the decision actually worth making — see [Open decision](#the-decision-actually-worth-making-adopt-effect).

## What Alchemy v2 is

One type-safe program that contains both your cloud resources and the code that
runs on them. Resources are declared as Effects; "Platforms" (Worker, Lambda,
Container) bundle infra config **with** the runtime handler. A plan→reconcile→
delete engine drives the resources against cloud APIs (AWS, Cloudflare),
persisting state to diff future deploys. DI is Effect's: a **Binding** hands the
handler a typed SDK client and wires permissions/env at deploy time ("the
binding *is* the client" — no `env.BUCKET`); a **Layer** hides a slice of
infrastructure behind a typed service interface so implementations swap without
touching consumers. CLI: `deploy` / `destroy` / `plan` / `dev`.

## Where Alchemy matches MakerKit (closely)

| MakerKit goal / principle | Alchemy v2 mechanism | Match |
| --- | --- | --- |
| Code-first topology from TS structure | Resources/Platforms declared in TS, wired by type | Strong |
| No globals, DI-only ([principle](../../01-principles/architectural-principles.md)) | Bindings: "the binding is the client", no env lookups | Strong — arguably better-realized than our sketch |
| Control plane vs execution plane | **Phases**: plantime vs runtime, type-enforced via `RuntimeContext` ("colored functions") | Strong |
| Platform-agnostic core, ports/adapters | **Layers** + custom providers; swap KV↔R2↔Dynamo↔in-memory behind a typed service | Strong |
| Components with hexagonal ports (the Convex idea) | A **Layer** *is* this: encapsulated resources+bindings behind a typed interface | Strong |
| Streaming-first | Event sources/sinks as Effect `Stream` (`source → transform → sink`) | Partial — tied to cloud queues, not a Durable Streams primitive |
| Agent-friendly, statically analyzable primitives | Explicit `define`-style primitives, type-checked wiring, LLM-generated providers | Strong |

The user's read is correct: Alchemy "models things very similarly." It's strong
validation that MakerKit's mental model is sound. The disagreement is about
boundaries, not concepts.

## Where it diverges (the reasons not to adopt)

### 1. Provisioning ownership — the crux

- MakerKit's stated **non-goal**: "Provisioning any of these things." We emit a
  static graph → Foundry / `prisma dev` provisions.
- Alchemy's **entire core** is provisioning: the plan→reconcile→delete loop,
  the state store, drift detection, adoption, and providers-as-API-clients all
  exist to create/update/delete real cloud resources. "Resources that are
  Created, Updated and Deleted automatically."
- This is a head-on mismatch. Adopting Alchemy means adopting a tool whose
  primary job is the one job we explicitly don't want to own. Its highest-value
  machinery (the apply engine + state) is exactly what we delegate to Foundry.

### 2. No static hand-off artifact

MakerKit's output is a portable topology file (`makerkit.map.json` + bundles)
for an external orchestrator. Alchemy has **no documented path to emit such an
artifact**. `alchemy plan` produces a plan, but it's computed by diffing code
against persisted/live cloud state through providers' `read`/`diff` (which call
cloud APIs) — it's an internal step of Alchemy's own apply, not a serializable
graph you hand off. *(Inferred from the docs; absence of a feature isn't proof —
worth confirming against source before treating as final.)*

### 3. Provider model — partly corrected

**Corrected:** Prisma already ships Alchemy wrappers for Prisma Postgres and
Compute, so these don't need writing from scratch (Storage / Durable Streams /
Ingress still would). The residual concern is narrower and real: an Alchemy
provider's job is to `reconcile`/`delete` against an API from a **client-side**
apply loop with **client-side** state. For a managed platform you likely want
that reconciliation server-side. So the question isn't "missing providers" — it's
whether you keep Alchemy's *engine* (client-side apply + state) or only its
*definition language* (resources/bindings/Layers) and reconcile server-side. See
the Correction at the top.

### 4. `alchemy dev` rejects local emulation — we require it

MakerKit wants `prisma dev` to **emulate the cloud locally**. Alchemy
deliberately refuses this: `alchemy dev` deploys **real** infra to the cloud and
only runs handler code locally, under a section literally titled "Why not
emulate everything?". Direct conflict with our local-dev goal.

### 5. The Effect commitment is pervasive

v2 hard-depends on `effect`. Providers are Layers, resources are Effects, DI is
Effect's Context/Layer system. The async-handler style escapes Effect in
*runtime* code, but the infra-definition layer is Effect to the core. Adopting
Alchemy = adopting Effect as the foundation of Prisma's app framework, including
its learning curve and its leakage into user code (`yield*`, `Effect.gen`,
`RuntimeContext`). That's a real cost for an "approachable, agent-scaffoldable"
platform — though Effect also *buys* a lot (next section).

### 6. Maturity and governance risk

- v2 is **beta** (`2.0.0-beta.59`); npm `latest` is still v1.
- The v2 source repo isn't publicly accessible (the package ships to npm, but
  open development isn't visible the way v1's is).
- Effectively a single-maintainer project (~2.2k stars on v1). Real momentum,
  small bus factor.
- Mitigant: **Apache-2.0**, so we could fork/vendor if we ever depended on it.

Betting a core Prisma platform deliverable on a pre-1.0, single-maintainer beta
whose primary purpose conflicts with ours is the wrong kind of risk.

## What Alchemy does better than our current sketch (borrow these)

Be honest: in several places Alchemy is ahead of MakerKit's design notes, and we
should steal the ideas regardless of the build/adopt decision.

- **"The binding is the client"** — the cleanest possible expression of our
  no-globals principle. A dependency resolves to a typed SDK, not a name to look up.
- **Phases as colored functions** — encoding the control/execution split in the
  type system (`RuntimeContext` only satisfiable at runtime) is a sharp,
  type-safe realization of our two-plane principle.
- **Layers as Components-with-ports** — a typed service interface + swappable
  implementations is exactly the hexagonal "Component" we sketched, and it's
  more worked-out than ours.
- **Event source → transform → sink as streams** — a concrete shape for our
  streaming-first goal.
- **Provider model** — "declare a type, implement a lifecycle Layer" is a good
  template for how MakerKit resource kinds could be defined and extended.

## The decision actually worth making: adopt Effect?

The innovation that makes Alchemy "feel like MakerKit" is **Effect**, not
Alchemy's apply engine. Effect's `Layer`/`Context` system gives us the
platform-agnostic core (ports/adapters), DI without globals, typed errors,
retries, structured concurrency, and OpenTelemetry — natively. MakerKit could
take Effect as its DI/runtime substrate and get ~80% of what's attractive here,
**without** Alchemy's provisioning loop, state store, or boundary conflict.

That is the real fork in the road, and it deserves its own ADR:

- **Pro**: best-in-class DI/ports substrate for free; aligns the execution plane
  with a mature library; typed errors + observability included.
- **Con**: heavy paradigm in user code; raises the floor for humans and agents;
  couples MakerKit's public surface to Effect's API and release cadence.

If we say yes to Effect, MakerKit becomes "the static-topology + bundle-emitter +
local-emulation layer that Alchemy chose not to be, built on the same Effect
substrate." If we say no, we keep a plain-async DI container and borrow Alchemy's
*shapes* only.

## Options considered

| Option | Verdict |
| --- | --- |
| **A. Adopt Alchemy v2 wholesale** as the app framework | Reject — forces Prisma into Alchemy's provisioning-owns-everything model, conflicts with Foundry-provisions and `prisma dev` emulation, beta + single-maintainer risk on a core bet |
| **B. Use Alchemy selectively** (its resource/binding abstractions) but bypass its apply engine with custom providers + a custom "emit static manifest" path | Reject for now — you vendor a beta and invert its core loop; constant fight against the grain; inherits the Effect commitment without a clean exit |
| **C. Build MakerKit; use Alchemy as reference; decide on Effect separately** | **Recommend** — keep our boundary (emit static graph, delegate provisioning, emulate locally), steal Alchemy's best shapes, make the Effect call deliberately |

## Open questions to confirm before finalizing

1. **Can Alchemy emit a portable static topology artifact** without running its
   apply loop? (Confirm against v2 source — divergence #2 is inferred.)
2. **Effect: in or out** for MakerKit's execution plane? → write an ADR.
3. If Effect is in, is there a smaller **"Alchemy-minus-provisioning"** subset
   (resources + bindings + Layers, no state/apply) we could depend on or
   re-implement, rather than starting the DI layer from scratch?
4. Does Prisma want a hard dependency on a single-maintainer, pre-1.0 project
   anywhere in the platform's critical path?

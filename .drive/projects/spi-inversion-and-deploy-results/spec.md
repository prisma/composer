# Purpose

Make the lowering SPI's seams point the right way — each consumer declares
the interface it relies on, producers implement it, and only the lowering
loop knows the routing — so that deployment results can be captured and
rendered as a first-class product of a deploy instead of being bolted onto
the wiring contract. The `NodeReport` attempt (composer PR #101) failed
because one shared producer-side bag (`LoweredNode`) serves three unrelated
contracts; this project replaces the bag with consumer-declared interfaces
and builds reporting on the clean seams.

# At a glance

Today `LoweredNode` (`{ outputs: Record<string, unknown> }`) plays three
roles at once:

1. **Intra-descriptor phase handoffs** — `provision` → `serialize`/`deploy`.
   Private to one descriptor; core never reads them; the descriptor casts to
   recover types it produced itself two phases earlier.
2. **Inter-node wiring** — `deploy`'s return, stored in the `lowered` map,
   read by `buildConfig` by param name for downstream nodes. The only role
   core genuinely consumes.
3. **Reporting** (the reverted `NodeReport`) — presentation data smuggled
   onto the wiring type because the shared bag accepts anything.

The project separates them:

- **Phase handoffs** become descriptor-owned types carried generically by
  the SPI — typed to the one party that writes and reads them, opaque to core.
- **Wiring** becomes its own named, name-keyed record type. The consumer-side
  declaration already exists (a node input's connection params); enforcement
  makes a producer that under-delivers a loud `LowerError` naming the edge
  (operator-confirmed 2026-07-17).
- **Reporting** becomes `DeploymentResult`: per node, holding the graph node
  itself plus typed platform primitives (kind, platform id, url only when
  the descriptor declares it public). Assembled by the lowering loop at the
  moment it holds full context; the whole-run value is a plain collection,
  no aggregate noun.
- **Rendering** runs in the deploy child process, which holds both the Graph
  and the results — no cross-process transport. The vehicle is an alchemy
  **Action** declared at the end of the stack effect: actions run *during
  apply* with resolved inputs, so the action's runner receives the resolved
  primitives, joins them to the graph it holds by closure, and calls the
  renderer the CLI wired in through the generated stack file. Core stays
  presentation-free.

Grounding facts that shape everything (verified against alchemy
2.0.0-beta.59 source): the stack effect runs entirely **before** apply;
resource yields return lazy Output proxies; resolved values reach program
code only through apply-time evaluation (the stack's return value, or an
Action's input). The stack effect returns `undefined` from S1 on, which
kills both alchemy's raw stack-output dump and the `setOutput` state write.
Parent-process readback via the state store was rejected on verified
grounds: it needs a faked `Stack` service, re-takes the deploy lock, and
must replicate alchemy's `dev_${USER}` stage derivation.

# Non-goals

- **Per-node `ok`/failure diagnostics.** `lower()` is `orDie`: one failure
  kills the run, so `ok` would never vary. `DeploymentResult` may carry a
  diagnostics slot, but populating it waits on a deliberate
  collect-and-continue decision (deploy semantics, partly alchemy's) that
  this project does not make.
- **Per-resource change status (created/updated/noop).** Verified not
  exposed to the program — it flows only to alchemy's CLI event session.
  Capturing it means wrapping alchemy's Cli service or an upstream change;
  deferred.
- **Any cross-process transport for results.** The renderer runs where the
  results are. A `--json`/CI consumer in the CLI parent process, if ever
  wanted, is its own future design with its own serialized projection.
- **Collect-and-continue lowering.** Fail-fast semantics stay as they are.

# Place in the larger world

- Supersedes composer **PR #101** (`NodeReport` on `LoweredNode`) — that
  approach is withdrawn; the PR is reworked or closed in favor of this
  project's slices.
- Constrained by **ADR-0005** (users build, the framework assembles —
  deterministic, no guessing) and the layering rules in
  `architecture.config.json` (`framework.mayImportFrom: []`; the CLI must
  not import prisma-cloud). The renderer-in-child design respects both.
- The wiring seam builds on the connection-params model (ADR-0031 for
  provisioned params) — the consumer-side declaration this project starts
  enforcing.
- Alchemy behavior grounded in `alchemy@2.0.0-beta.59`
  (`Deploy.ts`/`Resource.ts`/`Apply.ts`): evalStack → Plan → Apply; Output
  proxies; stack output evaluated and persisted via `setOutput`.

# Cross-cutting requirements

- **Dependency inversion at every seam.** Interfaces live with their
  consumers: phase-handoff types with the descriptor, the wiring contract
  with the connection declaration (core's graph model), the primitive/result
  types with the deploy-result subsystem in core, formatting interfaces with
  the CLI. The lowering loop is the only party that knows which producer
  output feeds which consumer.
- **No shared mutable bag survives.** `LoweredNode` is retired; nothing
  reintroduces a producer-side record that multiple subsystems read. A new
  consumer requires a new declared interface and a visible routing edit in
  the lowering loop.
- **The descriptor names what is publishable.** Core never infers meaning
  from output keys; `url` on a primitive means publicly reachable because
  the descriptor said so (the allowlist lesson from #101).
- **Whatever crosses the stack boundary is plain data** (address-keyed
  primitives) because alchemy unconditionally persists the stack output.
  Node-bearing types stay in-process, on our side of the boundary.
- **No new casts.** The refactor must reduce, not relocate, the
  `blindCast`/`as` surface in descriptors (repo cast-ratchet rules apply).

# Transitional-shape constraints

- The DI refactor (S1) lands before the reporting slices; reporting builds
  on the separated seams, never on `LoweredNode`.
- Between S1 and the reporting slice, deploys behave exactly as today
  (hardcoded empty stack output); no intermediate state may change deploy
  behavior except as its slice specifies.

# Project-DoD

- [ ] `LoweredNode` no longer exists; each of its three roles has its own
      consumer-declared type, and every descriptor compiles against the new
      SPI without casting to recover its own phase values.
- [ ] An ADR records the seam design (consumer-declared interfaces, results
      assembled at full context, no transport before a cross-process
      consumer exists) in `docs/design/90-decisions/`.
- [ ] A real deploy of an example app prints a rendered deployment summary:
      the app's own topology with authored names, platform ids, and public
      URLs — produced from `DeploymentResult`s, not parsed from alchemy
      output — and alchemy's raw stack-output dump is gone or trivially
      empty.
- [ ] Wiring-contract enforcement (if confirmed): a producer that fails to
      supply a consumer's declared connection param fails the deploy with a
      `LowerError` naming the edge and param, covered by a test.
- [ ] PR #101 is superseded: reworked to this design or closed with a
      pointer.

# Open questions

- **Action plan-time input resolution on a fresh stack** — alchemy's own
  feature contract says an action's resource-referencing input plans before
  those resources exist; S3's D1 probe verifies it before anything builds
  on it (STOP → discussion mode if it fails).

Settled during shaping (see slice specs): wiring enforcement confirmed by
operator (S2); `ctx.application` becomes `unknown` narrowed by an
extension-owned type guard, and provisioner refs stay opaque `unknown`
(S1); the stack-output readback mechanism was rejected in favor of the
Action (S3).

# References

- Design notes: [design-notes.md](design-notes.md) — the argument, the
  corrected alchemy execution model, alternatives rejected.
- `packages/0-framework/1-core/core/src/deploy.ts` — the SPI and lowering
  loop this project rebuilds.
- `packages/1-prisma-cloud/1-extensions/target/src/descriptors/` — the
  descriptors that migrate.
- Composer PR #101 — the superseded `NodeReport` attempt.
- Tracker: [Prisma Composer: SPI inversion & deployment results](https://linear.app/prisma-company/project/prisma-composer-spi-inversion-and-deployment-results-f87bb6d9de12)

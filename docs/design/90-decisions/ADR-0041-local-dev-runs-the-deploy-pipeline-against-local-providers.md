# ADR-0041: Local dev runs the deploy pipeline against local providers

## Decision

`prisma-composer dev <entry>` boots the whole application locally, with no cloud
credentials, by running the **same pipeline as `prisma-composer deploy`** —
import the entry, Load the graph, assemble each service, lower, converge through
Alchemy — with substitution at exactly one boundary: the Alchemy resource
**providers**. An extension declares its local counterparts on an optional `dev`
field of its descriptor, the same pattern as `container`/`preflight`/`teardown`
(ADR-0017, ADR-0038):

```ts
export interface ExtensionDescriptor {
  // ... existing fields unchanged ...
  /** Local counterparts for `prisma-composer dev`. An extension without one is not dev-capable. */
  readonly dev?: DevDescriptor;
}

export interface DevDescriptor {
  /** Local providers for the SAME resource types the extension's lowering emits — handed the app identity, since local providers are emulator clients. */
  providers(input: DevProvidersInput): ProvidersLayer;
  /** A stable local identity — resolved without any platform call. */
  readonly container: ContainerDescriptor;
  /** Dev value-sourcing policy: secrets from the shell else minted placeholders; env-sourced params from the shell else a hard error. */
  preflight?(input: PreflightInput): Promise<void>;
  /** Ensure the emulator daemons this topology's node kinds need are running (idempotent — they persist across sessions). */
  emulators?(input: DevEmulatorsInput): Promise<void>;
  /** The dev session's view of the running app: endpoints, merged logs, and the stop control. */
  attach(input: DevAttachInput): Promise<DevAttachment>;
  /** `--fresh`: remove every local trace of the dev instance — emulator instances, state, data. */
  teardown?(input: TeardownInput): Promise<void>;
}
```

`DevDescriptor` deliberately has **no `nodes` and no `provisions`**: the
lowering — node descriptors, address derivation, config serialization,
provisioners — is byte-identical between dev and deploy. Dev cannot diverge the
semantics of the graph; it can only substitute what the lowered resources *do*.
That structural absence is the parity claim, expressed where the compiler can
hold it.

It also has **no `state`**: dev's Alchemy state uses Alchemy's own built-in
local file store (`localState()`, under `.alchemy/state/` in the working
directory), passed through the existing `LowerOptions.state` override.
ADR-0011's rule — targets supply the deploy state layer — governs durable
state on a platform; dev state is tool state in the working directory
(ADR-0004's rule), the same for every target, so core supplies it.

For the Prisma Cloud extension, the substitution splits its twelve resource
types four/eight. Four providers already run entirely locally and are shared
verbatim: `ServiceKey` and `S3Credentials` (both mint via Web Crypto and persist
in Alchemy state, never touching a platform), `PgWarm` (a real `select 1`
against whatever URL it is handed), and `PnMigration` (real migrations against
whatever URL it is handed). The remaining eight get local implementations in
three clusters:

| Cluster | Resources | Local implementation |
| --- | --- | --- |
| Compute | `ComputeService`, `Deployment`, `EnvironmentVariable` | a Compute **emulator** owning one child process per service, plus a local env-var store |
| Postgres | `Project`, `Database`, `Connection` | the ORM CLI's local Postgres **emulator** (`prisma dev`) |
| Buckets | `Bucket`, `BucketKey` | a bucket **emulator**: the storage module's existing S3 wire handler + SigV4 verifier over a disk-backed object store — objects are plain files at their key paths |

**The target runs one emulator per node kind — the platform's primitives,
locally.** The extension's `emulators` hook inspects the loaded topology and
ensures a machine-scoped emulator daemon per node kind the app uses: a
**Compute emulator** (runs service processes), the **Postgres emulator** (the
ORM's `prisma dev` — its daemon manager is the ORM CLI's own), and a **bucket
emulator** (the S3 wire over disk). Each emulator is multi-tenant and
long-lived — the firebase/supabase model — and is capable of creating an
*isolated instance* of its node type: a running service, a database, a
bucket. The local providers provision those instances by communicating with
the emulators during converge, and the orchestration wires the instances to
each other through the same lowered `EnvironmentVariable` records a deploy
produces — the topology composes locally exactly as it does on the platform.
Emulator instances are removed only by `--fresh`, through `teardown`.

**Converge terminates; the Compute emulator keeps serving.** Alchemy's
converge is a run-to-completion program (ADR-0007 drives it in a child
process that exits), so the local `Deployment` provider spawns nothing
itself: it unpacks the artifact, materializes the env, and hands the
deployment to the Compute emulator's loopback admin endpoint — which owns the
child processes: spawn under bun, restart on a changed artifact hash, crash
backoff, per-service logs. Per-service restart falls out of Alchemy's own
diffing — an edit re-runs converge, only the changed service's `Deployment`
reconciles, only that deployment is re-put, only its process restarts.

**The dev command is a view.** After converge it *attaches* through the
extension's `attach` hook — endpoints for the front door, merged log
streams, a stop control — and runs the watch loop (rebuild → re-assemble →
re-converge). Core renders what the hook returns and never learns any
emulator's API (the ADR-0038 opacity pattern). Ctrl-C stops the app's
service instances through the attachment and exits; the emulators, the
databases, and the bucket data persist, making the next start warm. A
detached mode (services keep serving with no session, full platform parity)
is a designed extension, not v1.

**Rebuilds stay the user's** (ADR-0005). Dev watches the *built* output that
assembly consumes, never sources; the user's own watcher (`next dev` is not
involved — `tsdown --watch`, `bun build --watch`, whatever their build does)
produces the rebuild, and dev responds by re-running assemble and converge.

**A service boots exactly as deployed.** The artifact's bootstrap calls
`run(address, boot)` against the same `COMPOSER_*` environment protocol a
deploy's platform injection produces — the local `Deployment` provider
materializes that environment from the same `EnvironmentVariable` records the
lowering emitted. Deserialization, stashing, `load()`/`config()`/`secrets()`
all execute the deployed code path.

## Reasoning

The goal this serves is recorded in [goals.md](../00-purpose/goals.md):
"Reproduce every element in the local dev emulator … each Resource ships a
**local stand-in beside its real provider**." The design question was only
*where* the stand-in boundary sits. Porting a real application onto the
framework settled it empirically: the port's hand-rolled dev script had to
reverse-engineer the deployment address from the module-graph builder,
hand-write the `COMPOSER_*` wire protocol, hand-start each emulator, and
hand-mint placeholder secrets — every line of it framework knowledge leaking
into an app repo. Whatever absorbs that script must produce *deploy-shaped*
truth, or local verification proves nothing about a deploy.

Three boundaries were available.

**The platform's HTTP API** — serve a local Management API and point the
existing client at it. Superficially minimal ("only the URL changes"), it fails
on inspection: the providers depend on the platform's *server-side behavior*,
not just its endpoint shapes. The deployment provider never sends env values at
version-create — the platform materializes the branch's config into the
deployment server-side, so an emulator must reimplement that join. Delete
retries match the platform's exact error prose. The deployment lifecycle is a
status machine (signed upload URL → async start → poll → promote → only then a
real domain). Roughly thirty endpoint operations are in use. All of it is
another team's contract, and drift is silent — no compiler flags an emulator
that has fallen behind the real platform. The wire ceremony also puts a
multi-second floor under every restart.

**The Alchemy provider interface** — the boundary chosen. The resource props
(`DeploymentProps`, `EnvironmentVariableProps`, …) are defined *in this repo*;
they are the contract the lowering already targets. A local provider set
implements the same typed contracts, so a props change breaks the local
providers in the same PR — drift is a compile error, not a discovery. Everything
above the boundary — addresses, config serialization, needs resolution
(ADR-0031), service keys (ADR-0030), migrations (ADR-0022), the origin channel
(ADR-0039, which works unchanged because the local `ComputeService` simply
reports `http://localhost:<port>` as its `endpointDomain`) — is the real deploy
code, not a copy of it.

**A bespoke dev harness beside the pipeline** — a supervisor that reads the
loaded graph directly, with a per-kind "dev descriptor" seam for stand-ins.
Rejected because the seam is an open set: every node kind, first-party or
community, would need a second provisioning implementation and could drift from
its deploy lowering indefinitely. The provider boundary inverts that economics:
extensions compose a **closed set** of resource types — they do not add
endpoints or providers — so one local provider set covers every module and
every community extension, permanently. The port's other empirical finding
supports the same choice: module-backed kinds (storage, streams, email) lower
to compute services plus databases, so under local providers they run their
*real service code* against local Postgres — no per-module stand-in needed at
all.

The bucket cluster is the one place emulator and reality could have diverged,
and the repo already closes it: the storage module implements the S3 wire
protocol over an `ObjectStore` interface with full SigV4 verification
(including presigned URLs), with memory- and Postgres-backed stores. The local
bucket emulator is a third store implementation — objects stored verbatim as
plain files at their key paths, so a developer can browse, inspect, and drop
files into a bucket with ordinary filesystem tools.

One philosophical note, recorded so the tension is legible: Alchemy's own dev
mode deploys real cloud resources and runs only code locally, precisely because
its authors consider emulation a lie. This framework cannot take that position —
credential-free local verification is a product requirement (agents must verify
without cloud access) — so it accepts local emulation, and keeps the lied-about
surface as small and as typed as possible: eight providers behind contracts
this repo owns.

## Consequences

- **Parity by construction above the provider boundary.** Lowering, addresses,
  the env wire protocol, service-key minting, S3-credential minting,
  migrations, warm-up, and origin resolution are the deployed code paths. The
  emulated surface is exactly eight providers.
- **Modules get local dev for free, forever.** Any kind — first-party or
  community — that lowers to the platform's resource types runs locally with no
  dev-specific work. Module-backed kinds run their real service code.
- **Dev exercises the real assembled artifact.** Assembly must therefore cover
  every supported app shape; the general directory-runnable build adapter is a
  prerequisite. Restart latency is bounded by assemble + package + converge;
  the local `Deployment` provider owns artifact caching (unpack once per hash).
  Measure before optimizing further.
- **The extension factory must not require platform environment for dev.** The
  hosted factory's required workspace variable stays deploy-only; the `dev`
  path resolves no credentials at all.
- **A new operational dependency:** the ORM CLI's local Postgres (`prisma dev`)
  is the postgres emulator. Dev shells out to a sibling product's command.
- **Dev state is local and disposable.** The Alchemy state store is Alchemy's
  own `localState()` (`.alchemy/state/`); the app-scoped state — env store,
  unpacked artifacts, bucket objects, minted placeholders — lives under
  `.prisma-composer/dev/` (ADR-0004's tool-state rule), while the emulator
  daemons keep their own machine-global registry. `--fresh` is wholesale
  local deletion through `dev.teardown` (every resource is a local file,
  process, or emulator instance), never an `alchemy destroy`.
- **Process supervision lives in the Compute emulator, not the CLI.** The
  framework owns a small, generic daemon layer (registry, stable ports,
  readiness, version-skew restart) and the Compute emulator's supervision
  policy; the dev command itself supervises nothing — it renders the
  `attach` hook's view.
- **The strict secrets model is unchanged** (ADR-0029). Dev policy lives in
  `dev.preflight`: a secret slot bound in the shell's environment is used; an
  unbound slot gets a minted, persisted placeholder and a printed warning. An
  env-sourced *param* (ADR-0032) with no shell value is a hard error instead —
  params feed schema validation at boot, so junk there produces a confusing
  crash rather than a legible degraded mode. `secrets()` stays eager and
  all-or-nothing in every environment.
- **Scheduled work runs for real** (ADR-0020): the scheduler is an ordinary
  service and fires locally. A manual-trigger affordance for
  determinism-sensitive workflows is a domain-doc concern, not a model change.
- **Hot reload is deliberately absent from this decision.** The dev loop's unit
  of change is a rebuilt artifact, not a source edit. A per-service opt-in that
  runs a user-supplied dev command (`next dev`) with framework-injected
  bindings is designed as an extension in
  [local-dev.md](../10-domains/local-dev.md), not part of this decision.

## Alternatives considered

- **A local Management API (HTTP emulation).** Rejected above: it reimplements
  another team's server-side semantics (config materialization at
  version-create, error prose that client retry logic string-matches, the
  upload/start/poll/promote status machine) across ~30 endpoint operations,
  drifts silently, and keeps the full wire ceremony in the inner loop. The
  provider boundary preserves its one real virtue — the pipeline runs
  unchanged — at a contract this repo owns and the compiler checks.
- **Cloud-backed dev** (real platform resources, only code local — Alchemy's
  own dev philosophy, Wrangler's remote bindings). Rejected: credential-free
  local verification is a product requirement; an agent or CI job must bring up
  and exercise the topology with no workspace, token, or network dependency.
  Remote bindings remain a possible future opt-in, not part of this decision.
- **A bespoke dev harness with per-kind dev descriptors** (a third execution
  path beside deploy and test). Rejected: an open-set, per-kind parallel
  provisioning seam that every extension must implement and keep from drifting,
  duplicating exactly the orchestration the deploy pipeline already performs —
  and contradicting goals.md's stand-in-beside-provider shape.
- **Direct-injection boot** (`service.runLocal(values)` — hand the service its
  hydrated bindings, bypassing the env wire protocol). Retained as a *testing*
  convenience only. Dev drives the real `run(address, boot)` path so that
  serialization, address handling, and stashing are exercised as deployed;
  a bypass here would make local verification prove less than it appears to.

## Related

- [goals.md](../00-purpose/goals.md) — the local-dev-emulator goal this
  decision implements ("a local stand-in beside its real provider").
- [`../10-domains/local-dev.md`](../10-domains/local-dev.md) — the domain deep
  dive: pipeline deltas, the Compute emulator, substitution details, value
  sourcing, error surface.
- [`../05-prisma-cloud/alchemy-lowering.md`](../05-prisma-cloud/alchemy-lowering.md)
  — the resource inventory and lowering graphs the local providers implement.
- [`../10-domains/deploy-cli.md`](../10-domains/deploy-cli.md) — the pipeline
  dev re-runs; its scope note points here.
- [ADR-0005](ADR-0005-users-build-the-framework-assembles.md) — users build;
  dev watches built output only.
- [ADR-0007](ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md)
  — the terminating converge child the machine-scoped emulators decouple
  dev from.
- [ADR-0011](ADR-0011-targets-supply-the-deploy-state-layer.md) — targets
  supply the durable deploy state layer; dev instead uses Alchemy's own
  `localState()` through `LowerOptions.state` (tool state, ADR-0004).
- [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md) /
  [ADR-0038](ADR-0038-containers-are-an-extension-descriptor.md) — the
  extension-descriptor pattern `dev` extends.
- [ADR-0020](ADR-0020-scheduled-work-is-a-driver-not-a-resource.md) — why cron
  fires for real in dev.
- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) /
  [ADR-0031](ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md) /
  [ADR-0032](ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md)
  — the secret/need/source model dev's value-sourcing policy plugs into.
- [ADR-0030](ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md)
  — service keys, minted identically in dev.
- [ADR-0039](ADR-0039-a-compute-services-own-origin-is-a-target-resolved-property.md)
  — origin resolution, which works in dev unchanged.

# Design notes — alchemy-provider-adoption

## Principles

- Own zero Management-API wrapper code that upstream also owns.
- Composer's local-dev iteration speed must not depend on upstream review
  latency (operator decision, 2026-08-03).
- Upstream's opinionated guards are adopted, not fought — each one we checked
  (named-DB+branch refusal, system-managed env refusal, pooled-first URL) was
  correct or workaroundable on our side.

## The model

One provider (upstream's), two provider *layers* on Composer's side:

- deploy: upstream's live providers (needs the `liveProviderLayer` export or a
  local rebuild of its wiring — client layer + individual `*Provider()`s).
- dev: Composer's emulator providers bound to upstream's resource classes,
  substituted at `LowerOptions.providers` (`deploy.ts:203`) exactly as ADR-0041
  does today.

State: hosted Postgres store unchanged; rows migrate off the colliding
type-ids. Auth: `Layer.succeed(PrismaEnvironment, {token, baseUrl})`, skipping
alchemy's profile store.

## Alternatives considered

- **Contribute emulators upstream** (original proposal, in wip notes): rejected
  for now — couples our dev loop to Sam's dual-mode design and review cadence.
- **Adopt `ProviderLayer.dual`**: solves cross-mode state stamping we don't
  need (dev and deploy use disjoint state stores). Revisit if that ever
  changes.
- **Vendor `src/Prisma/` into Composer**: works on beta.59 (provider uses no
  newer core APIs) but inherits `@prisma/dev` dep + permanent drift. Only a
  fallback if the beta bump stalls badly.
- **Keep our six resources**: rejected — the spike showed upstream is strictly
  more hardened on deploy lifecycle and we'd keep paying API drift.

## Decision: the compute family adopts App + Deployment + EnvironmentVariable, not Compute

Decided in slice 2, with the descriptor rewiring in front of us. Composer binds
upstream's three low-level resources; `Prisma.Compute` is not used at all.

**What decided it — a dependency cycle Compute cannot express.** Every Compute
service gets a `COMPOSER_<ADDRESS>_ORIGIN` environment row whose value is that
same service's own platform-assigned endpoint domain (ADR-0039; the value
function is `selfOriginValue` in `control/extension.ts`). `Prisma.Compute` is
one resource that owns the app, its environment rows, and its deployment
together, so that row would be an input of the very resource that produces the
domain — a self-edge. Alchemy's planner fails such a cycle unless the resource
implements `precreate` to signal an attribute early, and no Prisma provider
implements `precreate`. Splitting the app out is what makes the wiring legal:
`Prisma.App` is created in `provision` and hands out `appEndpointDomain` before
any environment row is written, and `Prisma.Deployment` is created afterwards
in `deploy`. The same split is what lets one service's row carry another
service's origin without ordering the two deployments against each other.

**Three more reasons, none of them decisive alone.**

- *Environment ownership.* Compute manages the rows itself, keyed by an
  `environmentVariableIds` map it stores in its own attributes, and refuses any
  row in scope that is not in that map. Migrating Composer's existing
  per-key `EnvironmentVariable` state rows into one Compute resource's map has
  no honest mapping; keeping them as resources does.
- *ADR-0005.* Compute carries build, framework detection, entrypoint inference,
  and effect-native bundling. `artifactPath` bypasses all of it, but the
  bypass is a prop value, not a structural guarantee. `Prisma.Deployment` has
  no build path at all to fall through to.
- *The local emulators.* Compute is a `Platform` (runtime context, bindings,
  dev process spawning). The three low-level classes are plain resources, which
  the emulator providers bind to exactly as they bound Composer's own three.

**What we give up by not taking Compute:** preview/stable health checks,
automatic rollback, and — the one that matters — environment values folded into
the fingerprint that decides whether a new deployment is needed. See below.

## The environment→deployment edge after the swap (PRO-211)

Upstream's `Prisma.Deployment` has no `environment` prop, so the edge rides
`app`: the descriptor builds that prop as an expression over the app id AND
every environment row's id, resolving to the app id itself
(`compute/deployment-edge.ts`). Alchemy derives its dependency graph from the
resource references a prop's value is built from, so every variable write is
scheduled before the deployment is created. That is the ordering PRO-211 needs,
and the ordering is what `docs/design/05-prisma-cloud/alchemy-lowering.md`
records as the edge's job.

**`app` is the only prop that can carry it**, and this is not a style
preference. Upstream's diff reads `{portMapping, skipCodeUpload, artifactPath,
artifactContentType}` as one block and returns "no opinion" the moment any of
them is unresolved (`Deployment.ts:361-367`). A brand-new variable has no
persisted state, so the planner resolves its reference to a bare resource
expression (`Plan.ts:369-371`) — meaning a deploy that adds a variable would
leave that whole block unresolved, the artifact comparison would never run, the
engine would fall back to a plain update, and reconcile would keep the running
deployment *while recording the new artifact's fingerprint as deployed*. The
code change would be dropped, and every later deploy would agree it had already
shipped. `app` sits outside that block and its own check treats an unresolved
app as unchanged (`Deployment.ts:376-378`, `concreteIdsChanged`). The first
implementation of this slice used `artifactPath` and had exactly that defect;
`compute/__tests__/deployment-edge.test.ts` fails if it ever comes back, because
it drives the real Output machinery and upstream's real diff rather than
eager-collapse stubs.

What does NOT survive the swap is a side effect the old provider had: because
Composer's deleted `Deployment` created a brand-new deployment on every
reconcile, a changed environment *value* shipped a new deployment as well. With
upstream, an unchanged artifact plans an update, and its reconcile re-uses the
existing deployment — so a value-only change reaches the platform's variable
row but not the running deployment until the next artifact change.

We chose not to reproduce it, because every available mechanism is worse than
the gap:

- Upstream recreates a deployment only when its artifact fingerprint moves.
  Feeding the environment into that fingerprint means hashing the desired
  values into Alchemy state — which the lowering doc rejects outright ("a hash
  of a secret is itself a leak"), and which upstream itself only does inside
  `Compute`, where the fingerprint is stored `Redacted`.
- Making the fingerprint move without hashing values (a per-generation artifact
  hard link, or a generation counter in the deployment's logical id) works only
  through upstream's *path-string* comparison, which upstream could drop at any
  time — the fix would disappear silently.

The honest fix is upstream's: either a `Prisma.Deployment` prop that takes
inputs the deployment should be recreated for, or `Compute`'s env-in-fingerprint
made available to the low-level resource. Slice 3 is the place to offer it.

## The poison DATABASE_URL rows are gone

`application.provision` used to overwrite the platform's seeded `DATABASE_URL`
and `DATABASE_URL_POOLED` with `"-"` so nothing could rely on the platform
default. The platform marks both system-managed, and upstream's
`EnvironmentVariable` refuses to manage a system-managed variable, so those
writes are removed rather than reshaped (they would fail the deploy). What
still holds the line is the ban at the authoring end: `param.ts` and
`secret.ts` reject both names, so no Composer-written row can carry one, and
`configKey` puts every Composer row in the `COMPOSER_` namespace.

Existing poison state rows are marked `removalPolicy: "retain"` on read (see
`state/legacy-resources.ts`), so the engine drops the state row, calls no API,
and reports `retained` — the truthful verb. The deployed smoke run caught the
first version of this: it reported `deleted`, which told an operator the
platform variable was gone when it was still there.

Residual, and it differs by stage:

- A stage Composer never deployed before the swap: `DATABASE_URL` holds the
  platform's own template value. An app reading it directly gets a working
  default rather than something that fails loudly — that is the protection we
  lost.
- A stage Composer HAD deployed: the `"-"` placeholder it wrote is still on the
  platform, user-managed (`isManagedBySystem: false`), and stays until an
  operator deletes it. `docs/guides/deploying.md` gives the call. So a migrated
  stage keeps the old fail-loudly behaviour by accident, indefinitely, unless
  someone cleans up.

## What the swap costs us, precisely

Two behaviours got worse, and neither is mitigated on our side.

**App delete retry budget: 5 minutes → about 4 seconds.** Composer's deleted
`ComputeService` provider retried the platform's "did not reach a delete-safe
state" 409 on an exponential schedule capped at 5 minutes. Upstream's
`destroyApp` (`ComputeLifecycle.ts:276-310`) retries any conflict 5 times with
250ms · 2^attempt between them — 3.75 seconds of waiting in total — and it does
NOT drain the app's deployments first; it deletes the App and relies on the
platform's cascade. Alchemy does delete a *tracked* `Prisma.Deployment` before
the App that owns it, because the resource graph orders them, but any untracked
deployment still winding down can still 409 the App delete past that budget. A
destroy of a stage that was serving traffic seconds earlier is the case to
watch.

**Environment-value change no longer redeploys.** Covered above.

## Upstream asks (slice 3)

- **A `Prisma.Deployment` prop for "recreate when these inputs change."**
  Without one, the environment cannot be part of what identifies a deployment,
  and the change-propagation gap above stays. `Compute` already folds `env`
  into its fingerprint and stores that fingerprint `Redacted`; the low-level
  resource needs the same seam.
- **Raise or make configurable the App delete-retry budget** (or drain the
  app's deployments before deleting it).
- **Export `PrismaUploadClient` / open the `alchemy/Prisma/Internal/*` subpath.**
  Its package export is explicitly `null`, so the scoped upload client cannot be
  composed privately by an outside stack; the only alternative is overriding the
  ambient `HttpClient`, which is a much blunter instrument.

## Why no environment-derived fingerprint exists yet (the search, recorded)

Everything an `EnvironmentVariable` exposes was checked for "moves when the
value moves":

- `updatedAt` moves on EVERY deploy, not on every change: upstream's diff
  returns an update whenever the desired value is resolved, to heal
  out-of-band drift (`EnvironmentVariable.ts:290-296`), and reconcile then
  PATCHes unconditionally (`:378-386`). Folding it into a deployment prop would
  restore Composer's OLD behaviour of shipping a new deployment on every single
  deploy — not value-change detection.
- `valueKid` identifies the encryption key, not the value; it carries no change
  semantics.
- The plaintext is write-only and never read back, so nothing observable
  distinguishes "same value re-applied" from "new value".

The durable statement: **the only attribute that moves at all fires on every
deploy.** Any real fix must come from the deployment side.

## Open questions

Tracked in spec.md (state-migration mechanics; first released beta). The
Compute-vs-App+Deployment question is settled above.

## References

`wip/alchemy-prisma-provider-notes-for-aman.md`; spike session artifacts;
upstream PRs #416, #963.

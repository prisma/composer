# Forcing-Function Apps — Project Plan

## Summary

Two milestones. **M1 (datahub)** is fully sliced: secrets and the emulated
cron resource System land in the framework while the datahub port proceeds in
parallel, converging on a production cutover. **M2 (open-chat + dev loop)** is
sketched — its slices are firmed at the M1-close health check, where we also
decide whether M2 becomes a successor project instead.

**Spec:** [spec.md](spec.md) · **Design notes:** [design-notes.md](design-notes.md)

## Tracker

Slices are identified by their S-number here; this plan is the source of truth.
Linear issues are created per-slice when the slice starts, not during planning.
Tracker project: [Prisma App: Forcing-Function Apps](https://linear.app/prisma-company/project/prisma-composer-forcing-function-apps-495e5a5c6a0d).

## External dependencies

- **System composition (`hex-composition` project)** — branch
  `claude/system-composition`. This delivers the resource-as-System seam our
  resource slices consume; see § "What we consume from hex-composition" below.
  Blocks S3 (and M2's S5).
- **Publishing pipeline** — [PR #29](https://github.com/prisma/app/pull/29);
  blocks S2's "consume published packages" condition.
- Both are in flight in other sessions; neither blocks S1.

## What we consume from hex-composition (do not re-derive)

The resource-as-System seam is **owned by the hex-composition project**, not
this one. We build our resource slices on its resolved model rather than
spiking it ourselves:

- **ADR-0016** — a system has the same boundary as a service
  (`SystemNode<Deps, Expose>`); systems nest and `provision()` accepts a system
  wherever it accepts a service.
- **The resource-decoupling / unified model** — `resource()` takes
  `provides: Contract`; `provision(id, resource)` flattens that contract onto
  the ref; a resource-backed input forwards across a system boundary. This is
  how an emulated resource presents a binding without leaking its
  implementation.
- **H3 (their last slice)** — a reusable auth system plus a same-contract fake,
  proven live in CI: swap the backing, consumer unchanged. Our object-storage
  swap (S5) is a second instance of exactly this pattern; we reuse it, we don't
  reinvent it.

**One open question is ours to coordinate, not consume:** the **cron
reverse-edge**. hex-composition's model is consumer-calls-resource; cron
*invokes* the consumer on a schedule. Nothing in ADR-0016's Deps/Expose/
forwarding expresses a scheduled reverse edge. Before S3 is specced, settle
with the hex-composition session whether this is a new composition capability
(lives there) or something our cron System expresses on top of the existing
primitives. This replaces the cancelled S0 spike — it is a design conversation
with that session, not a parallel spike against their moving target.

## Milestone 1: datahub on the framework

### S1 — Secrets as bindings — RESOLVED, NO SLICE

The Config Params + Cron project absorbed the immediate need (a `secret`
param facet the port could declare against), and
[ADR-0029](../../../docs/design/90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md)
then settled the model: secrets are not params but their own forwardable slot
(`secret()`/`envSecret()`/`secrets()`), bound where the service is
provisioned, with the deployer's env as a first-class source. No separate
secrets slice or ADR remained for this project to deliver.

### S2+S3 — datahub port (skeleton + cron) — DONE, one slice (TML-3012)

Cron shipped alongside the port
([#45](https://github.com/prisma/composer/pull/45), merged), so S2 and S3 ran
together. Spec: [slices/datahub-port/spec.md](slices/datahub-port/spec.md).
Datahub branch `claude/prisma-app-port`: `system.ts` (postgres +
cron(ingest-as-router) + web), ingest params from the original zod schemas
with secret facets, the in-process `TICK_INTERVAL_MS` scheduler deleted (the
cron scheduler is the only clock), framework packages via pkg.pr.new previews
of #45. Proven by a `Load(system)` graph test and a `bootstrapService` boot of
the real ingest entry (health + trigger dispatch). Port evidence recorded
under Follow-ups.

The port predates the Composer rename and ADR-0029, so its preview pins,
`@prisma/app-*` imports, and secret-facet params need refreshing before S4.

### S4 — datahub live deploy + cutover

Refresh the port to the current surface (`@prisma/composer*` packages,
first-class secrets), deploy it via `prisma-composer deploy` with the team's
real secrets and workspace credentials, verify equivalence against the
current deployment, and cut the team's real instance over. Closes M1.
**Operator-gated** — needs credentials agents don't hold.

- **Builds on:** S2+S3 (done); published `@prisma/composer*` packages
  replacing the port's preview pins.
- **Hands to:** M2 — port mechanics proven, first emulated resource in
  production.

### Follow-ups (evidence from the S2+S3 port)

- **postgres conversion of `@workspace/db`** (ADR-0022): datahub's db layer
  is prisma/orm with a contract — exactly what `postgres` types. Converting
  would also eliminate the phantom-dependency fragility the port had to pin
  around (`@prisma-next/*` + `pg` reached only via hoisting; adding the cloud
  target package broke the hoist and silently degraded `db.orm` to `any`).
- **A blessed pattern for module-global DB clients.** The port bridges
  `DATABASE_URL` from `load()` ad hoc (ingest: dynamic-import entry; web:
  `instrumentation.ts` + a lazy client). Real apps will keep hitting this;
  the framework should bless one pattern.
- **Deploy-time param values.** The port sourced secret values from the
  deployer's env by app-side convention (`fromEnv()` defaults), with no
  framework check that a required value is present at deploy. ADR-0029's
  `envSecret()` resolves this for secrets; plain params still rely on
  defaults evaluated at deploy-load.
- **Next.js static generation never runs `instrumentation.ts`** (Next 16.1.6):
  a page that queries the DB at build time can't get its config from `load()`;
  the port went `force-dynamic`. Worth a documented stance for the nextjs
  adapter.
- **bun tarball fan-in bug**: 3+ workspace packages depending on the same
  pkg.pr.new tarball URL makes `bun install` fail non-deterministically until
  the cache warms (repros on bun 1.3.13/1.3.14). Worth an upstream repro if it
  recurs.

## Milestone 2: open-chat + dev loop (sketch)

Slices below are placeholders, firmed at the M1-close health check (also the
decision point for splitting M2 into a successor project):

- **S5 — Object storage as an emulated resource System**: blob contract, postgres + R2 backings, the swap demonstration — a direct application of hex-composition's H3 pattern (reusable system + same-contract fake).
- **S6 — Streams as a resource**: design pass first (wrapper System vs managed primitive).
- **S7 — open-chat port**: builds on S5, S6 (+ S1, S3 from M1).
- **S8 — The local dev loop**: builds on S7 — deliberately last, after two ports' worth of evidence.

S5 and S6 are parallel; S7 joins them; S8 closes.

## Close-out (required)

- [ ] Verify all acceptance criteria in [spec.md](spec.md) § Project-DoD
- [ ] Migrate long-lived docs into `docs/` (ADRs: secrets, cron reverse-edge if new, dev loop; cron/object-storage contract specs). The resource-as-System ADR is hex-composition's (ADR-0016), not ours.
- [ ] Strip repo-wide references to `.drive/projects/forcing-function-apps/**`
- [ ] Delete `.drive/projects/forcing-function-apps/`

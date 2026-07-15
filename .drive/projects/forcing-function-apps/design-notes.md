# Design notes — Forcing-function apps

Running design record for the project. Decisions that outlive the project get
promoted to ADRs at close-out; findings accumulate here per slice.

## Principles inherited

- Users build, the framework assembles (ADR-0005).
- Resources are provisioned by Systems; dependencies are declarations
  (ADR-0013).
- Dependencies resolve to bindings; clients are app-side (ADR-0015).
- Targets are extension packs; core stays target-agnostic (goals.md).

## The model this exercises

A **forcing-function app** is a real application, in daily use, ported onto
the framework so that its concrete needs pull capabilities into existence.
The pull ordering is the roadmap; nothing is built ahead of a consumer.

An **emulated resource System** is a resource type the platform doesn't offer,
implemented as a System composed from primitives it does offer (compute +
postgres), exposed to consumers only through a binding contract. The contract
is the product; the emulation is scaffolding. The seam it proves — swap the
backing, consumer unchanged — is the same seam as native-primitive adoption
and cross-platform resource portability.

## Key decisions

1. **Real apps over hypotheticals** (operator, 2026-07-11). A hypothetical
   (README storefront, invented agent-bot) exerts pressure once and decays;
   apps the team depends on keep exerting it. Candidates assessed: agent
   review-bot (invented), README storefront (toy), datahub, open-chat.
2. **datahub first, open-chat second** (operator + agent, 2026-07-11).
   datahub's topology (2 services + postgres + cron + secrets) is a strict
   subset of open-chat's (+ streams + object storage + Stripe webhooks +
   hard local-first pressure). Sequencing cheapest-superset-first derisks the
   port mechanics before the resource surface widens.
3. **Emulate cron + object storage rather than wait for the platform**
   (operator, 2026-07-11). Decouples the framework roadmap from the platform
   team's; makes composition (ADR-0016/0017 branch) the mechanism for
   building resources, not just app code; hands the platform team a
   ready-made contract spec.
4. **No second target pack yet** (agent proposal, operator direction
   pending nothing — accepted in discussion). R2 as an object-storage backing
   exercises cross-platform at the resource level for a fraction of the cost
   of a Vercel/Supabase pack.
5. **Ports consume published packages from their own repos** (default,
   confirmed at slice time). Makes the project the first real consumer of the
   publishing pipeline (PR #29) and keeps the framework repo's examples from
   becoming shadow copies of real apps.

6. **The resource-as-System seam is owned by hex-composition, not this
   project** (operator, 2026-07-11). An S0 spike to design the seam here was
   drafted and **cancelled**: the `hex-composition` project (branch
   `claude/system-composition`) is actively building exactly that — ADR-0016
   (`SystemNode<Deps, Expose>`), the resource-decoupling unified model
   (`resource()` provides a Contract; resource-backed inputs forward across a
   system boundary), and H3 (a reusable auth system + same-contract fake proven
   in CI = swap-the-backing-consumer-unchanged). Spiking it in parallel would
   collide with their moving target. This project **consumes** that output; our
   object-storage swap (S5) is a second instance of the H3 pattern. The one
   piece hex-composition does not cover — the **cron reverse-edge** (a resource
   that invokes the consumer on a schedule) — is resolved by a design
   conversation *with* that session, not an independent spike. See
   [[hex-composition-coordination]].

7. **Cron + the config-model change became their own project** (2026-07-11).
   Designing cron (S3) revealed that the real blocker is that config params can't
   carry a structured value (the schedule) — a foundational config-model change
   (schema-typed params + target-owned serialization). That foundation was carved
   into its own project, **[config-params-and-cron](../config-params-and-cron/spec.md)**
   (ADR-0018/0019/0020), with cron as its first consumer. This project's S3 shrinks
   to "datahub consumes that cron," and object storage (S5) will reuse the
   structured-param mechanism.

## Alternatives considered

- **Agent service (review/triage bot) as the forcing app** — good capability
  coverage (queue, secrets, cron, storage) but had to be invented; rejected
  in favor of preexisting apps with real users.
- **README storefront built for real** — makes the pitch honest but nobody
  depends on it; pressure decays after first build.
- **Second platform (Vercel/Supabase) as the next move** — forces
  cross-platform immediately but doubles pack surface before composition,
  secrets, and the resource contracts have settled. Staged instead: resource
  backing on another platform now (R2), target pack later.
- **Building a second resource type as a goal in itself** — rejected framing
  (operator): resources arrive only when an app needs them. The abstraction
  still gets its stress test — streams and cron are maximally unlike
  postgres (they invoke the service rather than being called by it).

## Open questions

Tracked in [spec.md](spec.md) § Open questions: port location, oss.chat
cutover, streams integration shape, secrets backing, dev-loop architecture.

## References

- [spec.md](spec.md), [plan.md](plan.md)
- Prior project artifacts: `.drive/projects/mvp-example-app/`,
  `.drive/deferred.md`
- [prisma/datahub](https://github.com/prisma/datahub),
  [prisma/open-chat](https://github.com/prisma/open-chat),
  [prisma/streams](https://github.com/prisma/streams)

## Streams consumer auth — settled by ADR-0030 (2026-07-15)

The streams slice shipped with a root-bound `secret()` bearer key and a
`{ url }`-only binding: consumers declare their own secret slot and the root
binds both to one platform variable. Flagged in review as the first
authenticated module contract — the two slots are connected only by
convention (nothing checks they name the same variable; a mismatch deploys
green and 401s at runtime).

PR #89 (ADR-0030, rpc-service-key project) settles the pattern framework-wide:
wired-peer auth uses a **framework-minted service key carried on the binding's
own config rail** (like the URL), kept in deploy state — explicitly not an
ADR-0029 secret, which is reserved for user-supplied external values.

**Follow-up (blocked on #89 slice 2 — the ServiceKey resource + generic
per-edge value channel):** re-shape streams to match — drop the module's
`apiKey` secret slot, mint the key at deploy, binding becomes
`{ url, apiKey }`. Constraint: `@prisma/streams-server` auth is single-key
(`API_KEY`), so v1 is one minted key per module instance delivered on every
binding; distinct per-edge keys need an upstream accepted-key-set change
(mirroring what #89 slice 1 added to rpc's serve()) — candidate minimal
upstream PR. Do this before S7 (open-chat port) consumes the module.

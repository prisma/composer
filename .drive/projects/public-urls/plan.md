# Public URLs — plan

**Spec:** [spec.md](spec.md) · **Decisions:** ADR-0059 to ADR-0062, `docs/design/05-prisma-cloud/public-url.md`, pdp-control-plane ADR 015.

Four tracks in three repositories. They share no code; what they share is the design, which is already recorded. The Prisma Cloud track waits on one core slice and one upstream slice, both small, and everything else runs in parallel. The platform track is the longest and starts first.

Tracking: Will tracks this work outside Linear.

## Track U — upstream Alchemy (alchemy repo, `alchemy/Prisma`)

### U1. `Prisma.CustomDomain` works on any Branch

Remove `ensureDefaultBranchApp` from `src/Prisma/CustomDomain.ts`. PDP doesn't enforce the rule, so the check only blocks named hostnames on `staging` and preview environments.

- **Builds on:** nothing. Starts immediately.
- **Hands to:** P1 can attach a hostname on any environment.
- **Done when:** the upstream resource registers a hostname on a non-default Branch of a test project, and Composer's pin moves to the release that carries it.

### U2. A Public URL resource over PDP's new routes

A `Prisma.PublicUrl` resource: create (no DNS needed), read status, update hostname or target, delete; found by `logicalId`. Replaces `Prisma.CustomDomain` for Composer.

- **Builds on:** D1.
- **Hands to:** P2.
- **Done when:** a hostname with no DNS creates a pending record and the resource reports its state on later reads.

## Track C — Composer core (prisma/composer)

### C1. `resolve()` and the second evaluation pass

`resolve(deps, fn)` returning `ResolvedValue<T>`, accepted wherever a value of type `T` is. The first version takes an empty `deps` list and passes `fn` the environment's name. After Load, `provision` is disabled and every `ResolvedValue` is run and validated; only the resolved graph reaches lowering. Also: a node may be constructed with its edge already set (what `publicUrl`'s `target` needs).

- **Builds on:** nothing. Starts immediately.
- **Hands to:** P1 (per-environment `url`), C5.
- **Done when:** a service input bound to a `resolve()` value differs between two environments of a test app, `provision` inside `fn` fails with an error naming the rule, and a `fn` that returns an invalid value fails the deploy before anything is created.

### C2. The term is environment

`--environment` on `prisma deploy` and `prisma dev` (`--stage` removed); `destroy` targets an environment by name, `{ kind: 'production' }` retired; local dev runs as the environment the user names, `dev` by default. Guides, error messages, the agent skill and public types follow. Breaking, so it ships as one release.

- **Builds on:** ADR-0059 (prisma/composer#385) merged.
- **Done when:** no public surface says "stage", and the examples' CI deploys with `--environment`.

### C3. Spike: typed per-key references to a module's `input`

Prove that a module body can read `input.someKey` as an opaque, typed reference without Composer introspecting the schema, that Load records which key flows where, and that a reference passed anywhere other than an input or `resolve()` errors clearly.

- **Builds on:** nothing.
- **Hands to:** a findings note in `assets/`; if it fails, back to design before C4.

### C4. Modules declare `input`

Per ADR-0061: `module()` takes `input` instead of `params` and `secrets`; the root may declare it; `paramNeed()` and the module form of `secret()` go. The shipped `auth()` and `email()` modules and the examples migrate.

- **Builds on:** C3.
- **Done when:** every example and shipped module uses `input`, and a root with `input` loads.

### C5. `resolve()` over inputs, and config adapters

`resolve([input.a], (a, environment) => …)` typed from the schema; the `config` field on the `composer` section, each adapter a function of the environment's name, merged by top-level key, later wins; `dotenv()` as the first adapter.

- **Builds on:** C1, C4.
- **Done when:** a root input filled from `.env.<environment>` reaches a service through `resolve()`, and a required key missing from every adapter fails the deploy with the schema's error.

## Track P — Composer, Prisma Cloud extension (prisma/composer)

### P1. `publicUrl()` with both strategies

`publicUrl({ name, url, target })` and `publicUrl.hostname()` / `publicUrl.generated()`, with a bare string as shorthand for a named hostname. `generated()` lowers to nothing on the platform and reports the service's existing `*.prisma.build` URL. `hostname()` lowers to `Prisma.CustomDomain`; a hostname whose DNS isn't ready fails the deploy, as a custom domain does today. One `DeployedEntity` per public URL. The local target's stand-in creates nothing and warns once that a named hostname is ignored. The node has a `logicalId` in the topology but no platform row yet.

- **Builds on:** C1, U1.
- **Done when:** a test app with one public service shows that service alone as public in the topology; a named hostname with DNS in place serves on production and on a preview; a named hostname without DNS fails the deploy naming the hostname and the DNS step.

### P2. Pending hostnames

`hostname()` lowers to the new Public URL resource. A hostname without DNS deploys in a pending state, the deploy output names the outstanding step and prints PDP's Console link, and finishing DNS needs no redeploy.

- **Builds on:** P1, U2.
- **Done when:** the scenario in the spec's "At a glance" deploys production before `shop.com`'s DNS exists, succeeds, and the hostname goes active after DNS is added with no further deploy.

## Track D — PDP (prisma/pdp-control-plane)

### D1. Public URL and Domain records

Per ADR 015: the two tables, Management API routes (Public URL create/update/delete/list by Branch, lookup by `logicalId`; Domain prove/list), creation with no Foundry call, promote re-pointing with failures on the record's `state`, the uniqueness rule enforced on create, the backfill of existing custom domains and TXT proofs. No Foundry change.

- **Builds on:** ADR 015 agreed. Starts immediately; longest slice.
- **Hands to:** U2.
- **Done when:** a Public URL created without DNS is `pending`, becomes `active` after Verify and connect, survives a promote and a service deletion, and a second record naming its hostname is refused.

### D2. Console shows public URLs and actual exposure

Each service's Public URLs with their state and the setup link; every service's actual reachability while all services are still public, so no service is presented as private.

- **Builds on:** D1.
- **Done when:** the Console page for a service in the test project shows both, verified with screenshots in the PR.

## Order

```
U1 ──────────────┐
C1 ──────────────┼─▶ P1 ───────────────┐
D1 ──▶ U2 ───────┴─────────────────────┴─▶ P2
       └─▶ D2
C2 (after #385 merges)
C3 ──▶ C4 ──▶ C5 (needs C1)
```

U1, C1, D1, C2 and C3 start at once, each in its own session. P1 starts when C1 and U1 have merged. P2 is the last slice.

## Close-out

Delete this folder once P2 and C5 have shipped. Long-lived facts are in the ADRs and `docs/design/05-prisma-cloud/public-url.md`; the scenarios and domain map there are updated as the slices land.

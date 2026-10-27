# Public URLs — plan

**Spec:** [spec.md](spec.md) · **Decisions:** ADR-0059 to ADR-0062, `docs/design/05-prisma-cloud/public-url.md`, pdp-control-plane ADR 015 · **Execution decisions:** [design-notes.md](design-notes.md)

Eight slices in four tracks across four repositories. Eight is above the usual limit of four. The tracks share no code; what they share is the design, which is already recorded, so they run in parallel with no coordination beyond the Management API routes ADR 015 defines. Splitting them into one project per repository would add bookkeeping without removing a dependency. The module-input work that would have made eleven is a follow-on project (`.drive/deferred.md`).

Owners: Will and the orchestrating agent do U1 and D1 together in this session. Every other slice is dispatched to its own session. Will tracks this work outside Linear, so no Linear issues are created.

## Track U — upstream Alchemy (alchemy-run/alchemy, `src/Prisma/`)

### U1. `Prisma.CustomDomain` works on any Branch

Remove `ensureDefaultBranchApp` from `src/Prisma/CustomDomain.ts` and the test that asserts the refusal. PDP doesn't enforce the rule, so the check only blocks named hostnames on `staging` and preview environments.

- **Builds on:** nothing. Starts immediately. Will and the orchestrating agent.
- **Hands to:** P1 can attach a hostname on any environment.
- **Done when:** the upstream resource registers a hostname on a non-default Branch of a test project, the change is in an Alchemy release, and Composer's pin moves to it.

### U2. A Public URL resource over PDP's new routes

A `Prisma.PublicUrl` resource: create (no DNS needed), read state, update hostname or target, delete; found by `logicalId`. Replaces `Prisma.CustomDomain` for Composer.

- **Builds on:** D1 deployed.
- **Hands to:** P2.
- **Done when:** a hostname with no DNS creates a pending record and the resource reports its state on later reads, and the change is in an Alchemy release.

## Track C — Composer core (prisma/composer)

### C1. `resolve()` and the second evaluation pass

`resolve(deps, fn)` returning `ResolvedValue<T>`, accepted wherever a value of type `T` is. This version takes an empty `deps` list and passes `fn` the environment's name. After Load, `provision` is disabled and every `ResolvedValue` is run and validated; only the resolved graph reaches lowering. Also: a node may be constructed with its edge already set, which `publicUrl`'s `target` needs.

- **Builds on:** nothing. Starts immediately.
- **Hands to:** P1 (per-environment `url`).
- **Done when:** a service input bound to a `resolve()` value differs between two environments of a test app, `provision` inside `fn` fails with an error naming the structure rule, and a `fn` that returns an invalid value fails the deploy before anything is created.

### C2. The term is environment

`--environment` on `prisma deploy` and `prisma dev` (`--stage` removed); `destroy` targets an environment by name and `{ kind: 'production' }` is retired; local dev runs as the environment the user names, `dev` by default. Guides, error messages, the agent skill and public types follow. Breaking, so it ships as one release.

- **Builds on:** ADR-0059 (prisma/composer#385) merged.
- **Done when:** no public surface says "stage", and the examples' CI deploys with `--environment`.

## Track P — Composer, Prisma Cloud extension (prisma/composer)

### P1. `publicUrl()` with both strategies

`publicUrl({ name, url, target })` with `publicUrl.hostname()` and `publicUrl.generated()`, a bare string as shorthand for a named hostname, and an error when `url` is omitted. `generated()` lowers to nothing on the platform and reports the service's existing `*.prisma.build` URL. `hostname()` lowers to `Prisma.CustomDomain`; a hostname whose DNS isn't ready fails the deploy naming the hostname and the DNS step. One `DeployedEntity` per public URL, with the node's address as its `logicalId` in the topology. The local target's stand-in creates nothing and warns once that a named hostname is ignored.

- **Builds on:** C1, U1.
- **Hands to:** P2.
- **Done when:** a test app with one public service shows that service alone as public in the topology; a named hostname with DNS in place serves on production and on a preview; a named hostname without DNS fails the deploy naming the hostname and the DNS step; `prisma dev` warns once and runs.

### P2. Pending hostnames

`hostname()` lowers to `Prisma.PublicUrl`. A hostname without DNS deploys in a pending state, the deploy output names the outstanding step and prints the Console link, and finishing DNS needs no redeploy. The scenarios doc gains the slice that made each scenario true.

- **Builds on:** P1, U2.
- **Done when:** the spec's "At a glance" app deploys production before `shop.com`'s DNS exists, succeeds, and the hostname goes active after DNS is added with no further deploy.

## Track D — PDP (prisma/pdp-control-plane)

### D1. Public URL and Domain records

Per ADR 015: the two tables; Management API routes (Public URL create, update, delete, list by Branch, lookup by `logicalId`; Domain prove, list); creation with no Foundry call; Verify and connect driving the record through `verifying`, `provisioning_tls`, `active` and `failed`; promote re-pointing each record's Foundry rows with failures on the record's `state`; the uniqueness rule enforced on create; the backfill of existing custom domains and TXT proofs. No Foundry change.

- **Builds on:** ADR 015 (prisma/pdp-control-plane#5795) agreed. Starts immediately; the longest slice. Will and the orchestrating agent.
- **Hands to:** U2, D2.
- **Done when:** a Public URL created without DNS is `pending`, becomes `active` after Verify and connect, survives a promote and a service deletion, a second record naming its hostname is refused, and an existing custom domain appears as a record with no `logicalId`.

### D2. Console shows public URLs and actual exposure

Each service's public URLs with their state and the setup link, and every service's actual reachability while all services are still public, so no service is presented as private.

- **Builds on:** D1.
- **Done when:** the Console page for a service in the test project shows both, verified with screenshots in the PR.

## Order

```
U1 ─────────────────┐
C1 ─────────────────┼─▶ P1 ───────────┐
D1 ──▶ U2 ──────────┴─────────────────┴─▶ P2
  └──▶ D2
C2 (after prisma/composer#385 merges)
```

U1, C1, D1 and C2 start at once. P1 starts when C1 has merged and the Alchemy release carrying U1 is pinned. U2 and D2 start when D1 is deployed. P2 is last.

## Close-out

- [ ] Verify every Project DoD condition in [spec.md](spec.md).
- [ ] Long-lived content is already in `docs/design/` and pdp-control-plane `docs/` from each slice; confirm nothing in this folder is still needed, and move anything that is.
- [ ] Remove references to `.drive/projects/public-urls/` elsewhere in the repo.
- [ ] Delete `.drive/projects/public-urls/`.

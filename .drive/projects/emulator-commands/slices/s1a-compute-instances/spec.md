# S1a — The Compute emulator knows nothing about Composer

Repo: prisma/composer. Branch `feat/emulator-instances`, stacked on prisma/composer#353 (`fix/dev-ready-after-listening`). PR base: that branch until #353 merges, then `main`.

## At a glance

After this slice, the Compute emulator runs service instances keyed by its own ids. It never sees an app name, a node address or a directory, except as label values it stores and returns without reading. Composer keeps, per working directory, a record of which instance backs each service address and which port it last had.

```text
.prisma-composer/dev/<mapping file>       (per directory, written by Composer)
  app: "my-app"
  nodes:
    quotes   → compute instance "svc_k3f9…", port 3000
    gateway  → compute instance "svc_81ad…", port 3001

Compute emulator (machine-wide, Composer-unaware)
  GET /instances  → [{ id: "svc_k3f9…", port: 3000, url, status: "running",
                       labels: { "composer.directory": "/path", "composer.app": "my-app",
                                 "composer.address": "quotes" } }, …]
```

Two directories running the same app get separate instances. `prisma dev` otherwise behaves the same from the outside.

## Chosen design

**Emulator (`packages/1-prisma-cloud/0-lowering/dev-emulators`).**
- Instances are created by the emulator and get an id it generates. Create accepts `labels: Record<string, string>` and an optional requested port.
- Every instance operation is by id: deploy, start, stop, delete, logs, get. There is no app grouping. Bulk start and stop take a list of ids.
- `GET` for all instances returns id, port, url, status and labels.
- Ports: an instance gets its port at creation and keeps it until deleted, running or stopped (a deployment's env and its dependents' URLs contain the port, and a warm start does not redeploy). Create takes an optional requested port: used if free, otherwise the lowest free port from 3000; the response reports the port given. No request → lowest free from 3000.
- The deployment body carries no Composer address. Emulator messages name the instance id; Composer adds the service's address when it rethrows, so what `prisma dev` prints is unchanged.
- State written in the old app-keyed format is discarded on load. Local dev state is never migrated across versions (running-locally guide).
- #353's readiness behaviour (a service is `running` only once its port accepts connections), the start and stop concurrency rules, crash supervision and the version-skew restart all carry over unchanged, keyed by instance instead of `(app, id)`.

**Composer's mapping (Prisma Cloud local target: `0-lowering/local-target`, `1-extensions/target/src/local-target`).**
- One file in `<cwd>/.prisma-composer/dev/` records the app name and, per service address, the Compute instance id and its last port. One module owns reading and writing it. S3 reads it for `prisma dev url`.
- The emulators hook keeps prisma/composer#350's order: it ensures one instance per service in `graph.nodes` order (dependencies first, ties in declaration order). It reuses the mapped instance when it still exists on the emulator. Otherwise it creates one, requesting the remembered port, and records the result.
- When a requested port was unavailable and the emulator gave a different one, `prisma dev` prints one line naming the service, the old port and the new one.
- Labels on create: `composer.directory` (absolute cwd), `composer.app`, `composer.address`. No Composer code finds an instance by its labels.
- The `App` and `Deployment` providers, attach (endpoints, logs, `startServices`, `stopServices`) and the `--fresh` teardown all reach Compute instances only through the mapping.
- `--fresh` deletes the mapped Compute instances and clears their mapping entries.

**Docs.**
- A new ADR records the model: the emulators know nothing about Composer, Composer maps its nodes to instances per directory, and labels are informative only. It amends ADR-0041's local identity ("a stable local identity from the app name").
- `docs/design/10-domains/local-dev.md` is updated for Compute.
- The running-locally guide and the core-concepts skill describe the user-visible change: two directories running one app no longer share services. Follow `.agents/rules/user-facing-surface-changes.mdc`.

## Coherence rationale

One reviewer can hold this as "Compute instances become emulator-owned, and Composer's per-directory mapping replaces the app name as the key". The Postgres and bucket emulators stay app-keyed until S1b. Both keys are valid in the meantime: the app name still identifies Postgres and buckets, and the mapping identifies Compute.

## Scope

In: the Compute emulator and its client; the mapping module; the emulators hook, the Compute providers, attach and teardown for Compute; tests; the ADR and docs above.

Deliberately out:
- Postgres and buckets (S1b).
- Stopping Postgres when `dev` ends (S1b).
- `dev url`, `dev stop` and `emulator list` (S3). This slice does add the emulator's list-all route and client call, because the mapping's "does this instance still exist" check needs it.
- Deleting instances whose directory is gone.

## Pre-investigated edge cases

| Case | Expected |
| --- | --- |
| Mapping names an instance the emulator no longer has (emulator state lost, or another directory's `--fresh`) | Create a new instance requesting the remembered port; update the mapping |
| Remembered port taken by another directory's running instance | Lowest free port; one-line notice; mapping updated |
| Two directories, same app, started concurrently | Separate instances, no shared ports, neither redeploys over the other |
| Warm restart after Ctrl-C (the #164 warm-restart case) | Same instances, same ports, services started from their last deployment |
| Emulator restarted by a version change | Old app-keyed state discarded; the next `dev` creates instances, requesting remembered ports |

## Slice-specific done conditions

- [ ] Two temporary directories run the same fixture app at once. Each has its own Compute instances, and neither directory's services restart when the other deploys. This is proven by a test against a real Compute emulator in a temporary `PRISMA_COMPOSER_EMULATORS_DIR`.
- [ ] A test fails if the Compute emulator's routes, state keys, file names or generated fields carry an app name, address or directory, or if it alters label values or the deployment payload.

## References

- Project: `../../spec.md`, `../../design-notes.md`, `../../plan.md`.
- prisma/composer#350 (port order), prisma/composer#353 (readiness; this branch's base).
- `docs/design/10-domains/local-dev.md`, ADR-0041, ADR-0044, ADR-0051.

## Dispatch plan

1. **Emulator and client.** The Compute emulator and `computeClient` move to instance ids, labels, requested ports, list-all and bulk start and stop. The emulator's own tests are migrated and extended. *Hands to 2:* a Compute client keyed by instance id.
2. **Composer's mapping.** The mapping module, the emulators hook, the providers, attach and teardown move to the mapping, including the change-of-port notice and the two-directory test. *Hands to 3:* `prisma dev` working end to end on instance ids.
3. **Docs.** The ADR, local-dev.md, the guide and the skill. *Hands to:* the PR.

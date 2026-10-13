# ADR-0052: Composer maps its nodes to emulator instances per directory

## Decision

The local emulators know nothing about Composer. An emulator holds instances under ids it generates. Each instance carries labels that the emulator stores and returns but never reads. Composer records, per working directory, which emulator instance backs each node of the app run there. That record is the only place Composer's names are mapped to instances.

```text
~/work/shop/.prisma-composer/dev/emulator-instances.json      (written by Composer)
  { "app": "shop",
    "nodes": { "quotes":  { "kind": "compute", "id": "svc_k3f9…", "port": 3000 },
               "gateway": { "kind": "compute", "id": "svc_81ad…", "port": 3001 } } }

Compute emulator (one per machine, knows nothing about Composer)
  GET /instances → [ { "id": "svc_k3f9…", "port": 3000, "status": "running",
                       "labels": { "composer.directory": "/Users/me/work/shop",
                                   "composer.app": "shop",
                                   "composer.address": "quotes" } }, … ]
```

A second checkout of the same app in `~/work/shop-2` has its own record and its own instances. The two never share a service process or a port.

This amends [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md), whose local container gives a dev instance a stable identity from the app name alone. The Compute emulator is keyed this way. The Postgres and bucket emulators still key their instances by app name and are moved to the same model separately.

## Reasoning

`prisma dev` runs an app against local emulators: a Compute emulator that runs service processes, a Postgres emulator and a bucket emulator. Each is a long-lived daemon shared by everything on the machine. ADR-0041 identified an app's instances on those daemons by the app's name, so the emulators' routes and state were shaped around apps: `/apps/<app>/services/<id>`. Two directories that run the same app, such as two git worktrees of one repository, therefore resolved to the same instances. Each `prisma dev` redeployed over the other's services. That is a common situation, not an edge case: agents work in many worktrees at once and start and stop environments in each.

The emulators should not have to know what a directory or an app is to avoid this. So an instance belongs to whoever created it. A client creates an instance, the emulator generates its id, and every later operation names that id: deploy, start, stop, delete, logs. The emulator's API and its state contain no app name, node address or directory, and a test fails if one appears there outside a label. The emulators can then be used by something other than Composer, and moved out of this repository, without carrying Composer's model along.

Labels make a listing readable. Composer writes `composer.directory`, `composer.app` and `composer.address` on every instance it creates, so a person looking at the emulator's list of instances can tell what started each one. Nothing reads them back as identity. If Composer found its instances by searching labels, the labels would be a second, unenforced key.

Composer finds its instances through `emulator-instances.json` in the directory's dev state (`.prisma-composer/dev/`), which is already per directory. It records the app name and, per node address, the emulator kind, the instance id and the instance's port. The emulators hook writes it before converge. It reuses a recorded instance while the emulator still has it, and otherwise creates one and records it. Everything else reaches instances through the record: the local providers during converge, the dev session's endpoints, logs, start and stop, and `--fresh`. The record is readable from the directory alone, so a separate command can answer "where is this node running" without running the pipeline.

An instance keeps its port from creation until it is deleted, whether it is running or stopped. A port is baked into more than the process: the service's environment carries it (`COMPOSER_<ADDRESS>_PORT`), and its dependents' environments carry its URL. A warm start does not redeploy, because nothing in the app changed and Alchemy, the deploy engine, sees nothing to update. A service that received a different port on its next start would run with an environment built for the old one.

The record also keeps each node's port, for the one case where the port can change: the instance has to be re-created, for example because the emulator lost its state. Composer then asks for the remembered port. A requested port is a preference: when another instance or another process holds it, the emulator gives the lowest free port from 3000, and `prisma dev` prints one line naming the service, the old port and the new one. Failing instead would break `prisma dev` in one worktree whenever another worktree happened to take the port. Because a re-created instance runs nothing, the local Deployment provider asks Alchemy for an update when its instance does not run the recorded artifact, and the local App provider does so when its instance's URL changed, so dependents get the new URL.

A directory has one dev instance. When `prisma dev` runs a different app from a directory than the one the record names, the previous app's Compute instances are deleted, the record starts over, and `prisma dev` prints which app's local services were removed. Compute instances hold no data, so nothing is lost that a deploy does not recreate.

## Consequences

- Two directories running the same app run separate services on separate ports, and neither restarts the other's.
- A directory's ports are stable across `prisma dev` sessions. A port changes only when its instance is re-created and the old port is taken, and `prisma dev` says so.
- A stopped instance holds its port. Instances left behind by a deleted worktree keep their ports until something deletes them. No command does that yet.
- Local dev state written before this change is discarded: the Compute emulator drops app-keyed state when it loads, and the first `prisma dev` creates new instances. Local dev state is never migrated across versions.
- Every emulator kind moves to this model: instances keyed by emulator-generated ids, labels stored but never read, and a list of all instances. Until the Postgres and bucket emulators do, the app name still identifies their instances, so two directories running one app still share its databases and buckets.
- Composer code must not find an instance by its labels. The record is the only mapping.

## Alternatives considered

- **App-keyed emulators.** The model this replaces. Simple, but two directories running one app share and overwrite each other's services, and the emulators carry Composer's concepts in their routes and state.
- **The app name plus a hash of the directory as the identity.** Separates directories, but keeps app and directory concepts inside the emulators and makes every emulator route depend on how Composer forms that key.
- **Releasing a port when its instance stops.** Lets stopped worktrees hold no ports, but breaks warm starts: the port is in the deployment's environment and in its dependents' URLs, and a warm start does not redeploy, so a service started on a new port would run with an environment built for the old one.
- **Finding instances by their labels.** Needs no record file, but makes free-form display metadata into an unenforced key that any client could collide with.

## Related

- [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md) — local dev runs the deploy pipeline against local providers; amended here.
- [ADR-0051](ADR-0051-a-nodes-address-is-its-logical-id-on-the-platform.md) — a node's address, the key of the record.
- [local-dev.md](../10-domains/local-dev.md) — the Compute emulator, the record and port allocation.

# ADR-0052: Composer maps its nodes to emulator instances per directory

## Decision

The local emulators know nothing about Composer. Each emulator holds instances under ids it generates: the Compute emulator holds service instances, the Postgres emulator holds databases, and the bucket emulator holds buckets. Each instance carries labels that the emulator stores and returns but never reads. Composer records, per working directory, which emulator instance backs each node of each app run there. That record is the only place Composer's names are mapped to instances.

```text
~/work/shop/.prisma-composer/dev/emulator-instances.json      (written by Composer)
  { "current": "shop",
    "apps": {
      "shop": { "nodes": {
        "quotes":  { "kind": "service",  "id": "svc_k3f9…", "port": 3000 },
        "gateway": { "kind": "service",  "id": "svc_81ad…", "port": 3001 },
        "catalog": { "kind": "database", "id": "db_02c4…",  "port": 51300 },
        "uploads": { "kind": "bucket",   "id": "bkt-77e1…" } } },
      "shop-v2": { "nodes": { … } } } }

Compute emulator (one per machine, knows nothing about Composer)
  GET /instances → [ { "id": "svc_k3f9…", "port": 3000, "status": "running",
                       "labels": { "composer.directory": "/Users/me/work/shop",
                                   "composer.app": "shop",
                                   "composer.address": "quotes" } }, … ]
```

A second checkout of the same app in `~/work/shop-2` has its own record and its own instances. The two never share a service process, a port, a database or a bucket.

This amends [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md), whose local container gives a dev instance a stable identity from the app name alone.

## Reasoning

`prisma dev` runs an app against local emulators: a Compute emulator that runs service processes, a Postgres emulator that hosts `@prisma/dev` database servers, and a bucket emulator that serves the S3 wire protocol over local directories. Each is a long-lived daemon shared by everything on the machine. ADR-0041 identified an app's instances on those daemons by the app's name, so the emulators' routes and state were shaped around apps: `/apps/<app>/services/<id>`, a database server named `pcdev-<app>-<database>`, a bucket named `<app>--<bucket>`. Two directories that run the same app, such as two git worktrees of one repository, therefore resolved to the same instances. Each `prisma dev` redeployed over the other's services and wrote into the other's database. That is a common situation, not an edge case: agents work in many worktrees at once and start and stop environments in each.

The emulators should not have to know what a directory or an app is to avoid this. So an instance belongs to whoever created it. A client creates an instance, the emulator generates its id, and every later operation names that id: deploy, start, stop, delete, logs, credentials. A database's `@prisma/dev` server is named after its id, and a bucket's id is also its bucket name on the S3 wire. The emulator never interprets Composer's data. An app name, a node address or a directory reaches it only as a label value, or inside a payload it is handed to use: a deployment's artifact directory, which lies under the project, and its environment, whose keys are named after addresses; the path a database's `@prisma/dev` module is loaded from; a bucket's data directory. The emulator stores these verbatim and uses them as given. No route, state key, file name or field the emulator generates carries any of them, and a test per emulator fails if one does. The emulators can then be used by something other than Composer, and moved out of this repository, without carrying Composer's model along.

Labels make a listing readable. Composer writes `composer.directory`, `composer.app` and `composer.address` on every instance it creates, so a person looking at an emulator's list of instances can tell what started each one. Nothing reads them back as identity. If Composer found its instances by searching labels, the labels would be a second, unenforced key.

Composer finds its instances through `emulator-instances.json` in the directory's dev state (`.prisma-composer/dev/`), which is already per directory. It records every app run from the directory and, per node address, the node's kind (`service`, `database` or `bucket`), the instance id and, for a service or a database, its port; `current` names the app `prisma dev` last ran there. The emulators hook writes it before converge, in graph order: it reuses a recorded instance while the emulator still has it, starts a stopped database, and otherwise creates an instance and records it. Everything else reaches instances through the record: the local providers during converge, the dev session's endpoints, logs, start and stop, and `--fresh`. The record is readable from the directory alone, so a separate command can answer "where is this node running" without running the pipeline.

An instance keeps its port from creation until it is deleted, whether it is running or stopped. A port is baked into more than the process: a service's environment carries its own port (`COMPOSER_<ADDRESS>_PORT`), and its dependents' environments carry its URL or a database's connection string. A warm start does not redeploy, because nothing in the app changed and Alchemy, the deploy engine, sees nothing to update. An instance that received a different port on its next start would run, or be reached, through an environment built for the old one.

When `prisma dev` ends, through Ctrl-C, SIGTERM or a failure, it stops the app's service processes and its database servers. A stopped database keeps its data and its port, and the next `prisma dev` starts it again before converge. The hook has to: on a warm start Alchemy finds nothing to change and never calls the Database provider, so nothing else would start it. A bucket has no process, so there is nothing to stop.

The record also keeps each node's port, for the one case where it can change: the instance has to be created again, for example because the emulator lost its state. Composer then asks for the remembered port. A requested port is a preference: when another instance or another process holds it, the emulator gives the lowest free port, and `prisma dev` prints one line naming the node, the old port and the new one. Failing instead would break `prisma dev` in one worktree whenever another worktree happened to take the port. A re-created instance starts empty: a service runs nothing and a database has no tables. So the local providers ask Alchemy for an update when their recorded instance changed (Deployment, Database, Bucket) or its URL did (App), and the local migration step asks for one whenever the database is not at its target by its migration marker, because a database created again empty keeps its URL and nothing in Alchemy's inputs changes.

A directory keeps the local state of every app run from it. Running a different app from the directory, by another entry or another `--name`, stops the previous app's services and databases and keeps them recorded, with their data and ports, and `prisma dev` prints that it did. Running the previous app again resumes them. Deleting a database because a root module was renamed for a while would lose data no deploy recreates. `--fresh` deletes the current app's instances of every kind, a database's data with it, and the app's entry, and leaves other apps' entries alone.

## Consequences

- Two directories running the same app run separate services on separate ports, with separate databases and buckets, and neither restarts or writes into the other's.
- A directory's ports are stable across `prisma dev` sessions. A port changes only when its instance is re-created and the old port is taken, and `prisma dev` says so.
- After `prisma dev` ends, none of the app's service processes or database servers is running. The next start has the same data on the same ports.
- A stopped instance holds its port, and a database its data. Instances left behind by a deleted worktree keep their ports and data until something deletes them. No command does that yet.
- A bucket's objects live in the project, under `.prisma-composer/dev/buckets/<app>/`, so another app's `--fresh` in the same directory leaves them alone.
- Local dev state written before this change is discarded: each emulator drops its app-keyed state when it loads (the Postgres emulator also deletes the data of the servers that state named, once no live process serves them), and the first `prisma dev` creates new instances. Local dev state is never migrated across versions.
- Composer code must not find an instance by its labels. The record is the only mapping.

## Alternatives considered

- **App-keyed emulators.** The model this replaces. Simple, but two directories running one app share and overwrite each other's services, databases and buckets, and the emulators carry Composer's concepts in their routes and state.
- **The app name plus a hash of the directory as the identity.** Separates directories, but keeps app and directory concepts inside the emulators and makes every emulator route depend on how Composer forms that key.
- **Releasing a port when its instance stops.** Lets stopped worktrees hold no ports, but breaks warm starts: the port is in the deployment's environment and in its dependents' URLs, and a warm start does not redeploy, so a service started on a new port would run with an environment built for the old one.
- **Finding instances by their labels.** Needs no record file, but makes free-form display metadata into an unenforced key that any client could collide with.
- **One app per directory, deleting the previous app's instances on a switch.** Simpler record, but a renamed root module or another `--name` would delete local databases no deploy recreates.

## Related

- [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md) — local dev runs the deploy pipeline against local providers; amended here.
- [ADR-0051](ADR-0051-a-nodes-address-is-its-logical-id-on-the-platform.md) — a node's address, the key of the record.
- [local-dev.md](../10-domains/local-dev.md) — the emulators, the record, port allocation and stopping on exit.

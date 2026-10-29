# Local dev (`prisma dev`)

The local dev loop: one command brings up the whole topology from the root
module, credential-free, with deploy parity everywhere above the Alchemy
provider boundary. The architectural decision — dev runs the deploy pipeline
against local providers, substituted through an extension's `localTarget`
descriptor —
is recorded in
[ADR-0041](../90-decisions/ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md);
this doc is the mechanics.

## Scope

Three commands about the app, one about the machine, and one operation with no
command:

- **`prisma dev`** — bring up the application whose root node
  is the default export of the entry module (`entry` in the `composer` section,
  or `--entry <path>`), entirely on the local machine, and keep it up:
  watch built output, restart changed services, until interrupted. A service
  whose build adapter declares a dev server runs it instead of its artifact,
  and the foreground session streams that dev server's output, prefixed with
  its address
  ([ADR-0056](../90-decisions/ADR-0056-prisma-dev-runs-a-service-with-its-build-adapters-dev-server.md)).
  It does **not** stream the other services' logs — once it is supervising
  several processes, streaming them all inline drowns the front door and the
  rebuild notices. To read them, call the `log` operation from a script (see
  [docs/guides/running-locally.md](../../guides/running-locally.md)).
  With `--detach` (the `dev` operation's `detach`), it returns once every
  service answers and leaves the app running without watching; see
  § Process lifetimes.
- **`log`**, an operation on `@prisma/composer/control` with no command
  (ADR-0050) — tail the merged logs of that already-running app: every
  service, or one named by its full dotted `address` (`shop.catalog.service`). Follows
  live until the caller aborts; a `tail` count sets how many recent lines to
  return first (default 0, which returns live output only). It only reads the running
  app's logs — it neither builds, provisions, starts, nor stops anything.

- **`prisma dev url <address>`** — where a node runs in this directory, in
  the environment `--environment` names (default `dev`). The app is the
  address's first segment: `shop.api` is a node of the app `shop`. It answers
  with a service's `http://localhost:<port>`, a
  database's connection string (local credentials included), or a bucket's S3
  endpoint plus `/<bucket>`. JSON result `{ address, kind, url, state }`
  with `--json`; otherwise the URL alone goes to stdout, a terminal or a
  pipe. It is the `devUrl` operation
  ([ADR-0053](../90-decisions/ADR-0053-dev-url-dev-stop-and-emulator-list.md)).
- **`prisma dev stop`** — stop one app's service processes and database
  servers in one environment, as ending `prisma dev` does, for a `dev` that was
  killed without the chance or one started with `--detach`. The app is the
  config's entry's, or `--name`'s, as for `prisma dev`; the environment is
  `--environment`, default `dev`. Data and ports stay. It is the `devStop` operation, returning
  `{ app, stopped }`; `stopped` lists only the nodes that were running, so
  it is empty when nothing was, and the command then says so. Piped, it
  writes one tab-separated line per stopped node: node address and node
  kind.
- **`prisma emulator list`** — every local emulator on this machine, whether it
  runs, its admin URL (`null` when it is not running), and its instances with
  id, kind, URL, state and labels. An emulator that runs but cannot be listed
  is reported in its own entry with an `error` of `{ code, message }`, and the
  others are still listed. Piped, it writes one tab-separated line per
  instance: emulator kind, instance id, URL, state, node address, directory
  and environment, the last from the instance's `composer.environment` label.
  The directory is an absolute path, because the list covers
  every app on the machine and runs from any directory. Every data line
  escapes a backslash, tab, newline or carriage return inside a field, and
  fields are only added at the end; see the guide's
  [Piped output](../../guides/running-locally.md#piped-output). It needs no project or configuration, so it uses
  the emulator client bundled into `@prisma/composer-cli` rather than the
  project's `@prisma/composer-prisma-cloud`. The emulators' registry files and
  instance-list routes are therefore read across Composer versions and must
  stay backward compatible. `prisma emulator start` and `prisma emulator stop`
  are planned.

Every local command acts on the app and environment it is given, never on
what ran last. `dev url` and `dev stop` build nothing. `dev url` does not
import the entry module: the address names the app. `dev stop` finds the app
as `prisma dev` does. Core reaches the app's copy through the local-target
seam: a `LocalTargetDescriptor` may implement `current`, which takes the dev
state directory, the app and the environment, and returns that copy's
addresses, `locate(address)` and `stop()`. The Prisma Cloud target implements
it from the environment's `emulator-instances.json`; core never reads the
record. `dev url` reports a node only while it is running, so every URL it
prints answers. When the app has never run in that environment in the
directory, both fail with `DEV.NOT_STARTED_HERE`.

Flags: `dev` takes `--environment` (the environment to run, default `dev`),
`--name` (override the root's name, as on deploy), `--fresh` (before
starting, delete this app's local services, databases and buckets in this
environment, their data, its Alchemy state and its entry in the environment's
record; other environments and other apps keep theirs) and `--detach` (return
once every service answers and leave the app running; see § Process
lifetimes). `dev url` and `dev stop` take `--environment` too.

**Each environment is its own local copy.** `prisma dev --environment test`
runs the whole topology as the environment `test`, with its own services,
databases, buckets and ports, beside a running `prisma dev` of the same app in
the same directory. The common reason is a clean copy for tests that leaves
working data alone: `prisma dev --environment test --fresh` resets `test` and
nothing else. Running another app or another environment stops nothing that is
already running. The environment name is what the local target's container
and hooks receive, and it is Alchemy's stage, so Alchemy keeps each copy's
state at `.alchemy/state/<app>/<environment>`. Every other local file that
belongs to one copy lives in `.prisma-composer/dev/<environment>/`: the record
of instances, the environment variable values, the fingerprint key
(ADR-0058), the generated stack file, the artifacts and the bucket objects. The folder name is
the environment name, encoded, because an environment name may contain `/`.
Alchemy keeps the stage `feature/x` inside the folder of the stage `feature`,
so `--fresh` removes only the files directly in its own stage's folder.

On a case-insensitive filesystem, such as the default on macOS, `Dev` and
`dev` would share one folder, and so one copy. So the first `prisma dev` in an
environment writes the environment's exact name into its folder, in
`environment-name`, and `--fresh` keeps that file. `prisma dev`, `dev url`,
`dev stop` and the `log` operation refuse an environment whose folder records another name
with `DEV.ENVIRONMENT_NAME_MISMATCH`, before anything is torn down, prepared
or read. A folder with no name recorded is accepted, and `prisma dev` records
it.

`prisma dev` runs the extension version check `deploy` runs
([deploy-cli.md](deploy-cli.md)): each local container, rebuilt through the
extension's `deserialize`, must name the environment it asked for, and an
extension whose container does not, or whose `deserialize` throws, fails with
`DEPS.EXTENSION_INCOMPATIBLE` before anything starts. An older local target
that ignored the name would otherwise put every environment in one copy.

**Naming.** The `prisma` CLI mounts this as `prisma dev`
([ADR-0050](../90-decisions/ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md)).
Local Postgres comes from `@prisma/dev`, the local Prisma Postgres server
library that the Prisma 7 ORM CLI's own `prisma dev` command runs. Composer
does not run that command: its Postgres emulator daemon calls `@prisma/dev`'s
`startPrismaDevServer()` in-process, one server per `Database` resource.

## The pipeline, relative to deploy

Dev re-runs [deploy's pipeline](deploy-cli.md#the-pipeline) with these deltas:

1. **Import + Load** — identical, same errors.
2. **Config** — identical, except: every extension that owns resources must
   carry a `localTarget` descriptor; a missing one fails naming the extension
   ("extension `<id>` has no dev support — it declares no `localTarget`
   descriptor (ADR-0041)"). A build-only extension (one whose nodes are all
   `kind: 'build'`, declaring no providers/application/provisions/container)
   has nothing to emulate and is exempt. The extension factory must resolve
   **no** platform environment on this path (no workspace id, no region, no
   token).
3. **Assemble** — identical. Dev consumes the user's built output through the
   same adapters and produces the same bundles; missing output produces the
   same "run your build" error.
4. **Containers + emulators** — the `localTarget.container` descriptor resolves
   the app's local identity, its name, with no platform calls. Then the
   `localTarget.emulators` hook inspects the loaded graph and ensures one emulator
   daemon per node kind the topology uses (Compute always; buckets when
   bucket resources exist; Postgres when `postgres` or `raw-postgres`
   resources exist). Once they are up, the hook ensures each node's
   instance — service, database or bucket — in `graph.nodes` order, through
   the environment's record (see [Which instance backs a node](#which-instance-backs-a-node)).
   A recorded database the last session stopped is started here: on a warm
   start the converge may change nothing and never call the Database
   provider.
5. **Lower + converge** — a dev-generated stack file (ADR-0007's pattern, at
   `.prisma-composer/dev/<environment>/alchemy.run.ts`), driven with the extension's
   `localTarget.providers()` layer and `devState()` (Alchemy's built-in file store, exported by `@prisma/composer/local-target`),
   with the environment name as Alchemy's stage. Providers provision emulator instances (a running
   service, a database, a bucket) by talking to the emulators; converge
   terminates as always, and the Compute emulator keeps serving.
6. **Attach** — new, dev-only: through `localTarget.attach`, render the front
   door (every service's endpoint) and watch for rebuilds, loop. Ctrl-C,
   SIGTERM or a failure stops the app's service processes and database
   servers through the attachment's `stopApp` and exits; emulators and
   data persist. Logs are not streamed here — the `log` operation reads the
   same attachment's merged-log view on demand, so `dev`'s own output stays
   the front door plus lifecycle and rebuild notices.

## The Compute emulator

The seam between converge (terminating) and serving (long-running). One
emulator daemon per node kind runs machine-scoped and multi-tenant — the
Compute emulator is the one the framework builds in full: a small local
counterpart of the platform's compute service, with a loopback admin
endpoint.

The Compute emulator knows nothing about Composer
([ADR-0052](../90-decisions/ADR-0052-composer-maps-its-nodes-to-emulator-instances-per-directory.md)).
It holds **instances**, each a slot for one service process. A client creates
an instance with free-form labels and an optional requested port; the
emulator generates the id (`svc_<16 hex digits>`), stores the labels verbatim
and never reads them. Every later call names the id: put a deployment, start
or stop a list of instances (a stop skips ids it does not have, since they run
nothing; a start fails naming them), delete one, read or follow its log, get
one, or list them all. Creating an instance is the one call the client never
retries, because a retry after a lost response would create a second
instance. The emulator never interprets Composer's data: an app name, a
node address or a directory reaches it only as a label value or inside the
deployment payload (the artifact directory, or a command's `cwd` and `argv`,
and the env), which it stores
verbatim and hands to the process. No route, state key, file name or field the
emulator generates carries one, and a test fails if one does.

**Ports.** An instance gets its port when it is created and keeps it until it
is deleted, running or stopped. A requested port is used when no instance
holds it and it can be bound; otherwise the instance gets the lowest such port
from 3000. The port is in the deployment's env (`COMPOSER_<ADDRESS>_PORT`) and
in its dependents' URLs, and a warm start does not redeploy, so a port that
changed between sessions would leave services built for the old one.

The local `Deployment` provider does not spawn processes; it
unpacks the artifact into `.prisma-composer/dev/<environment>/artifacts/<hash>/`,
materializes the complete child env, and puts the deployment at the
service's instance, and the emulator owns the processes:

- **New or changed deployment** (artifact hash or env changed) → stop the
  old child if any, spawn the artifact's `bootstrap.js` under bun with the
  materialized env. Only the changed service restarts — Alchemy's diff
  already limited which deployments were re-put.
- **Readiness** → a service declared `compute({ ..., listens: false })` (the cron scheduler, which receives no requests) is `running` as soon as its process is spawned; the descriptor records `listens: false` in the artifact's `compute.manifest.json`, the local `Deployment` provider reads it from there and sends it with the deployment, and the emulator stores it with the instance; it is a property of the deployment, not of an app or address. Every other service is `running` only once its port accepts a TCP connection on loopback (IPv4 or IPv6). The emulator probes the port every 50 ms until it does, so a service that counts connections sees a few extra ones. The compute emulator's `--ready-poll-ms` argument changes that interval; the CLI never passes it, and the emulator's own tests use it to widen the moment between a process exiting and its start noticing. The deployment PUT and the session-resume start return only then, so a converge, and the `ready` line after it, finish only when every URL answers. A redeploy of a running service sets it to `stopped` once the old process has exited, and back to `running` when the new one listens. A child that exits before it listens fails the call with its address, exit code, and log path. A child that does not listen within the readiness timeout (30 seconds; `PRISMA_COMPOSER_SERVICE_READY_TIMEOUT_MS`, which the CLI passes to the compute emulator as `--ready-timeout-ms` when it starts the emulator) is stopped, and the call fails with its address, port, log path and the variable's name. A crash-backoff restart that times out ends `held`, like other crash loops.
- **Concurrent starts and stops** → a service has at most one process and at most one start in flight; the rules are in [Concurrent starts and stops](#concurrent-starts-and-stops) below.
- **Child exits unexpectedly** → the emulator restarts it with backoff and
  writes its supervision events into that service's log stream; repeated
  crash-looping is a held state visible in the service listing and the logs,
  not silent churn.
- **Log follow** → each fresh service start (a deployment or a session
  resume) clears that service's log, so it holds only the current run — a
  crash-backoff respawn keeps the run's crash trail, but past sessions and
  past deployments are gone. A follow starts at the current end by default
  (`?tail=<n>` includes the last `n` lines as backlog first);
  the `log` operation's `tail` count maps straight onto it. A live follower is
  reset to the new start when the log is cleared under it (the daemon tracks a
  per-log clear generation, so a follower never reads stale bytes).
- **Instance deleted** (service removed from the topology, or `--fresh`)
  → stop it, remove it and its log,
  and free its port.
- **Ctrl-C on the dev command** → the attachment stops the app's service
  instances and its database servers, and detaches. Every emulator —
  Compute, Postgres, buckets — stays up, and every instance keeps its data
  and its port; the next start reuses the same instances (same ports, same
  data). `--fresh` is what removes an environment's instances and data. `prisma dev --detach` leaves the app running with no
  session; see § Process lifetimes.

  **Known gap (proving-pass finding, fixed in #164):** a service actually only restarts
  when its `Deployment` resource is re-put — and Alchemy skips calling the
  provider at all when a resource's props (artifact hash, env) are
  unchanged from its last recorded apply. A Ctrl-C stop is invisible to that
  diff: nothing about the resource's *props* changed, only the process's
  live status, which Alchemy's state file does not track. So a second
  `prisma dev` after a plain Ctrl-C can converge with everything
  reported "noop" and leave every previously-stopped service `stopped` —
  the CLI still prints `ready` with each service's URL, but nothing
  is listening on them. Confirmed against the open-chat proving port (the
  warm-restart-noop finding); the existing store proving script's own
  criterion-6 check doesn't catch it because it asserts port *stability*
  and reads Postgres directly, never an HTTP round-trip against the
  restarted service. **Fixed in #164** by a session-resume call on the
  attachment seam: `LocalTargetAttachment.startServices()` starts every
  stopped service from its last deployment, and the dev command calls it
  on every attachment after each converge, before printing the front door
  (`run-dev.ts`) — so a warm start restarts what a previous session's
  Ctrl-C stopped even when the converge is all-noop.

### Concurrent starts and stops

Each service has at most one process and at most one start in flight. A stop in progress stays recorded until its process has exited. A start whose process has exited is about to fail, so no other start waits for it: a resume or redeploy that arrives in that moment starts the service again.

| Request | Service state | What happens |
| --- | --- | --- |
| Session-resume start | Never deployed | Succeeds at once; nothing starts |
| Session-resume start | A start in flight whose process has not exited | Waits for that start and returns its result |
| Session-resume start | `running`, no stop in progress | Succeeds at once |
| Session-resume start | Anything else | Becomes the start in flight: waits for any stop to finish, then spawns |
| Deployment PUT, identical | A deployment or resume start in flight whose process has not exited | Waits for that start and returns its result |
| Deployment PUT, identical | `running`, no start or stop in progress | Succeeds at once |
| Deployment PUT | Anything else | Stores the deployment and becomes the start in flight, replacing any earlier one: waits for any stop to finish, stops the current process, then spawns |
| Stop | Any | Ends the start in flight and any crash-backoff restart, stops the process, and sets `stopped` once it has exited |
| Instance delete | Any | Marks the instance deleted, stops it, and removes it; no start on a deleted instance spawns |
| Crash-backoff restart | After an unexpected exit | Becomes the start in flight and spawns at once |

A start in flight ends with the first of these that applies:

| Condition | Result |
| --- | --- |
| A newer start replaced it | The newer start's result |
| `bun` is not on the deployment's `PATH` | Fails with how to install bun; the service is `stopped` |
| The service was deployed with `listens: false` | Succeeds as soon as the process is spawned; the service is `running` |
| A stop or an instance delete ended it | Fails: "was stopped before it accepted connections" |
| Its process exited | Fails with the exit code and the log path; crash supervision handles the exit |
| The readiness timeout passed | Fails with the port, the log path and the timeout variable; the process is stopped and the service ends `stopped`, or `held` for a crash-backoff restart |
| The port accepted a connection | Succeeds; the service is `running` |

The exit of a process the emulator no longer tracks is ignored.

The env materialization is the one platform-side behavior the local target
implements itself: the hosted platform joins the branch's config variables
into a deployment at version-create; locally, the `Deployment` provider
performs the same join from the `EnvironmentVariable` records the lowering
emitted — against props defined in this repo, once, not an emulation of a
foreign API. One pinned deviation: the local join is scoped to the
service's own rows (plus any row outside the `COMPOSER_` namespace, which is
a platform-owned name by definition), because the platform
diffs a deployment only on its own referenced rows while an app-wide local
snapshot diffs on bytes — which restart-amplified dependents on every
first-after-cold converge. No sanctioned reader consumes sibling rows, so
the scoping changes restart behavior only.

The Postgres and bucket emulators follow the same model: a database is an
instance with a generated id (`db_<16 hex digits>`), served by a
`@prisma/dev` server named after it, and a bucket is an instance whose
generated id (`bkt-<16 hex digits>`, as an S3 bucket name allows no
underscore) is also its name on the S3 wire. Both lists all their instances,
store labels verbatim, and keep a database's port until it is deleted; see
[Postgres](#postgres) and [Buckets](#buckets-a-disk-backed-s3-emulator).

The emulator's failure messages name the instance (`instance "svc_…" exited
(code 1) before it accepted connections…`). The local providers and the
attachment replace the id with the service's address before the message
reaches the user, so `prisma dev` says `service "shop.gateway" …`.

### Which instance backs a node

Composer records, per working directory and environment, which emulator
instance backs each node of each app run there, in
`.prisma-composer/dev/<environment>/emulator-instances.json`. The record of
the environment `dev`:

```json
{
  "formatVersion": 3,
  "apps": {
    "shop": {
      "nodes": {
        "shop.quotes": { "kind": "service", "id": "svc_0b6e2f4a91c3d758", "port": 3000 },
        "shop.gateway": { "kind": "service", "id": "svc_81ad5c07e2f94b31", "port": 3001 },
        "shop.catalog": { "kind": "database", "id": "db_02c4e81f6a9b3d70", "port": 51300 },
        "shop.uploads": { "kind": "bucket", "id": "bkt-77e1a4c90b2d5f36" }
      }
    }
  }
}
```

`formatVersion` is the record's format. The record names no current app:
every command is told which app and environment to act on. A record
written by the version before that (`{ "app", "nodes" }`, one app, whose
services have kind `compute`) reads as that one app with `service` nodes and
is rewritten on the next write. Every node's key is its address, which is
also the resource ID of its main resource (a service's `App`, a database's
`Database`, a bucket's `Bucket`), so the local providers find their instance
by resource ID.

The record is the only place Composer's names are mapped to instances. The
emulators hook, the local `App`, `Deployment`, `Database`, `Connection`,
`Bucket` and `BucketAccessKey` providers, the attachment (endpoints, logs,
start, stop) and `--fresh` all go through it; no Composer code finds an
instance by its labels. The labels Composer writes on create —
`composer.directory` (the absolute directory), `composer.app`,
`composer.address` and `composer.environment` — are for people reading an
emulator listing. The record
can be read from the directory alone, without running the pipeline. Its node
keys are full addresses (`shop.catalog`). A record without `formatVersion` was
written by an older release, whose keys left out the app name: every one of
its keys reads with the app name in front, whatever it looks like, and the
next write stores the current format, so existing instances, ports and data
are reused. A bucket's objects live in the environment's
`buckets/<app>/<address without the app name>`
([ADR-0057](../90-decisions/ADR-0057-a-nodes-address-is-its-full-path-from-the-app-name.md)).

**Moving earlier local state into `dev`.** Releases before environments had
their own local copies kept one record, one set of environment variable
values, one set of stored secret values and one bucket folder for the whole
directory, directly in `.prisma-composer/dev/`. The first `prisma dev`,
`dev url`, `dev stop` or `log` after the upgrade moves them, except the stored secret values, which it deletes (ADR-0058), into `.prisma-composer/dev/dev/`, so they become the
environment `dev` and its instances, ports, databases and bucket objects are
kept. Alchemy's local state needs no move: those releases already ran as the
stage `dev`. This reverses the earlier rule that local dev state is never
migrated, as the record's rewrite to full addresses did before it.

- **Ensuring an instance.** The emulators hook goes through the app's nodes
  in `graph.nodes` order (dependencies first, ties in declaration order):
  services, databases (`postgres` and `raw-postgres` resources) and buckets
  (`s3` resources). A recorded instance the emulator still has is reused, and
  a stopped database is started. Otherwise a new one is created and recorded:
  on a first start, with no port requested, so ports follow that order; after
  the emulator lost the instance, requesting the recorded port. A node added
  by a rebuild during a session gets its instance from its provider the same
  way.
- **A remembered port that is taken.** It is a preference: the emulator gives
  the lowest free port instead, and `prisma dev` prints
  `[dev] service "<address>" now uses port <new>: its previous port <old> is in use`
  (`database "<address>"` for a database).
- **Redeploying a re-created instance.** A re-created instance starts empty,
  and a warm start's converge changes nothing, so Alchemy would never call the
  providers. The `Deployment` provider's diff asks for an update when its
  instance does not run the recorded artifact, the `App` provider's when its
  instance's URL changed, and the `Database` and `Bucket` providers' when the
  recorded instance is not the one they created, so dependents and access
  keys follow. A database created again keeps its URL when it gets its old
  port, so the local `OrmMigration` provider's diff reads the database's
  migration marker and asks for an update whenever it is not at the target;
  the committed migrations then replay as on a fresh start. That read is one
  connection per database per converge.
- **A removed service.** Deleting its `App` resource deletes its instance and
  its entry.
- **When `prisma dev` ends** (Ctrl-C, SIGTERM, a failure), the attachment's
  `stopApp` stops the app's service processes and database servers.
  Their data and ports are kept, and the next start brings them back.
- **Another app or another environment in the same directory.** Running a
  different app (another entry, another `--name`) or another environment
  stops nothing. Each app's copy in each environment has its own instances
  and keeps running until its own `prisma dev` ends or `prisma dev stop`
  names it.
- **`--fresh`** deletes the app's instances of every kind in that
  environment (a database's data with it), its entry in that environment's
  record, its Alchemy state at `.alchemy/state/<app>/<environment>` and its
  files in the environment's folder. Other environments, and other apps in the
  same environment, keep theirs. A bucket's objects live under
  `.prisma-composer/dev/<environment>/buckets/<app>/<bucket>/` for that
  reason.

Two directories running the same app have separate records, so they get
separate services on separate ports, separate databases and separate
buckets, and neither restarts or writes into the other's. Two environments in
one directory are separate in the same way. State an emulator wrote before
instances had generated ids is discarded when it loads.

### Process lifetimes

1. **Converge-scoped** — the Alchemy child (ADR-0007), started as
   [deploy-cli.md § Runtime](deploy-cli.md) describes. Providers run here;
   nothing started here survives its exit.
2. **Machine-scoped emulators** — one per node kind per registry root,
   multi-tenant, holding every long-lived process: the Compute emulator
   (service children), the Postgres emulator (one `@prisma/dev` server per
   `Database`, hosted in-process), and the bucket emulator. They survive dev
   sessions; `--fresh` removes the app's instances in one environment. The registry root is
   `~/.prisma-composer/emulators` unless `PRISMA_COMPOSER_EMULATORS_DIR`
   names another absolute directory, so by default one machine shares one
   set. Instances belong to a directory, so two checkouts of one app never
   share a service, a database or a bucket, whatever their roots. A daemon whose version
   differs from the caller's is replaced, so two Composer versions sharing a
   root replace each other's daemons back and forth; a separate root per
   checkout stops that.
3. **The dev session owns no processes at all** — it is a view (`attach`):
   endpoints, the stop control, and the watch loop. That same view's merged
   logs back the separate `log` operation.
4. **The app's processes** — the service children and database servers the
   emulators run for the app. In the foreground, `prisma dev` stops them when
   it ends (Ctrl-C, SIGTERM or a failure). `prisma dev --detach` converges,
   waits until every service accepts connections, prints the front door and
   exits 0, starting no watch loop and no stop on exit, so they keep running
   until `prisma dev stop` or the next `prisma dev` of that app in that
   environment in the directory, which reconverges as usual. A detached session handle is already closed and its
   `stop()` stops nothing. A detached run that fails before ready stops the
   whole app, including one an earlier `--detach` left running, as the
   foreground run does: a failed redeploy has already replaced that service's
   old process, so the previous app cannot be kept; fix the build and run
   `prisma dev --detach` again. A Ctrl-C before ready stops the app through
   `devStop`. A foreground `prisma dev` started while the app runs
   detached takes it over: its converge changes nothing, it watches, and its
   Ctrl-C stops the app.

The emulator daemon bookkeeping (registry, stable ports, readiness,
version-skew restart) is framework-owned and minimal, and the Postgres
emulator uses the same bookkeeping, hosting `@prisma/dev` servers rather than
reimplementing a Postgres server.

## Resource substitution

The full inventory (see
[alchemy-lowering.md](../05-prisma-cloud/alchemy-lowering.md) for the hosted
semantics):

| Resource | Dev behavior |
| --- | --- |
| `Project` | a local identity record; no platform |
| `Database` | the database instance the directory's record names for the resource, on its own `@prisma/dev` server hosted by the Postgres emulator; started if stopped, created when missing; `databaseId` is the instance id |
| `Connection` | the URL of the database instance its `Database` names |
| `App` | finds the service's Compute instance through the directory's record, creating it when there is none; the instance holds the service's port; `appEndpointDomain = http://localhost:<port>` — which makes origin (ADR-0039) work unchanged. Deleting it deletes the instance |
| `Deployment` | unpacks the artifact once per hash, materializes the env, and puts the deployment at the service's Compute instance, which (re)starts the child; updated when its instance does not run the recorded artifact |
| `EnvironmentVariable` | a key→value row in the dev state store |
| `Bucket` | the bucket instance the directory's record names for the resource, over a directory under `.prisma-composer/dev/<environment>/buckets/<app>/<bucket>/`, served by the bucket emulator; `bucketId` is the instance id, also its S3 name |
| `BucketKey` | credentials registered with the bucket emulator for its bucket |
| `ServiceKey` | **unchanged** — mints locally, persists in state |
| `S3Credentials` | **unchanged** — mints locally, persists in state |
| `PgWarm` | **unchanged** — real `select 1` against the local URL |
| `OrmMigration` | real migrations against the local URL, as deployed; locally its diff also asks for an update whenever the database is not at the target by its marker, so a database created again empty is migrated |

Because module-backed kinds (storage, streams, email) lower to compute services
plus databases, they run their **real service code** locally against local
Postgres — no per-module emulator, maximum fidelity. The streams module's
SQLite test server remains a testing utility, not part of the dev loop.

### Postgres

The emulator is a daemon hosting `@prisma/dev` servers, **one named, persistent server per database instance**. Creating an instance starts its server; the instance's generated id names the server, and `@prisma/dev` keeps the server's data under that name in its own data directory (`~/Library/Application Support/prisma-dev-nodejs/` on macOS, `$XDG_DATA_HOME/prisma-dev-nodejs/` on Linux), outside the emulators directory. Stopping an instance shuts its server down and keeps its data and its port; starting it brings it back on the same port with the same data. Deleting it removes the data. A database keeps its port until it is deleted because its connection string is in its dependents' environments. The Postgres emulator's earlier, app-keyed state is removed when it loads, and the data of the servers it named is deleted on the next request that carries a `@prisma/dev` module, unless another live process still serves one. Migrations are not special-cased: `OrmMigration` runs exactly as it does in a deploy, against the local URL — replay-only (ADR-0022 as revised), so it applies committed migrations and never synthesizes schema. At reconcile time it reloads the emitted `contract.json` identified by `prisma.config.ts`, attests its `storageHash` against the compact contract identity persisted in deploy state, and only then opens the database. Dev-loop schema iteration therefore happens through the ORM's own `prisma db update`, run directly against the emulator database: `db update` moves the database and its marker to the current contract, and the pipeline's migration step no-ops because the marker matches the target. A dev run against a database that was neither updated nor covered by a planned migration hits the same structured refusal a deploy would, naming both exits (`prisma db update` to iterate, `contract emit` + `migration plan` to author the path). `PgWarm` is near-instant locally and is kept (not stubbed) so the provider set stays uniform.

### Buckets: a disk-backed S3 emulator

The storage module already implements the S3 wire protocol over an
`ObjectStore` interface with full SigV4 verification, including presigned URLs
([storage/src/handler.ts](../../../packages/1-prisma-cloud/2-shared-modules/storage/src/handler.ts),
[storage/src/sigv4.ts](../../../packages/1-prisma-cloud/2-shared-modules/storage/src/sigv4.ts)),
with memory- and Postgres-backed stores. The domain layering
(lowering < extensions < modules, upward imports denied) means dev machinery
cannot import the storage module, so the protocol pieces (handler, SigV4,
`ObjectStore`, memory store) move down into a shared protocol package at the
lowering layer that both the module and the bucket emulator import — a
behavior-preserving extraction; the storage module's public surface is
unchanged. The bucket emulator is then a third store implementation plus one
machine-global daemonized server (plain `node:http`, which runs under both
node and bun), multi-tenant across apps and administered through a loopback
admin endpoint (`/_pcdev/…` — the underscore prefix cannot collide with a
valid bucket name). A bucket is an instance whose generated id is its name
on the S3 wire, carried on the binding's `bucketName`, so consumers follow
the binding and names cannot collide. Credentials are registered per bucket,
and a request is verified only against its target bucket's keys. Each
bucket's data root is registered as an in-project path, which the emulator
stores verbatim:

- **Objects are plain files at their key paths** —
  `.prisma-composer/dev/<environment>/buckets/<app>/<bucket>/<key>`. Browse them, open them, drop a
  file in and it exists in the bucket. This is a feature, not an
  implementation detail: inspectable state is half the value of local dev.
- Object metadata (content type, user metadata) lives in a sidecar tree, so
  the object tree stays clean for humans.
- One machine-global emulator serves every bucket (the wire namespaces by
  path bucket, as the handler already does), accepting each registered
  pair.
- Multipart upload is initially unimplemented and fails with a clear error
  naming the limitation; add it when a real consumer needs it.

## Value sourcing

The same table the port's hand-rolled script implemented, now standard:

| Slot | Dev source |
| --- | --- |
| dependency connection values (URLs) | the local provider's resolved value, through the normal lowering |
| service params | bound literals / defaults, identical to deploy |
| `envParam` sources (ADR-0032) | the dev shell's environment, same names; missing → a hard error listing the names (params feed boot-time schema validation — junk there is a confusing crash, not a legible degraded mode) |
| secrets (ADR-0029, ADR-0058) | the run's environment variables: the shell, or a `.env` that `prisma.config.ts` loads. Unset or empty counts as missing. A missing secret the service's schema requires is a hard error naming the variable, the service and both ways to set it; a missing optional secret is left out of the service's input. No value is reused from an earlier run. |
| minted needs (ADR-0030/0031: service keys, streams keys) | minted locally by the unchanged provisioners |
| origin (ADR-0039) | `http://localhost:<port>` via the unchanged origin channel |

Whether a missing secret is required is decided by validation, not by reading the schema (ADR-0042): the dev preflight validates each service's input with every missing secret left out, and then with each one left out alone, and names as required only the secrets whose absence alone fails. The preflight sends the alchemy process, on the preflight transport, the names of the absent secrets and an HMAC-SHA256 fingerprint of the value of each variable that a service's input or params point at, keyed by the environment's own `.prisma-composer/dev/<environment>/fingerprint.key`. The serializer leaves out the absent secrets, and the fingerprint fills each deployment's `<name>:updatedAt` trigger member, so a value changed between two runs redeploys exactly the services that read it. The local `Deployment` provider reads current values from `process.env` and gives each service only the variables its own input and params point at.

To load a `.env`, install the `dotenv` package in the app and put `import 'dotenv/config'` as the first line of `prisma.config.ts`. `process.loadEnvFile('.env')` works only when the CLI runs under Node: when the CLI was started through Bun, the converge runs under Bun, which does not implement it. A `.env` loaded this way is read by every `prisma` command, including `prisma deploy`, whose preflight uploads any secret the target environment does not have yet: keep local-only values out of it before deploying, or deploy from a shell where it is not loaded.

## Scheduled work

Per ADR-0020 the scheduler is an ordinary service, so in dev it runs and its
schedules **fire for real** — a cron edge is exercised end-to-end without
ceremony. For determinism-sensitive sessions (agents asserting on side
effects), the scheduler service's trigger endpoint is reachable like any other
local service, so a manual `curl` fires any job on demand; a `dev`-surface
convenience for this (list jobs / trigger by id) is a nice-to-have, not v1.

## Error surface

Deploy's rule holds: every failure names its fix.

| Failure | Error tells the user |
| --- | --- |
| extension has no `localTarget` descriptor | which extension, and that it does not support local dev |
| built output missing | same as deploy: the expected path, "run your build" |
| `bun` not on PATH | that dev runs services under bun (the Compute runtime) and how to install it |
| `@prisma/dev` cannot be loaded (the local-Postgres emulator) | the module path that was tried |
| the bucket emulator fails to start or report healthy | the instance name, its log file path, and the port it tried |
| a `@prisma/dev` server fails to start | the underlying error, sanitized — connection-URL credentials are masked before embedding |
| port conflict on a persisted allocation | which service, which port, and how to free or re-allocate (`--fresh`) |
| required secret unset or empty | hard error listing every missing variable, the service that needs it, the schema's message, and both ways to set it (shell, or a `.env` loaded by `prisma.config.ts`); an optional one is not an error |
| env-sourced param unbound | hard error listing the missing names, deploy-preflight style |
| a service exits before it listens, or does not listen within the readiness timeout | the address, the port, the exit code if it exited, and the log path; `dev` stops the app's services before it returns the failure |
| an emulator does not accept connections (retried briefly; an error response from the emulator is never retried) | `DEV.EMULATOR_UNREACHABLE`, with the emulator's URL, from `dev` and `log` alike |
| `PRISMA_COMPOSER_SERVICE_READY_TIMEOUT_MS` is not a positive whole number | `DEV.SERVICE_READY_TIMEOUT_INVALID`, with the value |
| `dev url` or `dev stop` for an app that has never run in that environment in this directory | `DEV.NOT_STARTED_HERE`, naming the app and the environment: run `prisma dev` (with the same `--environment`) here first |
| `dev`, `dev url`, `dev stop` or the `log` operation for an environment whose folder records another name, such as `Dev` where `dev` ran on a case-insensitive filesystem | `DEV.ENVIRONMENT_NAME_MISMATCH`, naming the folder, the recorded name and the requested one, before anything runs: use the recorded name, or a name that differs by more than case |
| a local target extension older than the running Composer | `DEPS.EXTENSION_INCOMPATIBLE`, naming the extension, before anything starts |
| `dev url` with an address the app does not have | `DEV.ADDRESS_UNKNOWN`, listing the addresses it has |
| `dev url` for a node whose emulator is not running | `DEV.EMULATOR_UNREACHABLE` |
| `dev url` for a node that exists but is not running | `DEV.NOT_RUNNING`, naming its state; for a stopped node the fix is `prisma dev`, for a crash-looping service it is the service's log, for a node its emulator lost it is `prisma dev`, which creates it again |
| the local target fails without a code (for example an emulator's error response) in `dev url` or `dev stop` | `DEV.EMULATOR_FAILED` |
| service crash-loops | the address, exit code, and the last stderr lines, as a standing message |
| a build descriptor's `serve` step throws (for Next.js: `next` cannot be resolved from `appDir`) | `DEV.DEV_SERVER_UNAVAILABLE`: `service "<address>" cannot run its dev server: <message>`, before anything starts |
| a service runs a dev server but its service descriptor has no `reserve`, or its target's attachment has no `serve` | `DEV.DEV_SERVER_UNSUPPORTED`, naming the address and the package to update, before the first converge |
| a dev server exits before it listens, never listens, or its executable is not on the deployment's `PATH` | `DEV.SERVICE_START_FAILED` with the emulator's message, the address in place of the instance id, plus `A dev server must listen on the port in its PORT variable.` when it did not listen |

## Out of scope (designed around)

- **Hot reload / user-supplied dev commands.** Decided in [ADR-0056](../90-decisions/ADR-0056-prisma-dev-runs-a-service-with-its-build-adapters-dev-server.md): a service runs the dev server its build adapter declares (`next dev`; a `dev` command written on `node()`) in place of its artifact, as a command deployment on the Compute emulator, with the environment its deployment would get, re-stashed address-free so `load()`/`input()` work without `run()`. A service whose adapter declares no dev server runs its artifact as described in this doc. The ADR is the full description of the dev-server mechanics: the `serve` build step, `unassembled` lowering with `reserve`, the emulator's command deployments, `stashRows`, and the serve step after every converge.
- **Remote bindings** (a local service against real cloud resources,
  Wrangler-style). A possible future opt-in; contradicts credential-free dev
  as a default.
- **Deploy verification integration** — `verify` runs against a dev instance
  the same way it runs against a deploy (the health surface is just another
  local endpoint); its design is its own lane.

## Open questions

(none outstanding from the design phase — see Known limitations below for
gaps found during implementation.)

(Settled since the first draft: Postgres runs one named `@prisma/dev` server per `Database` resource; the front door prints every service URL ordered by address depth then name, shallowest first; on a fresh start, services get their ports in dependency order, ties in declaration order — the emulators hook creates their instances one at a time from `graph.nodes` before Alchemy applies the resources concurrently — and a warm start keeps each service's and database's port, because an instance holds its port until it is deleted (ADR-0052); port allocation and the remaining mechanics are described in this document and [ADR-0041](../90-decisions/ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md). Restart latency is measured — see Known limitations.)

## Proven against a real app

The design's founding claim was proven against open-chat — a real, pre-existing Composer app in its own repo (chat service, Postgres, streams and storage modules), written before local dev existed. With no cloud credentials of any kind in the shell, `prisma dev` brought it up: sign-in worked, chat history loaded, and the live-tail stream delivered events. Chat generation failed at one place, the outbound OpenRouter call, because local dev at the time gave the unset `OPENROUTER_API_KEY` secret a made-up placeholder value. ADR-0058 removed placeholders: today that run stops at start with an error naming `OPENROUTER_API_KEY`, or, if the schema marks it optional, starts with the key absent. The port itself was one commit: point the app's framework dependency at the build under test, switch its service to `node()`'s directory build form, fix a launcher path that only worked un-moved, catch up with two API changes — and delete the app's 169-line hand-rolled dev script, which the framework command replaces.

## Known limitations (found while proving the implementation)

- **Restart latency: median 3.24s** per edit-rebuild-reconverge cycle
  against `examples/store` (5 runs, 3.09-3.35s, Apple M3 Max) —
  comfortably inside the single-digit-seconds target. Measured by a probe
  that edits one service's source, then times rebuild -> converge -> the
  emulator reporting the restarted pid.
- **Warm-restart-after-Ctrl-C could leave services stopped** (fixed in
  #164) — see the Compute-emulator section above ("Known gap").
- **`Bundle.watch` was not populated everywhere during the proving pass** — resolved:
  both build adapters now populate it (node watches the entry file or the
  whole `dir`; Next.js watches the standalone root), so the file-watch
  loop picks rebuilds up on its own. A build descriptor that still returns
  no `watch` entries reports `[dev] <address> has no watchable inputs` at
  startup and needs its rebuilds triggered manually.
- **A topology edit reconverges, but the session's own view of the app is
  the one it started with.** The entry module is imported once per process,
  so after an edit to `module.ts` or a `service.ts` the Alchemy child (a fresh
  process) converges the new topology while the session keeps the graph, the
  bundles and the dev servers it loaded. Edits that keep the set of services
  and their build adapters — wiring, inputs, bindings — apply fully; adding,
  removing or re-adapting a service needs `prisma dev` restarted.
- **App-owned migrations are not run by `dev`** (by design — ADR-0022, spec
  § 4's `OrmMigration` line is for framework-run migrations only). An app that
  runs its own migrations (e.g. via `prisma db init`, like the
  open-chat port) needs that as a manual step against the local Postgres URL
  on a fresh dev instance; `dev` does not know to run it automatically.

## Related

- [ADR-0041](../90-decisions/ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md)
  — the decision this doc details.
- [ADR-0052](../90-decisions/ADR-0052-composer-maps-its-nodes-to-emulator-instances-per-directory.md)
  — the emulators know nothing about Composer; the per-directory record of
  which instance backs each node.
- [deploy-cli.md](deploy-cli.md) — the pipeline dev re-runs and the error-surface
  convention it extends.
- [alchemy-lowering.md](../05-prisma-cloud/alchemy-lowering.md) — the resource
  inventory and lowering graphs the local providers implement.
- [core-model.md](core-model.md) — `run()`/`load()` and the stash protocol the
  spawned services boot through.
- [goals.md](../00-purpose/goals.md) — the local-dev-emulator goal.

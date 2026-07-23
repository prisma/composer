# Local dev (`prisma-composer dev`)

The local dev loop: one command brings up the whole topology from the root
module, credential-free, with deploy parity everywhere above the Alchemy
provider boundary. The architectural decision — dev runs the deploy pipeline
against local providers, substituted through an extension's `dev` descriptor —
is recorded in
[ADR-0041](../90-decisions/ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md);
this doc is the mechanics.

## Scope

One command:

- **`prisma-composer dev <entry>`** — bring up the application whose root node
  is `entry`'s default export, entirely on the local machine, and keep it up:
  watch built output, restart changed services, stream logs, until interrupted.

Flags: `--fresh` (destroy the dev stack and wipe the dev state directory before
starting). Nothing else to start with. Stages do not apply — a working
directory has exactly one dev instance; parallel instances are parallel
checkouts.

**Naming.** goals.md calls the local emulator "`prisma dev`". That name is
owned today by the ORM CLI's local-Postgres command — which this harness itself
shells out to. The command is therefore `prisma-composer dev`; convergence on a
shorter name is a CLI-distribution question (Composer joining a unified
`prisma` CLI), not a design question here.

## The pipeline, relative to deploy

Dev re-runs [deploy's pipeline](deploy-cli.md#the-pipeline) with these deltas:

1. **Import + Load** — identical, same errors.
2. **Config** — identical, except: every extension in the config must carry a
   `dev` descriptor; a missing one fails naming the extension ("`<id>` has no
   dev support"). The extension factory must resolve **no** platform
   environment on this path (no workspace id, no region, no token).
3. **Assemble** — identical. Dev consumes the user's built output through the
   same adapters and produces the same bundles; missing output produces the
   same "run your build" error.
4. **Containers + emulators** — the `dev.container` descriptor resolves a
   stable local identity from the app name with no platform calls. Then the
   `dev.emulators` hook inspects the loaded graph and ensures one emulator
   daemon per node kind the topology uses (Compute always; buckets when
   bucket resources exist; Postgres needs no pre-start — its instances are
   created at provision through the ORM CLI).
5. **Lower + converge** — a dev-generated stack file (ADR-0007's pattern, at
   `.prisma-composer/dev/alchemy.run.ts`), driven with the extension's
   `dev.providers()` layer and Alchemy's built-in `localState()` store, always
   at Alchemy stage `dev`. Providers provision emulator instances (a running
   service, a database, a bucket) by talking to the emulators; converge
   terminates as always, and the Compute emulator keeps serving.
6. **Attach** — new, dev-only: through `dev.attach`, render the front door
   (every service's endpoint), stream the merged logs, watch for rebuilds,
   loop. Ctrl-C stops the app's service instances through the attachment and
   exits; emulators and data persist.

## The Compute emulator

The seam between converge (terminating) and serving (long-running). One
emulator daemon per node kind runs machine-scoped and multi-tenant — the
Compute emulator is the one the framework builds in full: a small local
counterpart of the platform's compute service, with a loopback admin
endpoint. The local `Deployment` provider does not spawn processes; it
unpacks the artifact into `.prisma-composer/dev/artifacts/<hash>/`,
materializes the complete child env, and puts the deployment at the
emulator, which owns the processes:

- **New or changed deployment** (artifact hash or env changed) → stop the
  old child if any, spawn the artifact's `bootstrap.js` under bun with the
  materialized env. Only the changed service restarts — Alchemy's diff
  already limited which deployments were re-put.
- **Child exits unexpectedly** → the emulator restarts it with backoff and
  writes its supervision events into that service's log stream; repeated
  crash-looping is a held state visible in the service listing and the logs,
  not silent churn.
- **Instance deleted** (service removed from the topology, `--fresh`) → stop
  and remove.
- **Ctrl-C on the dev command** → the attachment stops the app's service
  instances and detaches. Every emulator — Compute, Postgres instances, the
  bucket emulator — stays up with its data; the next start is warm.
  `--fresh` is what removes instances and data. (A detached mode where
  services keep serving with no session is a designed extension, not v1.)

The env materialization is the one platform-side behavior the local target
implements itself: the hosted platform joins the branch's config variables
into a deployment at version-create; locally, the `Deployment` provider
performs the same join from the `EnvironmentVariable` records the lowering
emitted — against props defined in this repo, once, not an emulation of a
foreign API. One pinned deviation: the local join is scoped to the
service's own rows (plus the unprefixed poison rows), because the platform
diffs a deployment only on its own referenced rows while an app-wide local
snapshot diffs on bytes — which restart-amplified dependents on every
first-after-cold converge. No sanctioned reader consumes sibling rows, so
the scoping changes restart behavior only.

### Process lifetimes

1. **Converge-scoped** — the Alchemy child (ADR-0007). Providers run here;
   nothing started here survives its exit.
2. **Machine-scoped emulators** — one per node kind, multi-tenant, holding
   every long-lived process: the Compute emulator (service children), the
   `prisma dev` Postgres instances (managed by the ORM CLI, per-Database),
   and the bucket emulator. They survive dev sessions; `--fresh` removes an
   app's instances.
3. **The dev session owns no processes at all** — it is a view (`attach`):
   endpoints, merged logs, the stop control, and the watch loop.

The emulator daemon bookkeeping (registry, stable ports, readiness,
version-skew restart) is framework-owned and minimal; Postgres reuses the
ORM CLI's mature manager (`prisma dev ls|stop|rm`) rather than duplicating
it.

## Resource substitution

The full inventory (see
[alchemy-lowering.md](../05-prisma-cloud/alchemy-lowering.md) for the hosted
semantics):

| Resource | Dev behavior |
| --- | --- |
| `Project` | a local identity record; no platform |
| `Database` | a database on the local Postgres server (ORM `prisma dev`) |
| `Connection` | the local connection URL |
| `ComputeService` | registers the service with the Compute emulator, which allocates its stable port; `endpointDomain = http://localhost:<port>` — which makes origin (ADR-0039) work unchanged |
| `Deployment` | unpacks the artifact once per hash, materializes the env, and puts the deployment at the Compute emulator, which (re)starts the child |
| `EnvironmentVariable` | a key→value row in the dev state store |
| `Bucket` | a directory under `.prisma-composer/dev/buckets/<bucket>/`, served by the bucket emulator |
| `BucketKey` | credentials registered with the bucket emulator |
| `ServiceKey` | **unchanged** — mints locally, persists in state |
| `S3Credentials` | **unchanged** — mints locally, persists in state |
| `PgWarm` | **unchanged** — real `select 1` against the local URL |
| `PnMigration` | **unchanged** — real migrations against the local URL |

Because module-backed kinds (storage, streams, email) lower to compute services
plus databases, they run their **real service code** locally against local
Postgres — no per-module emulator, maximum fidelity. The streams module's
SQLite test server remains a testing utility, not part of the dev loop.

### Postgres

The emulator is the ORM CLI's local Postgres (`prisma dev`), **one named,
detached instance per `Database` resource** — instance names are derived from
the app and database ids, so instances are isolated, discoverable
(`prisma dev ls`), and survive across dev sessions for warm starts.
Migrations are not special-cased: `PnMigration` runs exactly as it does in a
deploy, against the local URL. `PgWarm` is near-instant locally and is kept
(not stubbed) so the provider set stays uniform.

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
valid bucket name). Physical bucket names are prefixed `<app>--<name>` and
carried on the binding's `bucketName`, so consumers follow the binding and
names cannot collide across apps; each bucket's data root is registered as
an in-project path:

- **Objects are plain files at their key paths** —
  `.prisma-composer/dev/buckets/<bucket>/<key>`. Browse them, open them, drop a
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
| secrets (ADR-0029) | shell env if set; else a minted placeholder (persisted, stable across restarts) + one printed warning per slot |
| minted needs (ADR-0030/0031: service keys, streams keys) | minted locally by the unchanged provisioners |
| origin (ADR-0039) | `http://localhost:<port>` via the unchanged origin channel |

The placeholder policy means a topology with a genuine external credential
(an LLM API key, say) boots and serves everything that doesn't touch that
credential; the paths that do touch it fail at the external service with the
placeholder — exactly the degraded-but-running behavior local dev wants, with
the warning naming the variable to export for full function.

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
| extension has no `dev` descriptor | which extension, and that it does not support local dev |
| built output missing | same as deploy: the expected path, "run your build" |
| `bun` not on PATH | that dev runs services under bun (the Compute runtime) and how to install it |
| no installed `prisma` bin (the local-Postgres emulator) | what was searched for and to add `prisma` to devDependencies |
| the bucket emulator fails to start or report healthy | the instance name, its log file path, and the port it tried |
| ORM `prisma dev` fails to start | the exact command that was attempted and its output, sanitized — connection-URL credentials are masked before embedding |
| port conflict on a persisted allocation | which service, which port, and how to free or re-allocate (`--fresh`) |
| secret slot unbound | warning (not an error) naming the env var and the placeholder behavior |
| env-sourced param unbound | hard error listing the missing names, deploy-preflight style |
| service crash-loops | the address, exit code, and the last stderr lines, as a standing message |

## Out of scope (designed around)

- **Hot reload / user-supplied dev commands.** The loop's unit of change is a
  rebuilt artifact. The designed extension (not v1): a service may opt into a
  dev command (e.g. `next dev`) that replaces its artifact process; the harness
  still resolves bindings and materializes the same env, and writes the stash
  so `load()`/`config()`/`secrets()` work without `run()`. The opt-in must be
  explicit precisely because it trades away artifact parity.
- **Remote bindings** (a local service against real cloud resources,
  Wrangler-style). A possible future opt-in; contradicts credential-free dev
  as a default.
- **Deploy verification integration** — `verify` runs against a dev instance
  the same way it runs against a deploy (the health surface is just another
  local endpoint); its design is its own lane.

## Open questions

- **Restart latency budget.** Assemble + package + converge per edit is
  unmeasured. The artifact cache (unpack once per hash) is designed; whether
  package's tar step needs a dev bypass for very large trees (Next standalone)
  is a measurement away. Decide with numbers, not in advance.

(Settled since the first draft: Postgres runs one named `prisma dev` instance
per `Database` resource; the front door prints every service URL ordered by
address depth then name, shallowest first; port allocation and the remaining
mechanics are pinned in the implementation spec.)

## Related

- [ADR-0041](../90-decisions/ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md)
  — the decision this doc details.
- [deploy-cli.md](deploy-cli.md) — the pipeline dev re-runs and the error-surface
  convention it extends.
- [alchemy-lowering.md](../05-prisma-cloud/alchemy-lowering.md) — the resource
  inventory and lowering graphs the local providers implement.
- [core-model.md](core-model.md) — `run()`/`load()` and the stash protocol the
  spawned services boot through.
- [goals.md](../00-purpose/goals.md) — the local-dev-emulator goal.

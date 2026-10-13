# Running locally

One command brings your whole app up on your machine — every service, its
databases and buckets, wired together — with **no cloud credentials**.
`prisma dev` runs the same pipeline a deploy runs, but against local
stand-ins for Prisma Cloud, so what you run locally is what you ship. The
logs come from the `log` operation in `@prisma/composer/control`, which you
call from a short script; there is no `prisma` command for them.

| You want to… | Run |
| --- | --- |
| Bring the app up locally | `prisma dev module.ts` |
| Start clean (wipe local data first) | `prisma dev module.ts --fresh` |
| Watch the running app's logs | the `log` operation (see [Logs](#logs)) |

`module.ts` is your entry file — the one whose default export is the root
module, the same file you pass to `prisma deploy`. No `PRISMA_*` variables
and no `prisma auth login` are needed; local dev never talks to the
platform.

## Bring it up

Local Postgres runs on `@prisma/dev`. `@prisma/composer-prisma-cloud` declares
it as a dependency (`^0.25.2`) and resolves it from its own package, so nothing
needs adding to your app and your app's own copy, if any, is not used. Releases
before 0.21.0 crash on any Postgres message over 64 KiB, which is why Composer
owns the version. Nothing about the emulator is needed for cloud deployment or a
local app without Postgres resources.

```sh
prisma dev module.ts
```

It builds nothing for you (bring your own built output, same as deploy), then
stands the app up and prints the **front door** — every service's local URL:

```
dev: ready
storefront: http://localhost:3004
catalog.service: http://localhost:3000
orders.service: http://localhost:3003
```

`dev` prints `ready` only once every service accepts connections on its port, so a request to a printed URL right away connects. After a rebuild, `dev` waits the same way before it prints the URLs again. A service must listen on the port Composer gives it.

If a service exits before it listens, or does not listen within 30 seconds, `dev` fails instead of printing `ready`, and stops the app's other services. The message names the service, its port, and its log file, for example `service "gateway" exited (code 1) before it accepted connections on its port 3001. Its log: …/gateway.log`. On a first start it appears in the deploy engine's output, followed by `prisma dev`'s own error that the deploy engine exited with code 1 (`DEV.CONVERGE_FAILED` from the `dev` operation in `@prisma/composer/control`). On a warm start it is the message of the `DEV.SERVICE_START_FAILED` error.

A service that needs longer to start, for example one that runs migrations first, can have more time: set `PRISMA_COMPOSER_SERVICE_READY_TIMEOUT_MS` to the limit in milliseconds (the default is `30000`). A value that is not a positive whole number fails with `DEV.SERVICE_READY_TIMEOUT_INVALID`. The compute emulator reads the variable when it starts, and a running emulator keeps the value it started with; `--fresh` does not restart it. To apply a new value, end the compute emulator's process (its PID is in `compute.json` in the emulators directory, see below), which stops the services of every app that uses it. The next `prisma dev` starts it again with the new value.

`dev` and the `log` operation retry a call to a local emulator only when they cannot connect to it. If that lasts a few seconds, they fail with `DEV.EMULATOR_UNREACHABLE`, which takes the place of `DEV.SERVICE_START_FAILED`, `DEV.ATTACH_FAILED` and `LOG.ATTACH_FAILED` for this case. An error the emulator returns, such as a service that failed to start, is not retried.

From here `dev` keeps running: it watches your built output and, when a
service's build changes, restarts just that service. It does **not** print
service logs — with several services running, streaming them all inline would
bury the front door and the restart notices. Logs are their own operation
(below).

`dev` reads the `composer` section of `prisma.config.ts` once, when it starts,
and watches the file. When the file changes, `dev` prints that it changed and
must be restarted, and it stops rebuilding: until you stop `dev` and start it
again, a build change only repeats that notice.

`Ctrl-C` stops your app's service processes and exits. The local databases,
buckets, and their data stay up, so the next `prisma dev` is a warm
start — same ports, same data. `--fresh` is what wipes this app's local
instances and data before starting.

On a fresh start, each service gets the lowest free port from 3000 up, in dependency order: a service gets its port before the services that call it, and services with no dependency between them go in the order you provisioned them. A warm start keeps the ports services already have.

### Each directory runs its own services

The services `dev` runs belong to the directory you run it in. Two checkouts
of the same app, such as two git worktrees, run separate service processes on
separate ports, and a rebuild in one never restarts the other's services.
`dev` records which local service backs each of your services in
`.prisma-composer/dev/emulator-instances.json`.

A service keeps its port in its directory from one `dev` to the next, even
while it is stopped. If the local service is gone, for example because a
Composer upgrade discarded the compute emulator's state, the next `dev`
creates it again and asks for the port it had. When another directory has
taken that port, the service gets the lowest free one and `dev` prints one
line:

```
[dev] service "gateway" now uses port 3004: its previous port 3001 is in use
```

A directory runs one app at a time. If you run a different app from the same
directory, `dev` removes the previous app's local services first and says so:

```
[dev] removed the local services of "shop", the app run here before
```

A stopped service keeps its port reserved, so the services of a checkout you
delete keep their ports. There is no command to remove them yet.

Local databases and buckets are not separated this way yet: they are still
keyed by the app's name, so two checkouts of one app share them (see
[What's local vs. what's real](#whats-local-vs-whats-real)).

`--fresh` is also the fix when a framework upgrade leaves stale rows in this
app's local dev state — the symptom is a plan-time error naming an
unregistered resource type (for example
`No provider is registered for resource type 'PrismaComposer.Database'`).
Local dev state is never migrated across framework versions. Note `--fresh`
wipes local *data* too — database contents, bucket objects, instance state —
not just the resource bookkeeping; the next start rebuilds empty resources.
Use it when the local data is disposable, which in a dev loop it usually is.

## Logs

The `log` operation tails the merged logs of the already-running app — one
stream, each line tagged with the service it came from. Run a script like this
from the directory you run `prisma dev` in:

```ts
// logs.ts
import { fileURLToPath } from 'node:url';
import { log } from '@prisma/composer/control';
import prismaConfig from './prisma.config.ts';

const stop = new AbortController();
process.on('SIGINT', () => stop.abort());

const result = await log({
  entry: 'module.ts',
  config: {
    value: prismaConfig.composer,
    file: fileURLToPath(new URL('./prisma.config.ts', import.meta.url)),
  },
  tail: 20,
  signal: stop.signal,
});
if (!result.ok) {
  console.error(result.failure.message);
  process.exit(1);
}
for await (const { service, line } of result.value.lines) {
  console.log(`[${service}] ${line}`);
}
```

The `log` operation reads no credentials. It follows live, like `tail -f`,
until the signal aborts. It only *reads* the
running app — it never builds, provisions, starts, or stops anything, so you
can start and stop it freely alongside a running `dev`.

- **One service:** pass `address: 'cron.runner'`. A nested module's service
  address is dotted, exactly as the front door prints it.
- **How much history:** `tail` sets how many recent lines to show before
  going live (default 0, live only). Each service's log is cleared when it
  starts fresh, so it only ever holds the current run — you're never
  scrolling back through past `dev` sessions.
- **Nothing running yet?** If you haven't started the app with `prisma dev`
  (or stopped it), `log` resolves with an empty `services` list and a stream
  that has already ended.

## What's local vs. what's real

Everything above the cloud boundary is real: your actual service code, real
databases you can migrate and query, real object storage. What's swapped are
the *providers* underneath — local emulators stand in for Prisma Cloud, so no
token, workspace, or network is involved. Three consequences worth knowing:

- **Unset secrets don't stop the app.** A secret you haven't set in your shell
  gets a local placeholder and a one-line warning; the app boots and serves,
  and only the code path that actually spends that secret fails — at the real
  external service it calls. Set the secret in your shell to exercise that
  path.
- **The emulators outlive a session.** They're shared, machine-wide daemons,
  so your data survives `Ctrl-C` and even a reboot until you `--fresh`. That's
  what makes restarts warm.
- **`PRISMA_COMPOSER_EMULATORS_DIR` gives a checkout or a CI job its own
  compute and buckets emulators.** By default every `dev` on the machine
  shares one set of emulator daemons, registered under
  `~/.prisma-composer/emulators`; each directory still gets its own services
  on them. Set the variable to an absolute directory
  and `dev` starts and finds its compute and buckets daemons, their registry
  and their data there instead. Each picks free ports, so several can run side
  by side. A relative path is refused with `DEV.EMULATORS_DIR_INVALID`; `~` is
  not expanded. `emulatorRegistryRoot()` from
  `@prisma/composer-prisma-cloud/local-target` returns the directory in
  effect.

  The variable does not isolate local Postgres. Local Postgres servers are
  named after the app and the database, not the directory, so two checkouts
  of the same app get the same server names. The second checkout's Postgres
  emulator adopts the server the first one is running, and `--fresh` or a
  teardown in either checkout stops that server and deletes its database for
  both.
- **The local Postgres is one shared session.** Every connection to a local
  database lands in the same Postgres session, which outlives your service
  processes. If you use Bun's `SQL`, pass `prepare: false`
  (`new SQL({ url: db.url, max: 1, idleTimeout: 10, prepare: false })`).
  Without it, a restarted service tries to re-create prepared statements its
  previous run left behind, fails with `prepared statement "…" already exists`
  (42P05), and crash-loops.

Windows isn't supported yet.

## Where to go next

- [Deploying and operating](deploying.md) — the same app, on Prisma Cloud.
- [Local dev, in depth](../design/10-domains/local-dev.md) — how the pipeline
  and the emulators actually work.

# Running locally

One command brings your whole app up on your machine — every service, its
databases and buckets, wired together — with **no cloud credentials**.
`prisma dev` runs the same pipeline a deploy runs, but against local
stand-ins for Prisma Cloud, so what you run locally is what you ship. The
logs come from the `log` operation in `@prisma/composer/control`, which you
call from a short script; there is no `prisma` command for them.

| You want to… | Run |
| --- | --- |
| Bring the app up locally | `prisma dev` |
| Hot reload a Next.js service | nothing extra: `prisma dev` runs `next dev` for it (see [Dev servers](#dev-servers)) |
| Start clean (wipe local data first) | `prisma dev --fresh` |
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
prisma dev
```

It builds nothing for you (bring your own built output, same as deploy) —
except that a service whose build adapter declares a **dev server**, such as
every Next.js service, runs that dev server instead and needs no build at all
(see [Dev servers](#dev-servers)). It then stands the app up and prints the
**front door** — every service's local URL:

```
dev: ready
storefront: http://localhost:3004
catalog.service: http://localhost:3000
orders.service: http://localhost:3003
```

`dev` prints `ready` only once every service accepts connections on its port, so a request to a printed URL right away connects. After a rebuild, `dev` waits the same way before it prints the URLs again. A service must listen on the port Composer gives it, unless it is declared with `compute({ ..., listens: false })`: such a service, like the cron module's scheduler, is running as soon as its process starts.

If a service exits before it listens, or does not listen within 30 seconds, `dev` fails instead of printing `ready`, and stops the app's other services. The message names the service, its port, and its log file, for example `service "my-app.gateway" exited (code 1) before it accepted connections on its port 3001. Its log: …/svc_….log`. On a first start it appears in the deploy engine's output, followed by `prisma dev`'s own error that the deploy engine exited with code 1 (`DEV.CONVERGE_FAILED` from the `dev` operation in `@prisma/composer/control`). On a warm start it is the message of the `DEV.SERVICE_START_FAILED` error.

A service that needs longer to start, for example one that runs migrations first, can have more time: set `PRISMA_COMPOSER_SERVICE_READY_TIMEOUT_MS` to the limit in milliseconds (the default is `30000`). A value that is not a positive whole number fails with `DEV.SERVICE_READY_TIMEOUT_INVALID`. The compute emulator reads the variable when it starts, and a running emulator keeps the value it started with; `--fresh` does not restart it. To apply a new value, end the compute emulator's process (its PID is in `compute.json` in the emulators directory, see below), which stops the services of every app that uses it. The next `prisma dev` starts it again with the new value.

`dev` and the `log` operation retry a call to a local emulator only when they cannot connect to it. If that lasts a few seconds, they fail with `DEV.EMULATOR_UNREACHABLE`, which takes the place of `DEV.SERVICE_START_FAILED`, `DEV.ATTACH_FAILED` and `LOG.ATTACH_FAILED` for this case. An error the emulator returns, such as a service that failed to start, is not retried.

From here `dev` keeps running: it watches your built output and, when a
service's build changes, restarts just that service. It prints the output of
the services that run a dev server, and **not** that of the others — with
several services running, streaming them all inline would bury the front door
and the restart notices. Their logs are their own operation (below).

`dev` reads the `composer` section of `prisma.config.ts` once, when it starts,
and watches the file. When the file changes, `dev` prints that it changed and
must be restarted, and it stops rebuilding: until you stop `dev` and start it
again, a build change only repeats that notice.

`Ctrl-C` stops your app's service processes and its local Postgres servers,
and exits; so does `dev` ending on SIGTERM or a failure. The data stays, and
so do the ports, so the next `prisma dev` is a warm start — same ports, same
data. `--fresh` is what wipes this app's local instances and data before
starting.

### Dev servers

A service whose build adapter declares a dev server runs it under `prisma dev`
in place of its built artifact, so your edits are picked up by the framework's
own hot reload instead of a rebuild and a restart:

- **Next.js** (`nextjs({ module, appDir })`): `prisma dev` runs `next dev` in
  `appDir`, using the `next` your app has installed (resolved from `appDir`,
  never one on your `PATH`). No `next build` is needed to run it locally.
- **Node/Bun** (`node({ module, entry })`): none by default — the service runs
  its built `entry`, as before. Write the command on the adapter to get one:

  ```ts
  build: node({
    module: import.meta.url,
    entry: '../dist/server.mjs',
    dev: ['bun', '--watch', 'server.ts'],
  }),
  ```

  It runs in the authoring module's directory with nothing appended, and must
  listen on the port in its `PORT` variable (`HOST` is set too). Remove `dev`
  and the service runs its built `entry` again.

There is no flag: `prisma dev` is the whole command. The output
names each dev server before the app comes up, and its lines are prefixed with
the service's address:

```
shop.web: runs `next dev` in apps/web
dev: ready
shop.web: http://localhost:3001
[shop.web] ▲ Next.js 16.4.0 (Turbopack)
[shop.web] - Local:         http://localhost:3001
[shop.web] ✓ Ready in 319ms
[shop.web]  GET /api/users 200 in 371ms
```

A dev server runs exactly where the artifact would have: on the service's
instance, at its URL, with the environment a deployment gives it. Inside it,
`service.load()` returns the same bindings (a local database is the local
Postgres), `service.input()` the same input document, and `service.port()`
the same port; you never set a `COMPOSER_*` variable yourself. On top of that
it keeps your shell's environment (`NODE_OPTIONS`, proxy settings), which a
deployed artifact does not; Composer's values win over the shell's.

**Secrets come from the shell `prisma` runs in, not from the dev server's own
`.env` loading.** Next.js loads `.env` itself, but never over a variable that
is already set, and Composer has already set every secret: to your shell's
value, or to a `local-placeholder-…` value when your shell has none. A secret
that is only in `.env` therefore reaches the app as the placeholder, and the
`[dev] STRIPE_SECRET_KEY is not set in this shell` warning says so. Load `.env`
where `prisma` reads it, at the top of `prisma.config.ts`:

```ts
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
```

(or `export` the variables in your shell). The next `prisma dev` replaces the
placeholder with the real value.

What else changes for such a service:

- **It is supervised like any service.** `dev` prints `ready` once the dev
  server accepts connections. If it exits before it listens, or never listens
  on its `PORT`, `dev` fails with `DEV.SERVICE_START_FAILED`, and the message
  adds `A dev server must listen on the port in its PORT variable.` A dev
  server that crashes later is restarted with backoff, as an artifact is.
- **Edits to your source are the dev server's business.** `dev` does not
  rebuild for them. It does watch your entry file and every service's
  authoring module, so a change to `module.ts` or a `service.ts` reconverges
  the app. When that changes what a dev server's environment holds, such as a
  dependency's URL or a new input, the dev server is restarted:
  `` shop.web: its environment changed; `next dev` restarted ``.
- **It has no terminal.** Its output goes through the service's log, so a dev
  server that checks for a terminal drops its colours and keyboard shortcuts,
  and a line reaches your screen a moment after it is written.
- **The standalone build is not run locally.** A bug that only exists in the
  `next build` output, such as a file Next's output trace left out, shows up
  at `prisma deploy`, which still assembles the build.
- **One `next dev` per directory.** Next.js refuses a second dev server for the
  same app, so a `next dev` you start yourself beside `prisma dev` points you at
  the service's URL instead. Use that URL.
- `--detach`, `prisma dev stop` and `prisma dev url` work as for any service.
  `prisma dev url shop.web --json` reports `"runs": "dev-server"` for a service that
  runs one and `"runs": "artifact"` for one that runs its build.

Two errors are specific to dev servers: `DEV.DEV_SERVER_UNAVAILABLE` when the
dev server cannot be found (for Next.js, `next` is not installed in `appDir`),
and `DEV.DEV_SERVER_UNSUPPORTED` when the service's package is too old to run
one — the message names the package to update.

### Run it in the background

`prisma dev --detach` does everything `prisma dev` does up to `ready`, prints
the front door, and exits 0, leaving the app running. It does not watch for
changes, and nothing stops the app until you run `prisma dev stop`:

```sh
prisma dev --detach
curl "$(prisma dev url my-app.gateway)"
prisma dev stop
```

This is the form for agents, scripts and CI, which then have no long-running
process to manage. It combines with `--fresh` and `--name`. If it fails before
`ready`, it stops the whole app, including one an earlier `--detach` left running, and exits non-zero, as `prisma dev` does. A failed redeploy has already replaced that service's old process, so the previous app cannot be kept. Fix the build and run `prisma dev --detach` again. To
pick up a rebuild, run `prisma dev --detach` again, or run `prisma dev` in the
foreground: it takes over the running app, watches, and `Ctrl-C` stops it.

On a fresh start, each service gets the lowest free port from 3000 up, in dependency order: a service gets its port before the services that call it, and services with no dependency between them go in the order you provisioned them. A warm start keeps the ports services already have.

### Each directory runs its own services, databases and buckets

The services, databases and buckets `dev` runs belong to the directory you
run it in. Two checkouts of the same app, such as two git worktrees, run
separate service processes on separate ports, with separate databases and
separate buckets: a rebuild in one never restarts the other's services, and
a row or an object written in one is not seen by the other. `dev` records
which local instance backs each node in
`.prisma-composer/dev/emulator-instances.json`.

A service or a database keeps its port in its directory from one `dev` to the
next, even while it is stopped. If a local instance is gone, for example
because a Composer upgrade discarded an emulator's state, the next `dev`
creates it again, empty, and asks for the port it had; a Prisma ORM
database's (`postgres()`) committed migrations then run again, as on a fresh
start, while a `rawPostgres()` database stays empty. When another directory
has taken that port, the instance gets the lowest free one and `dev` prints
one line, naming a service or a database:

```
[dev] service "my-app.gateway" now uses port 3004: its previous port 3001 is in use
[dev] database "catalog" now uses port 51302: its previous port 51300 is in use
```

A directory keeps the local state of every app you run from it. If you run a
different app from the same directory (another entry file, or another
`--name`), `dev` stops the previous app's services and databases first, keeps
their data and ports, and says so:

```
[dev] stopped the local services of "shop", the app run here before; its data is kept
```

Running `shop` again resumes them. `--fresh` wipes only the app you start
with it.

A stopped service or database keeps its port reserved, and a database its
data, so the instances of a checkout you delete keep theirs. There is no
command to remove them yet.

### Finding a running node, and stopping the app

Ports differ from one directory to the next, so don't hard-code
`localhost:3001`. From another terminal in the same directory, ask where a
node of the running app answers, by its address, which starts with the app
name:

```bash
prisma dev url my-app.gateway
```

A service gives `http://localhost:<port>`, a database its connection string
(with its local credentials), and a bucket its S3 endpoint followed by
`/<bucket>`. A node inside a nested module has a longer address, such as
`my-app.catalog.database`.

The URL alone goes to stdout, whether it is a terminal or a pipe, so a script
uses it directly. Check the exit status first, so a failure does not run
`curl` with an empty URL:

```bash
url=$(prisma dev url my-app.gateway) && curl "$url"
```

`prisma dev url`, `prisma dev stop` and `prisma emulator list` first ship in
the `prisma` release after 8.0.0-rc.23, which already writes a command's plain
data to a piped stdout. `--json` gives the full result,
`{ address, kind, url, state }`, or on failure the error with its code.

`dev url` only reports a node that is running, so the URL it prints answers. Otherwise it fails with
a code a script can branch on:

- `DEV.NOT_STARTED_HERE`: `prisma dev` never ran in this directory.
- `DEV.ADDRESS_UNKNOWN`: the app has no node at that address; the message
  lists the ones it has.
- `DEV.EMULATOR_UNREACHABLE`: the emulator the node runs on is not running.
- `DEV.NOT_RUNNING`: the node exists but is not running. Usually it is
  stopped: `prisma dev stop`, `prisma dev` ending, and running another app in
  this directory all stop an app's services and database servers. A service
  that keeps crashing is reported this way too, with the path of its log; and
  a node the emulator lost is created again, empty, by the next `prisma dev`.

`prisma dev stop` stops the app's service processes and database servers, as `Ctrl-C` does. Use it to stop an app started with `--detach`, or when `prisma dev` was killed without the chance to stop it. Data and ports are kept, so the next `prisma dev` is still a warm start. It lists what it stopped; when nothing of the app was running, it says so and still succeeds. Piped, it writes one line per node it stopped with two tab-separated fields: the node's address and its kind.

`prisma emulator list` shows every local emulator on the machine, whether it is running, and every instance on it, with the directory, app and address it belongs to. It works from any directory. Piped, it writes one line per instance with six tab-separated fields: the emulator's kind (`service`, `database` or `bucket`), the instance id, its URL, its state, the address of the node it runs and the absolute path of the directory `prisma dev` ran from. The last two are empty for an instance Composer did not label. An emulator that is running but does not answer, or answers with an error, is shown with that error, and the others are still listed. `prisma emulator start` and `prisma emulator stop` are planned.

Each command's piped lines are listed in [Piped output](#piped-output).

`--fresh` is also the fix when a framework upgrade leaves stale rows in this
app's local dev state — the symptom is a plan-time error naming an
unregistered resource type (for example
`No provider is registered for resource type 'PrismaComposer.Database'`).
Local dev state is never migrated across framework versions. Note `--fresh`
wipes local *data* too — database contents, bucket objects, instance state —
not just the resource bookkeeping; the next start rebuilds empty resources.
Use it when the local data is disposable, which in a dev loop it usually is.

## Piped output

When stdout is a pipe or a file, Composer's commands write data lines to it, one record per line. Everything else, such as progress, tables and warnings, goes to stderr, so `prisma deploy > out.txt` leaves only data lines in `out.txt`. `--json` gives each command's full result instead.

The rules for every line:

- Fields are separated by a tab.
- A backslash, tab, newline or carriage return inside a field is written as `\\`, `\t`, `\n` or `\r`, so each line stays one record.
- An absent value is an empty field. The line still has every field, so `cut -f4` always reads the fourth one.
- Fields are only ever added at the end of a line. Changing, removing or reordering a field is a breaking change.

| Command | One line per | Fields |
| --- | --- | --- |
| `prisma deploy` | deployed entity | node address, entity kind (`compute-service`, `postgres-database` or `bucket`), entity id, URL (empty for an entity without one) |
| `prisma deploy list` | deployed node | node address, kind (`project`, `service`, `postgres`, `bucket`, `module`, or another resource's type), platform ID, URL |
| `prisma dev stop` | node it stopped | node address, node kind (`service`, `database` or `bucket`) |
| `prisma dev url` | the node asked for | URL |
| `prisma emulator list` | emulator instance | emulator kind (`service`, `database` or `bucket`), instance id, URL, state, node address, directory |

A command with nothing to report writes no lines and still exits 0: `dev stop` when nothing was running, and `deploy` for a node that published no entities (such as S3 credentials) or when the deploy wrote no report. [Deploying](deploying.md#production-and-stages) says how to tell these apart.

The directory in `emulator list` is an absolute path, unlike the paths other `prisma` commands print, which are relative to the working directory. The list covers every app on the machine and runs from any directory, so a relative path would change with the directory you run it from and would not identify an app reliably.

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

- **One service:** pass its full address, `address: 'my-app.cron.runner'`,
  exactly as the front door prints it.
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
  external service it calls. Set the secret in your shell, or load your `.env`
  in `prisma.config.ts`, to exercise that path; a `.env` that only your
  framework loads does not count (see [Dev servers](#dev-servers)).
- **The emulators outlive a session.** They're shared, machine-wide daemons,
  so your data survives `Ctrl-C` and even a reboot until you `--fresh`. That's
  what makes restarts warm.
- **`PRISMA_COMPOSER_EMULATORS_DIR` gives a checkout or a CI job its own
  emulators.** By default every `dev` on the machine shares one set of
  emulator daemons, registered under `~/.prisma-composer/emulators`; each
  directory still gets its own services, databases and buckets on them. Set
  the variable to an absolute directory and `dev` starts and finds its
  compute, Postgres and buckets daemons, their registry and their state there
  instead. Each picks free ports, so several can run side by side. A relative
  path is refused with `DEV.EMULATORS_DIR_INVALID`; `~` is not expanded.
  `emulatorRegistryRoot()` from `@prisma/composer-prisma-cloud/local-target`
  returns the directory in effect. A local database's data is kept by
  `@prisma/dev` in its own data directory
  (`~/Library/Application Support/prisma-dev-nodejs/` on macOS,
  `$XDG_DATA_HOME/prisma-dev-nodejs/` on Linux), under a name unique to the
  database, whatever the variable says.
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

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
[dev] ready:
[dev] storefront        http://localhost:3004
[dev] catalog.service   http://localhost:3000
[dev] orders.service    http://localhost:3003
```

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
  emulators.** By default every `dev` on the machine shares one set of
  emulator daemons, registered under `~/.prisma-composer/emulators`. Set the
  variable to an absolute directory and `dev` starts and finds its own
  emulators there instead, with their own data, so two checkouts or two CI
  jobs never share a daemon by accident. Both pick free ports, so they can
  run side by side. The variable doesn't cover local Postgres: `@prisma/dev`
  keeps its server records machine-wide whatever it's set to, so two registry
  roots still share local Postgres data. A relative path is refused with
  `DEV.EMULATORS_DIR_INVALID`.
  `emulatorRegistryRoot()` from `@prisma/composer-prisma-cloud/local-target`
  returns the directory in effect.
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

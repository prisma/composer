# Running locally

One command brings your whole app up on your machine — every service, its
databases and buckets, wired together — with **no cloud credentials**.
`prisma-composer dev` runs the same pipeline a deploy runs, but against local
stand-ins for Prisma Cloud, so what you run locally is what you ship. A second
command, `prisma-composer log`, shows you the logs.

| You want to… | Run |
| --- | --- |
| Bring the app up locally | `prisma-composer dev module.ts` |
| Start clean (wipe local data first) | `prisma-composer dev module.ts --fresh` |
| Watch every service's logs | `prisma-composer log module.ts` |
| Watch one service | `prisma-composer log module.ts catalog.service` |
| Show more history first | `prisma-composer log module.ts --tail 200` |

`module.ts` is your entry file — the one whose default export is the root
module, the same file you pass to `deploy`. No `PRISMA_*` variables are
needed; local dev never talks to the platform.

## Bring it up

```sh
prisma-composer dev module.ts
```

It builds nothing for you (bring your own built output, same as deploy), then
stands the app up and prints the **front door** — every service's local URL:

```
[dev] ready:
[dev] storefront        http://localhost:3004
[dev] catalog.service   http://localhost:3000
[dev] orders.service    http://localhost:3003
[dev] logs: prisma-composer log module.ts
```

From here `dev` keeps running: it watches your built output and, when a
service's build changes, restarts just that service. It does **not** print
service logs — with several services running, streaming them all inline would
bury the front door and the restart notices. Logs are their own command
(below).

`Ctrl-C` stops your app's service processes and exits. The local databases,
buckets, and their data stay up, so the next `prisma-composer dev` is a warm
start — same ports, same data. `--fresh` is what wipes this app's local
instances and data before starting.

## Logs

```sh
prisma-composer log module.ts
```

This tails the merged logs of the already-running app — one stream, each line
prefixed with the service it came from:

```
[catalog.service] listening on :3000
[cron.runner] special rotated to Flat White
[storefront] ✓ ready
```

It follows live, like `tail -f`; `Ctrl-C` stops watching. It only *reads* the
running app — it never builds, provisions, starts, or stops anything, so you
can open and close it freely alongside a running `dev` (or in place of paying
attention to one).

- **One service:** pass its address — `prisma-composer log module.ts
  cron.runner`. A nested module's service address is dotted, exactly as the
  front door prints it.
- **How much history:** `--tail <n>` sets how many recent lines to show before
  going live (default 20; `--tail 0` for live-only). Each service's log is
  cleared when it starts fresh, so it only ever holds the current run — you're
  never scrolling back through past `dev` sessions.
- **Nothing running yet?** If you haven't `dev`'d the app (or `Ctrl-C`'d it),
  `log` says so and points you at `dev`.

## What's local vs. what's real

Everything above the cloud boundary is real: your actual service code, real
databases you can migrate and query, real object storage. What's swapped are
the *providers* underneath — local emulators stand in for Prisma Cloud, so no
token, workspace, or network is involved. Two consequences worth knowing:

- **Unset secrets don't stop the app.** A secret you haven't set in your shell
  gets a local placeholder and a one-line warning; the app boots and serves,
  and only the code path that actually spends that secret fails — at the real
  external service it calls. Set the secret in your shell to exercise that
  path.
- **The emulators outlive a session.** They're shared, machine-wide daemons,
  so your data survives `Ctrl-C` and even a reboot until you `--fresh`. That's
  what makes restarts warm.

Windows isn't supported yet.

## Where to go next

- [Deploying and operating](deploying.md) — the same app, on Prisma Cloud.
- [Local dev, in depth](../design/10-domains/local-dev.md) — how the pipeline
  and the emulators actually work.

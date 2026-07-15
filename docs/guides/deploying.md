# Deploying and operating

`prisma-composer` deploys the app whose root module is your entry file's
default export. Two commands, `deploy` and `destroy`; the target environment —
called a **stage** — is chosen on the command line, never in your code.

| You want to… | Run |
| --- | --- |
| Deploy to production | `prisma-composer deploy module.ts` |
| Deploy an isolated environment | `prisma-composer deploy module.ts --stage <name>` |
| Override the app name for one run | `prisma-composer deploy module.ts --name demo-42` |
| Tear down an isolated environment | `prisma-composer destroy module.ts --stage <name>` |
| Tear down production's resources | `prisma-composer destroy module.ts --production` |

## Credentials

A deploy needs exactly two environment variables: `PRISMA_SERVICE_TOKEN` and
`PRISMA_WORKSPACE_ID`. Nothing else — the CLI resolves the app's Project (by
the root module's name) and, for a named stage, the stage's Branch, creating
either if it doesn't exist yet. A fresh checkout with just those two variables
set deploys successfully.

Keep the values out of the repo — an `.env` you source at deploy time, or CI
secrets. There is no interactive login; the static token is the only
authentication.

## Build first

`prisma-composer deploy` does not build for you:

```sh
turbo run build && prisma-composer deploy module.ts
```

The deploy assembles what your build produced (the `entry` each service's
build adapter names) and provisions it. Deploy state lives in a
workspace-hosted ledger (the `prismaState()` line in
`prisma-composer.config.ts`), shared by every deployer of the app — your
machine and CI see the same state, and concurrent deploys of the same stage
are locked against each other.

## Stages

Same code, many environments. Deploying with no `--stage` targets
**production**, at the Project level. `--stage <name>` targets a **named
stage** — a Branch of that same Project, with its own compute, its own empty
database, and its own configuration
([ADR-0023](../design/90-decisions/ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md),
[ADR-0024](../design/90-decisions/ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)).
Every environment repeats the app's full topology; only the data and config
differ.

```sh
prisma-composer deploy module.ts                  # production
prisma-composer deploy module.ts --stage staging  # an isolated "staging" environment
prisma-composer deploy module.ts --stage pr-42    # one isolated environment per PR
```

Re-deploying the same stage is idempotent: it finds the existing Project and
Branch and updates the resources inside them. A stage name must be a valid
git ref name (checked with `git check-ref-format`); an invalid name is a hard
error, never silently normalized.

Each deployed service becomes a Compute service in the Project; its public
URL is its service endpoint domain, shown in the
[Prisma Console](https://console.prisma.io).

## Destroy requires an explicit target

A bare `prisma-composer destroy` is an error — name what you're tearing down:

```sh
prisma-composer destroy module.ts --stage staging  # removes staging's resources, then its Branch
prisma-composer destroy module.ts --production     # removes production's resources
```

`--stage` and `--production` together is also an error — pick one. Destroying
a named stage deletes its Branch after removing its resources; the production
Branch itself is never deleted, only the resources inside it. Destroy never
creates anything: destroying a stage that was never deployed fails with
"nothing deployed" rather than standing one up first.

## CI

The commands are the same in CI — set the two variables as CI secrets, build,
deploy. The per-PR pattern:

```sh
prisma-composer deploy module.ts --stage "pr-$PR_NUMBER"    # on push
prisma-composer destroy module.ts --stage "pr-$PR_NUMBER"   # on close
```

Secrets your app declares (see
[Building an app § Secrets](building-an-app.md#secrets)) are bound to
platform env-var names by the root module; the deploy provisions their values
from the deploying shell's environment, so CI must also export those
variables (e.g. `AUTH_SIGNING_SECRET`).

## Production behavior

Things every deployed app runs into:

- **Compute scales to zero, and idle database connections are closed.** A
  persistent client crashes into a 502 restart loop unless you keep the pool
  reconnect-friendly and refuse to die on async errors:

  ```ts
  const sql = new SQL({ url: db.url, max: 1, idleTimeout: 10 });
  process.on('uncaughtException', (err) => console.error('uncaughtException', err));
  process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));
  ```

- **Bind `0.0.0.0`**, not loopback — Compute routes external HTTP to the VM,
  so a loopback-only listener is unreachable.
- **Cold starts reset service-to-service connections.** A call into a
  scaled-to-zero service can get `ECONNRESET` while it wakes; retry it.
- **The ingress buffers streaming responses.** An open SSE tail delivers
  nothing and times out at 60s — don't build on streamed HTTP responses.
- **Next.js pages that call `service.load()` need
  `export const dynamic = 'force-dynamic'`** — the runtime environment
  doesn't exist at build time, and Next ignores runtime env for prerendered
  routes.

The full catalogue of platform footguns, with diagnoses, is
[`gotchas.md`](../../gotchas.md) at the repo root.

## Full model

[`docs/design/10-domains/deploy-cli.md`](../design/10-domains/deploy-cli.md)
— the pipeline, stages and containers, the destroy contract, the error
surface.

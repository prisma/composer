# Deploying and operating

One CLI, two commands. `prisma-composer deploy` takes your entry file (the
one whose default export is the root module) and stands the whole app up on
Prisma Cloud; `prisma-composer destroy` tears an environment down. Which
environment you're touching — production or an isolated **stage** — is always
a command-line choice, never something in your code.

| You want to… | Run |
| --- | --- |
| Deploy to production | `prisma-composer deploy module.ts` |
| Deploy an isolated environment | `prisma-composer deploy module.ts --stage <name>` |
| Deploy under a different app name | `prisma-composer deploy module.ts --name demo-42` |
| Tear down an isolated environment | `prisma-composer destroy module.ts --stage <name>` |
| Tear down production's resources | `prisma-composer destroy module.ts --production` |

## Credentials

Two environment variables, nothing else:

- `PRISMA_SERVICE_TOKEN` — create a service token for your workspace in the
  [Prisma Console](https://console.prisma.io).
- `PRISMA_WORKSPACE_ID` — in the workspace's settings.

A fresh checkout with just those two set deploys successfully — the CLI finds
or creates everything else. Keep the values out of the repo (an `.env` you
source at deploy time, or CI secrets). There's no interactive login; the
token is the only authentication.

## Build first

`prisma-composer deploy` does not build for you — it assembles what your
build produced:

```sh
turbo run build && prisma-composer deploy module.ts
```

Deploy state (what's already provisioned, so re-deploys diff instead of
recreate) is stored in your workspace, not on your machine — that's the
`prismaState()` line in `prisma-composer.config.ts`. Everyone deploying the
app shares it, your laptop and CI see the same world, and two concurrent
deploys of the same environment lock each other out instead of corrupting it.

## Production and stages

Deploying with no `--stage` targets **production**. In Prisma Cloud terms:
the app is a Project (named after your root module), and production lives at
the Project level.

`--stage <name>` deploys a complete, isolated copy of the app — every
service, every database, its own configuration — as a Branch of that same
Project. Nothing is shared with production except the code:

```sh
prisma-composer deploy module.ts                  # production
prisma-composer deploy module.ts --stage staging  # a persistent staging environment
prisma-composer deploy module.ts --stage pr-42    # one environment per PR
```

Re-deploying any environment is idempotent — it updates the resources in
place. A stage name must be a valid git ref name (`git check-ref-format`);
an invalid name is a hard error, never a silent rename.

After a deploy, each service is a Compute service in the Project; its public
URL is its service endpoint domain, shown in the Console.

## Destroying

`destroy` refuses to guess. A bare `prisma-composer destroy` is an error —
name the target:

```sh
prisma-composer destroy module.ts --stage staging  # staging only; production untouched
prisma-composer destroy module.ts --production     # production's resources
```

`--stage` and `--production` together is an error too. Destroying a stage
removes its resources and then deletes its Branch; destroying production
removes the resources but the production Branch itself always survives.
Destroy never creates: tearing down a stage that was never deployed fails
with "nothing deployed" rather than provisioning one first.

Destroying production also removes the app's Project once nothing is left in
it, so hand-run stacks don't pile up as empty Projects in your workspace. If
the Project still holds another stage's resources, it's left in place.

## CI

Nothing is CI-specific — set the two variables as CI secrets, build, run the
same commands. The per-PR environment pattern:

```sh
prisma-composer deploy module.ts --stage "pr-$PR_NUMBER"    # on push
prisma-composer destroy module.ts --stage "pr-$PR_NUMBER"   # on close
```

One extra: if your app declares secrets (see
[Building an app § Secrets](building-an-app.md#secrets)) or binds params with
`envParam` (see
[§ Binding a param at provision](building-an-app.md#binding-a-param-at-provision)),
each stage keeps its own copy of those platform variables, and the platform
copy is the store — the deploying shell only seeds it. A fresh stage (a new
`pr-42`) has none of them yet, so CI must export the values
(e.g. `AUTH_SIGNING_SECRET`, `APP_ORIGIN`) alongside the two credentials;
preflight copies missing ones up on that first deploy. A name absent from
both the platform and the shell fails the deploy early, naming the missing
variable.

## Production behavior

What deployed apps actually run into, and what to do about it:

- **Compute scales to zero, and idle database connections get closed.** A
  long-lived client that treats a dropped connection as fatal will crash-loop
  through 502s. Keep the pool small and reconnect-friendly, and don't let an
  async error kill the process:

  ```ts
  const sql = new SQL({ url: db.url, max: 1, idleTimeout: 10 });
  process.on('uncaughtException', (err) => console.error('uncaughtException', err));
  process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));
  ```

- **Bind `0.0.0.0`, not loopback.** Compute routes external HTTP to the VM; a
  `localhost` listener is unreachable from outside.
- **A deployed `/rpc/<method>` returns `401` to you.** RPC calls are
  authenticated for you, and your `curl` isn't one of the services the app
  connected to it — so it's turned away, and a provider with no consumers turns
  away everyone. Reach it through a consumer instead.
- **The `COMPOSER_*` variables in your project belong to the deploy.** Config,
  secret pointers, and service keys all land there, and every deploy rewrites
  them — editing one by hand doesn't survive.
- **Calls into a sleeping service can get `ECONNRESET`** while it cold-starts.
  Retry them.
- **Streaming responses don't stream.** The platform's HTTP front door (the
  ingress) buffers a response until it completes, so an open SSE tail
  delivers nothing and times out at 60s. Don't build on streamed HTTP
  responses.
- **Next.js: pages that call `service.load()` need
  `export const dynamic = 'force-dynamic'`.** The runtime environment doesn't
  exist at build time, and Next won't re-read it for prerendered routes.

When something misbehaves in ways these don't explain, check
[`gotchas.md`](../../gotchas.md) at the repo root — the catalogue of platform
footguns with diagnoses, kept current as we hit them.

## The full picture

[`docs/design/10-domains/deploy-cli.md`](../design/10-domains/deploy-cli.md)
documents the deploy pipeline end to end — stages and containers, the destroy
contract, the error surface.

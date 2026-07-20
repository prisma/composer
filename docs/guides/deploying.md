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
recreate) is stored with the environment it describes, not on your machine —
that's the `prismaState()` line in `prisma-composer.config.ts`. Each
environment keeps a small framework-owned database named
`prisma-composer-state` inside the app's Project, attached to that
environment's Branch. Everyone deploying the app shares it, your laptop and
CI see the same world, and two concurrent deploys of the same environment
lock each other out instead of corrupting it. Destroying or deleting an
environment removes its state with it — don't delete the state database by
hand, or the next deploy will re-provision from scratch.

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
URL is its service endpoint domain — printed when the deploy finishes, and
also shown in the Console.

## What a deploy prints

A deploy ends by printing your app's own topology — the names you authored,
what each one became on the platform, and the public URLs:

```
storefront-auth
├─ auth
│  └─ api   compute-service cps_abc123
│           https://xyz.ewr.prisma.build
├─ db       postgres-database db_def456
└─ web      compute-service cps_ghi789
            https://uvw.ewr.prisma.build
```

The tree is your module structure: `auth.api` is the `api` service inside the
`auth` module. Under each name is the platform resource it became and its id
— the thing to search for in the Console when you need it.

**A URL appears only where the address is genuinely public.** A Compute
service prints one because its endpoint is reachable. A database never does:
it has a connection string, not a public endpoint, and printing it in a
terminal would be the wrong thing in both directions. Nothing that reports a
URL here is a secret, and nothing secret is reported here at all — an
`s3-credentials` node, whose whole product is a key pair, prints no resource
line for that reason.

A node that deployed but published nothing reportable is still listed, marked
`(no entities reported)`, so a node is never silently missing from the tree.

**If you're wondering where the JSON went:** deploys used to end with a raw
`{ outputs: {} }` blob from the underlying deploy engine — always empty, never
about your app. It's gone, replaced by the tree above. Nothing you can
configure printed it and nothing depended on it.

## Destroying

`destroy` refuses to guess. A bare `prisma-composer destroy` is an error —
name the target:

```sh
prisma-composer destroy module.ts --stage staging  # staging only; production untouched
prisma-composer destroy module.ts --production     # production's resources
```

`--stage` and `--production` together is an error too. Destroying a stage
removes its resources, then its state database, then deletes its Branch;
destroying production removes the resources and its state database, but the
production Branch itself always survives.
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

## When a deploy stops on a missing connection value

A dependency's connection declares the values it needs, by name. The node on
the other end of the wire has to supply them. When one doesn't, the deploy
stops and names the edge rather than standing the app up:

```
Connection input "auth.db" declares param "url", but its producer "db" did not
supply it — the producer's outputs carry [host]. Add "url" to the outputs the
producer returns from its lowering, or declare the param optional on the
connection.
```

Two fixes, and which is right depends on whether the value is genuinely
required:

- **The producer should be supplying it** — add the name to what the producer
  returns. This is the common case: the two sides drifted, usually a rename on
  one end only.
- **Absent is legitimate** — declare the param `optional` on the connection.
  The consumer then reads it as `undefined`, which is what it was already
  receiving.

**Why an app you didn't touch can start failing this.** It used to deploy. The
missing value reached the consumer as `undefined`, was written into its
environment, and broke at *that service's* boot — so the crash surfaced in the
service that read the value, not the one that failed to supply it, and the
stack trace pointed at the wrong end of the wire. The deploy now refuses up
front. Nothing about your app got worse; the same mistake now reports itself
where it was made, before anything is provisioned.

You'll only meet this if you wrote the connection or the extension on one side
of the wire — every block that ships with the framework supplies what it
declares.

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

## Upgrading from workspace-hosted state

Older framework versions kept deploy state in a workspace-level
`prisma-composer-state` project instead of inside each environment. There is
no automated migration — a deploy under the new store starts from empty state
and would re-provision resources it can't see. Cut over per app:

1. On the **old** framework version, destroy every environment: each
   `--stage`, then `--production`.
2. Upgrade the framework packages.
3. Deploy again — each environment provisions fresh state in its own Branch.
4. Delete the workspace-level `prisma-composer-state` project from the
   Console whenever convenient; nothing reads it after the upgrade.

## The full picture

[`docs/design/10-domains/deploy-cli.md`](../design/10-domains/deploy-cli.md)
documents the deploy pipeline end to end — stages and containers, the destroy
contract, the error surface.

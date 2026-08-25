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

Deploy state (what's already provisioned, so re-deploys diff instead of recreate) is stored with the environment it describes, not on your machine — that's the `prismaState()` line in `prisma-composer.config.ts`. The platform hosts each environment's state behind its API, scoped to that environment's Branch inside the app's Project; nothing extra shows up in the Console. Everyone deploying the app shares it, your laptop and CI see the same world, and two concurrent deploys of the same environment lock each other out instead of corrupting it: while one holds the deploy lease, the second fails immediately with a message naming the holder. If a deploy crashes, its lease expires (about a minute) and the next deploy takes over; a run that outlives its lease has every state operation rejected by the platform, so it can't corrupt the takeover's state. State lives and dies with its environment: deleting a stage's Branch — or the whole Project — removes that environment's state with it (production's state lifetime is spelled out under Destroying below).

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

`--stage` and `--production` together is an error too. The three teardown shapes differ in what happens to state. Destroying a **stage** removes its resources, then deletes its Branch — and the Branch takes the stage's deploy state with it. Destroying **production** removes the resources and empties production's deploy state as it goes, but the production Branch survives, so an emptied state scope remains until the Project itself is removed. Deleting the **Project** (below, or from the Console) removes every Branch and all state in one stroke. Destroy never creates: tearing down a stage that was never deployed fails with "nothing deployed" rather than provisioning one first.

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

One extra: if your app binds input fields with `envSecret` or `envParam`
(see [Building an app § Service input](building-an-app.md#service-input)),
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

## When a deploy stops on an effect version conflict

Before doing anything else, every `prisma-composer` command verifies that the
installed dependency tree gives alchemy (the deploy engine Composer drives)
the exact `effect` version `@prisma/composer` pins. When it doesn't, the
command stops immediately:

```text
Error: Dependency conflict: alchemy resolves effect@<found>, but
@prisma/composer requires effect@<required>. Your package manager installed a
second effect that alchemy picks up; deploying with it would crash inside
alchemy.
```

This happens when another dependency in your app floats to a newer `effect`
and your package manager hoists that copy where alchemy resolves it — npm
allows this with only a warning, and without the check the deploy would crash
mid-run with a `TypeError` from inside alchemy. Today the floating dependency
is alchemy itself: its own `effect`-family dependency and peer ranges
(`@effect/sql-d1`, `@effect/sql-pg`, `@effect/vitest`, `@effect/platform-*`)
float past the versions its shipped code supports — an upstream alchemy bug
(the `TaggedErrorClass` drift, reported upstream), so every consumer app needs
the constellation pinned until alchemy fixes its ranges. The fix is to pin the
whole `effect` constellation to `@prisma/composer`'s exact pin, in your app's
`package.json`:

```json
"overrides": {
  "effect": "<required>",
  "@effect/sql-d1": "<required>",
  "@effect/sql-pg": "<required>",
  "@effect/vitest": "<required>",
  "@effect/platform-bun": "<required>",
  "@effect/platform-node": "<required>",
  "@effect/platform-node-shared": "<required>"
}
```

yarn spells the block `resolutions`, and pnpm nests it under
`"pnpm": { "overrides": ... }`.

Reinstall afterwards — the setting only takes effect when the tree is rebuilt.
The repo's `examples/*` manifests carry this exact block.

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

## Upgrading from an older state store

Older framework versions stored deploy state differently: first in a workspace-level `prisma-composer-state` project, later in a small `prisma-composer-state` database on each environment's Branch. The current version stores state behind the platform's API and never reads either legacy store — there is no automated migration. The cutover is the same for both generations: destroy, upgrade, redeploy.

Deploying over a live legacy environment is refused up front. The deploy finds no API-hosted state but sees resources (apps, databases, or buckets) already on the Branch, and stops with an error saying the stage predates the platform state API — instead of blindly recreating every resource and failing halfway. Cut over per app:

1. On the **old** framework version, destroy every environment: each `--stage`, then `--production`. (Equivalent: delete the stage's Branch — or the whole Project, for production — in the Console or via the Management API.)
2. Upgrade the framework packages.
3. Deploy again — each environment starts fresh, hosted behind the platform state API.

Recreated apps get new generated URLs; anything pointing at the old ones
needs updating.

Legacy leftovers are inert and safe to remove whenever convenient — nothing reads them after the upgrade, and each costs only a database quota slot:

- Branch-hosted generation: destroying on the old version already removed the environment's `prisma-composer-state` database. If you skipped that and deleted Branches by hand instead, each Branch took its database with it — but production's, on the default Branch, survives: delete it in the Console.
- Workspace-hosted generation: delete the workspace-level `prisma-composer-state` project from the Console.

## Upgrading to the upstream Prisma resources

Framework versions that manage databases, apps, deployments, and environment variables through upstream alchemy's Prisma provider adopt each environment's existing resources in place — deploy state already in the platform state API is migrated automatically on read (rows written under retired type-ids), and production environments redeploy with no changes to their databases or connections. Stages still on the older SQL state store are not migrated — destroy and redeploy them, as the section above describes.

**A service's deployment is replaced exactly when its artifact or environment changed, and reused otherwise.** The platform freezes a deployment's environment when the deployment is created, so a changed value only takes effect through a new one — the framework declares each service's environment values as the deployment's replacement triggers (alchemy's `Prisma.Deployment.triggers`), so a changed variable, a value re-issued in place (a connection rotated in place, a re-minted service key), or an out-of-band rotation of a platform variable a row points at all ship a new deployment, and an unchanged service redeploys nothing. No plaintext lands in deploy state — alchemy persists only a salted fingerprint of the trigger values. A replacement uploads the artifact, starts it, moves the stable endpoint over, and removes the old deployment; your service's URL does not change.

**`DATABASE_URL` and `DATABASE_URL_POOLED` hold the placeholder `"-"`, and the framework never modifies or deletes them.** At provision the framework claims both names (production and preview class, project level) with the placeholder, using create-only writes: if the variable already exists — yours, or one Prisma Cloud seeded — the claim does nothing. The placeholder is deliberate. Without it, Prisma Cloud fills a missing `DATABASE_URL` in on the first deploy with a live credential to one of your app's own databases, and anything reading `process.env.DATABASE_URL` directly would quietly work against a database it was never wired to. With it, a direct read fails loudly. Nothing you declare can carry those names — `envSecret`/`envParam` reject them — and every database URL your services use comes from the connection they declare.

On the first deploy after the upgrade, the framework also **stops tracking** the two variables in deploy state. The deploy log reports them as `retained`: the entry is dropped from state and no call is made to Prisma Cloud.

Deleting the variables by hand is not useful: the next deploy's claim (or the platform's own template filler) recreates them. If you genuinely want a value there — for a tool outside the framework that insists on `DATABASE_URL` — set your own value in the Console; both the framework's claim and the platform's filler are create-only and will leave your value alone.

**Stage (`--stage`) environments see two one-time effects on their first deploy after the upgrade**, because a branch-attached database can no longer carry an explicit display name at create:

- Each existing stage database is **renamed** to a generated physical name (`<app>-<resource>-db-<stage>-<suffix>`). The database itself, its data, and its ID are untouched — only the display name in the Console changes.
- The database's **default connection credentials are rotated** during that same reconcile. The framework's own named connection — the one your services actually use — is NOT rotated and keeps working. Only credentials minted outside the framework from the database's *default* connection (for example, copied out of the Console) stop working and must be re-issued.

Local dev state is not migrated: if `prisma-composer dev` fails at plan time with `No provider is registered for resource type 'PrismaComposer.…'`, run it once with `--fresh` to clear the stale local state.

## Updating a database whose schema an older version synthesized

Older framework versions created a fresh `pnPostgres` database's schema at first deploy by synthesizing it from the contract, with no migration authored. Deploys are now replay-only — they apply only committed migrations — so the first contract change against such a database refuses with `MIGRATION_PATH_NOT_FOUND`: the migration graph has no edge reaching the database's current schema, because none was ever authored.

The marker those deploys signed is an accurate signature of the schema, so the fix is to make the authored graph reach it. The refusal names the database's current hash. Set a ref to that hash — write `migrations/app/refs/db.json` (the ref `migration plan` reads its origin from) with `{ "hash": "<the marker's hash>", "invariants": [] }` — then emit and plan as usual:

```bash
prisma contract emit
prisma migration plan --name <slug>
```

With the graph empty, planning auto-baselines from the ref: it authors empty → the deployed hash, plus the migration from there to your new contract. Applying against the deployed database starts at the marker, so only the delta runs; a genuinely fresh database replays the whole path from empty. Commit `migrations/` and deploy — no special command or pipeline mode is involved.

Everything the CLI does is also callable in-process, from
`@prisma/composer/control`: typed `deploy`, `destroy`, `dev`, and `log`
operations that return structured results instead of printing and exiting.
The `prisma-composer` commands are thin renderers over these same operations,
so the two surfaces can't drift.

```ts
import { deploy } from '@prisma/composer/control';

const result = await deploy({ entry: 'module.ts', stage: 'pr-42' });
if (result.outcome === 'deployed') {
  // result.summary — the deployed topology (app name + each node's
  // address and entities), when the deploy engine reported one.
} else {
  console.error(result.failure.message); // same fix-naming text the CLI prints
}
```

What to know before embedding it:

- **Inputs mirror the flags, but typed.** A bare `deploy` targets production,
  exactly like the CLI. `destroy` takes a discriminated target —
  `{ kind: 'production' }` or `{ kind: 'stage', stage }` — so there is no
  silent default to production and no flag-combination footgun.
- **Failures are results, not throws.** Every operation resolves to either
  its success shape or `{ outcome: 'failed', failure }`, where
  `failure.kind` is one of `invalid-input`, `unsupported-platform`, `pipeline`
  (anything between loading the deploy stack and the deploy engine — including
  the [effect version conflict](#when-a-deploy-stops-on-an-effect-version-conflict),
  reported with the same fix-naming message the CLI prints), or `execution`
  (the engine ran and failed). An `execution` failure's optional
  `diagnostics` object carries the exit code and an exact reproduce command —
  details of the current execution mechanism, handy for printing a hint but
  not something to build on; branch on `message`/`cause` for anything
  durable. Importing the module executes nothing until you call an operation.
- **`summary` is best-effort.** It rides a result file the deploy engine's
  child process writes; a deploy that converged without writing one still
  succeeds, with `summary: undefined`.
- **The engine's own output still streams to your process's stdio.** That is
  the current mechanism, not a promise: the operations return structured
  results but don't capture the live deploy output; run them where that
  output belongs, or with stdio redirected. Capturing it would be a new
  option on the operations.
- **`dev` resolves to `{ outcome: 'started', session }` or a failure** —
  never an exit code. The session is `{ endpoints, stop(), closed }`, with
  progress (`ready`, `converge-failed`, `watch-error`, …) delivered through
  `onEvent`. The operation never installs signal handlers; wiring Ctrl-C to
  `session.stop()` is yours.
- **`log` resolves to `{ outcome: 'attached', appName, services, lines }` or
  a failure.** `lines` is an `AsyncIterable` ended by an `AbortSignal` you
  own (stopping early — `break`, `lines.return()` — also ends it cleanly).
  Zero running services is a valid result (empty `services`, finished
  stream), not an error. A consumer that falls behind loses oldest lines
  past a bounded queue and is told via a `lines-dropped` event.

## The full picture

[`docs/design/10-domains/deploy-cli.md`](../design/10-domains/deploy-cli.md)
documents the deploy pipeline end to end — stages and containers, the destroy
contract, the error surface.

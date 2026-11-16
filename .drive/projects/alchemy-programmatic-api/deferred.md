# Deferred

## Deploy still sets the reporter variables in `process.env`

Slice 4 sends every Management API request through the engine's `ctx.api` and writes no credential into `process.env`. The Prisma Cloud provider, its client and the state store take the client as a value. What remains in the converge's environment overlay is each reporter's variables (`PRISMA_BUILD_ID`, read by the state store's resource reporting), plus the change of working directory for Alchemy's `.env` and `.alchemy`. Both are Composer's own and are why one process runs one converge at a time (`DEPLOY.CONVERGE_RUNNING`).

Wanted: the reporter hands its build id to the lowering as a value, as `LowerOptions.credentials` now carries the client, so the overlay is empty. The working directory remains until Alchemy takes a directory for `.env` and `.alchemy` as a value.

Origin: Will, 2026-11-06, while discussing the `prisma login` token gap in #405. Slice 4 did the credential part.

## The engine does not tell commands where `ctx.api` sends requests

With a supplied client, Composer recognises Management API requests by the origin it computes from `PRISMA_MANAGEMENT_API_URL`, the variable the `prisma` CLI reads to build `ctx.api`. That only works while both read the variable the same way. A caller that passes its own client must also set `PRISMA_MANAGEMENT_API_URL` to match it.

Wanted: `@prisma/cli-engine` exposes the client's base URL to commands (it already holds it as `apiBaseUrl` in its Management API client config), the deploy command passes it with the client in `CallerCredentials`, and Composer routes by that value instead of reading any environment variable. `@prisma/cli-engine` is our own package in prisma-cli, so this is our follow-up, not an upstream ask.

Origin: slice 4 review (D02).

## Destroy still authenticates with a token in a child process

Deploy runs Alchemy in process and authenticates every request through `ctx.api`. Destroy still runs Alchemy in a child process with `needs: { credentials: 'child' }`, so it gets a token snapshot that cannot refresh, and a `prisma login` session works differently for the two commands.

Wanted: destroy runs in process like deploy and passes `ctx.api` the same way.

Origin: slice 4 review (D03).

## Alchemy's HTTP state store requires a token

`makeHttpStateStore` takes a required `authToken` and always sets `Authorization: Bearer <authToken>`. Composer passes an empty string, and the deploy's `HttpClient` removes the header before the request reaches the client. That works, but only because the adapter removes every `Authorization` header.

Wanted: upstream makes `authToken` optional and sets no header without one, the same change alchemy-run/alchemy#3101 made for `PrismaEnvironment`. Then Composer passes no token.

Origin: slice 4 review (S03).

## Alchemy's `PrismaEnvironment` has no type for "the HTTP client authenticates"

Upstream's `PrismaEnvironment` only allows `type: 'serviceToken'`, and `source.type` is `'stored'` or `'env'`. With a supplied client, Composer has no token and the client authenticates each request, so Composer sets `type: 'serviceToken'` and `source: { type: 'stored', details: … }`, with `details` saying the caller's client holds the credential. That is the closest honest value the type allows, but any upstream code that branches on `type` would still read it as a service token.

Wanted: upstream adds a variant for a caller-authenticated HTTP client (for example `type: 'transport'` with no token), on alchemy-run/alchemy#3101 or a follow-up.

Origin: slice 4 review (S05).

## Log tailing cannot authenticate through a supplied client

Alchemy's Prisma log tailing (`tailDeploymentLogs`) opens a WebSocket outside `HttpClient`. A caller that supplies a client and no token gets a socket with no authentication. Composer never tails, so nothing breaks today.

Wanted: a CLI mechanism for WebSockets equivalent to the one `ctx.api` gives HTTP, then an upstream change so the socket uses it.

Origin: Sam Goodwin's review of alchemy-run/alchemy#3101, 2026-11-07.

## An interrupted create leaves an unfinished service version

After Ctrl-C during a deploy that was creating a compute deployment, the next deploy prints Alchemy's "Skipping recovery … must be identified and cleaned up manually" and a service version stays in status `new` until the service is destroyed. Not compared with `main`'s child-process path.

Wanted: find out whether the child path did the same; if the in-process interruption is what skips Alchemy's recovery, let the interrupted apply finish its recovery step before the scope closes.

Origin: manual QA of #405, 2026-11-17.

## A redeploy with no changes reports "updated" steps

A second `prisma deploy` with nothing changed still reports six `updated …env.COMPOSER_…` steps and `updated …deployment`, though no resource or service version changes. Not compared with `main`.

Origin: manual QA of #405, 2026-11-17.

## `PrismaEnvironment` is evaluated per request since alchemy 2.0.0-beta.87

Upstream now holds `PrismaEnvironment` as an Effect that runs on every request, and has `fromEnvironment()` in `@alchemy.run/prisma/internal/Credentials`. Composer still builds Distilled `Credentials` by hand and routes requests through its own HTTP client over `ctx.api`. The `ctx.api` design stays (decided with Will, 2026-11-07); this only notes that the hand-built `Credentials` could go if upstream makes `fromEnvironment()` public.

Origin: the move to alchemy 2.0.0-beta.87 on #405.

## Names that still describe two processes

`RunReporter.childEnv()` and `LowerOptions.firstProcessNodeAddresses` are named after the child-process design. The second cannot be renamed while `destroy` and `prisma dev` call `lower()` from a generated stack file with no contract check (ADR-0065).

Origin: consolidation review of #405 (S08, S13).

## `prisma dev` in process: reload design is open

#411 is paused. Its recorded plan, loading the app definition in a child process that hands the graph back, cannot work: the graph holds functions. A test on Node 24.13 and Bun 1.3.13 showed both runtimes can reload the app's own files in process (Bun by deleting them from `require.cache`, Node by a resolve hook that adds a generation number to app file URLs). ADR-0064's dev amendment on this branch says neither runtime can; that is wrong for both. Will has not decided. The in-process ADR is ADR-0065 on #405 since `main` took ADR-0064; this branch must follow when #405 is merged in.

Origin: dante-73, verification of the handover brief, 2026-11-11.

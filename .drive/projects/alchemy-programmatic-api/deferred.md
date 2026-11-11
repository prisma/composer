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

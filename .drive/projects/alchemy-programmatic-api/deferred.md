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

## `destroy` does not know the secrets in the `secrets` list

`destroy` reads the `config` adapters and not the `secrets` adapters, so its known secrets are only the values the app configuration holds. A secret that is only in the `secrets` list, such as `DB_PASSWORD`, is unknown to it, so a `config` value that contains it, such as `DATABASE_URL`, is written to destroy's app configuration file and is not redacted. The behaviour is the same on `main`. The guide and `deploy-cli.md` now state the limit.

Wanted: decide whether `destroy` should read the app secrets for the refusal and for redaction.

Origin: review of `b0c3453a` (F04).

## Destroying the `production` environment deletes the project, with every other environment's resources

Seen in QA on 2026-11-18: one project held a stack in `dante73-qa-token` and another in `production`. `destroy --environment production` removed the project, which removed the other environment's bucket and service too and left that environment's Alchemy state behind. The behaviour is the same on `main`.

Wanted: decide whether `destroy` of `production` should refuse, or warn, when another environment in the project still has deployed resources.

Origin: manual QA after the #431 merge.

## Follow-ups from the review of the dev converge worker (#411)

- **Core's `firstProcess*` and `SecondProcess*` names** (`LowerOptions.firstProcessNodeAddresses` and others) describe a mechanism only `destroy` still has. Renaming changes the converge contract shapes, so do it when `destroy` moves in process. Origin: review S08.
- **`DevStep` ids are strings the command parses** (`dev.rebuild.N`), where `DeployStep` is structural. Origin: review S11.
- **The main thread loads the app's whole converge entry only to check it** before anything local is created; the worker loads it again. A lighter check (the contract entry alone) would do. Origin: review S12.
- **The session's own view of the app is the one from start.** Adding or removing a node needs `prisma dev` restarted. The worker could send back the plain facts the session needs (addresses, kinds, dev servers, watch paths). Origin: ADR-0067.

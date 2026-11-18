# Deferred

## Deploy still sets the reporter variables in `process.env`

Slice 4 sends every Management API request through the engine's `ctx.api` and writes no credential into `process.env`. The Prisma Cloud provider, its client and the state store take the client as a value. What remains in the converge's environment overlay is each reporter's variables (`PRISMA_BUILD_ID`, read by the state store's resource reporting), plus the change of working directory for Alchemy's `.env` and `.alchemy`. Both are Composer's own and are why one process runs one converge at a time (`DEPLOY.CONVERGE_RUNNING`).

Wanted: the reporter hands its build id to the lowering as a value, as `LowerOptions.credentials` now carries the client, so the overlay is empty. The working directory remains until Alchemy takes a directory for `.env` and `.alchemy` as a value.

Origin: Will, 2026-11-06, while discussing the `prisma login` token gap in #405. Slice 4 did the credential part.

## The engine does not tell commands where `ctx.api` sends requests

With a supplied client, Composer recognises Management API requests by the origin it computes from `PRISMA_MANAGEMENT_API_URL`, the variable the `prisma` CLI reads to build `ctx.api`. That only works while both read the variable the same way. A caller that passes its own client must also set `PRISMA_MANAGEMENT_API_URL` to match it.

Wanted: `@prisma/cli-engine` exposes the client's base URL to commands (it already holds it as `apiBaseUrl` in its Management API client config), the deploy command passes it with the client in `CallerCredentials`, and Composer routes by that value instead of reading any environment variable. `@prisma/cli-engine` is our own package in prisma-cli, so this is our follow-up, not an upstream ask.

Origin: slice 4 review (D02).

## Alchemy's HTTP state store requires a token

`makeHttpStateStore` takes a required `authToken` and always sets `Authorization: Bearer <authToken>`. Composer passes an empty string, and the deploy's `HttpClient` removes the header before the request reaches the client. That works, but only because the adapter removes every `Authorization` header.

Wanted: upstream makes `authToken` optional and sets no header without one, the same change alchemy-run/alchemy#3101 made for `PrismaEnvironment`. Then Composer passes no token.

Origin: slice 4 review (S03).

## Alchemy's `PrismaEnvironment` has no type for "the HTTP client authenticates"

Upstream's `PrismaEnvironment` only allows `type: 'serviceToken'`, and `source.type` is `'stored'` or `'env'`. With a supplied client, Composer has no token and the client authenticates each request, so Composer sets `type: 'serviceToken'` and `source: { type: 'stored', details: … }`, with `details` saying the caller's client holds the credential. That is the closest honest value the type allows, but any upstream code that branches on `type` would still read it as a service token.

Wanted: upstream adds a variant for a caller-authenticated HTTP client (for example `type: 'transport'` with no token), on alchemy-run/alchemy#3101 or a follow-up.

Origin: slice 4 review (S05).

## `destroy` does not know the secrets in the `secrets` list

`destroy` reads the `config` adapters and not the `secrets` adapters, so the secrets it redacts in its events are only the values the app configuration holds. Since destroy moved in process it writes no file, so the only effect is on redaction of event text.

Wanted: decide whether `destroy` should read the app secrets for redaction.

Origin: review of `b0c3453a` (F04), narrowed when destroy moved in process.

## The public `deploy` and `destroy` operations take no credentials

The `prisma deploy` command passes `ctx.api` through an internal seam. A script that calls `deploy` or `destroy` from `@prisma/composer/control` cannot pass a client, so it authenticates with `PRISMA_SERVICE_TOKEN` only, and a `prisma login` session cannot destroy an environment.

Wanted: a `prisma` command for destroy, or a public `credentials` field on both inputs.

Origin: moving destroy in process.

## Load still refuses a root input value JSON cannot hold exactly

The check existed because `destroy` wrote the root's input to a JSON file. No command writes that file now. `prisma dev` copies the values to a worker thread, which allows more than JSON does.

Wanted: decide whether the restriction stays (one rule for every command) or is relaxed to what a thread can copy.

Origin: moving destroy in process.

## Destroying the `production` environment deletes the project, with every other environment's resources

Seen in QA on 2026-11-18: one project held a stack in `dante73-qa-token` and another in `production`. `destroy --environment production` removed the project, which removed the other environment's bucket and service too and left that environment's Alchemy state behind. The behaviour is the same on `main`.

Wanted: decide whether `destroy` of `production` should refuse, or warn, when another environment in the project still has deployed resources.

Origin: manual QA after the #431 merge.

## Follow-ups from the review of the dev converge worker (#411)

- **`DevStep` ids are strings the command parses** (`dev.rebuild.N`), where `DeployStep` is structural. Origin: review S11.
- **The main thread loads the app's whole converge entry only to check it** before anything local is created; the worker loads it again. A lighter check (the contract entry alone) would do. Origin: review S12.
- **The session's own view of the app is the one from start.** Adding or removing a node needs `prisma dev` restarted. The worker could send back the plain facts the session needs (addresses, kinds, dev servers, watch paths). Origin: ADR-0067.
- **The worker Loads the app twice per converge**, once to compare the reads of platform variables and once inside `lower()`, so every module body runs twice. Move the comparison into `lower()` when the converge contract shapes next change. Origin: round-2 review S21.
- **Under Node, `import './lib'` fails even when `lib/index.ts` exists**, while Bun loads it. The entry resolve hook tries its candidates only on "module not found", and Node raises a directory-import error instead. Origin: round-4 review.
- **Core's two refusals of a graph that differs from the first Load's have names but no error code.** `GRAPH_CHANGED_ERROR` and `ROOT_INPUT_UNREAD_ERROR` are plain named errors, recognised by name because they cross from the app's install of core to the host's. Under `deploy` each is a reason of `DEPLOY.ENGINE_FAILED`. Give both a code in the registry when errors can cross installs with their envelope. Origin: round-4 review S05.
- **Watches added during a dev session do not wait for the watcher to be ready**, so an edit made in the first moments after a newly imported file is recorded can be missed. Origin: round-3 review.

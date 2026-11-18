# Slice 4: Deploy authenticates through ctx.api

Composer branch: on top of #405 (`claude/alchemy-deploy-in-process`), merged up into #411. Upstream branches: `prisma-transport-auth` in alchemy-run/alchemy (`packages/prisma`) and in alchemy-run/distilled (`packages/prisma`).

## Goal

`prisma login` then `prisma deploy` works with no `PRISMA_SERVICE_TOKEN`. Every Prisma Management API request a deploy makes, from Alchemy's Prisma provider and from Composer's own resources, goes through the engine's `ctx.api`, which sets the bearer token and refreshes it. No token value reaches Composer's code, and deploy writes nothing into `process.env` for credentials.

## Design

- **Distilled `@distilled.cloud/prisma`:** `Credentials.Config.apiToken` becomes optional. The protocol sets `Authorization` only when a token is present.
- **Alchemy `@alchemy.run/prisma`:** `PrismaEnvironment`'s `serviceToken` becomes optional. `makePrismaClient` sets the bearer header only when present (the request path and the two raw log requests). The `Credentials` bridges pass the token through as optional. Env and profile resolution keep requiring a token as today; only a caller-built `PrismaEnvironment` may omit it.
- **Composer:**
  - An Effect `HttpClient` that executes each request through the engine's SDK client (`ctx.api`), using the per-method calls (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) rather than `request`, since older SDK peers may not have it. It passes the body through unchanged, reads the response as a stream, keeps the deploy-source headers, and honours the abort signal. Only Management API requests go through it. Requests to any other host (the presigned artifact upload URLs) go to the node transport unauthenticated, because Alchemy's upload client is internal to the provider (ADR-0064).
  - The Prisma bundle in `lowering/src/providers.ts` takes this client as its `HttpClient`, and builds `PrismaEnvironment` and `Credentials` with the base URL and no token, when a client is supplied.
  - Composer's own `ManagementClient` is the supplied client itself, not a second one built from a token.
  - When no client is supplied (programmatic `operations.deploy` with only environment variables), the client is built from `PRISMA_SERVICE_TOKEN` as today and used through the same path.
  - Remove `DEPLOY.SERVICE_TOKEN_REQUIRED`, the deploy command's `serviceToken` plumbing, and the `PRISMA_SERVICE_TOKEN`/`PRISMA_WORKSPACE_ID` entries of the deploy converge's environment overlay. The workspace id comes from `ctx.activeCredential()`.
  - Destroy (still a child process) and dev (local target) are unchanged.

## Pinning

Until the two upstream PRs are released, pin `alchemy`, `@alchemy.run/prisma` and `@distilled.cloud/prisma` to preview builds of the upstream branches (see the upgrade skill). Publishing stays blocked by `check:publish-deps` until they are released.

## Done when

- A unit test drives a provider request through the adapter with a fake SDK client, and asserts no `Authorization` header is set by Alchemy or Composer and the fake client received the request.
- Deploy with a stored session and no `PRISMA_SERVICE_TOKEN` gets past preparation (test with the engine's test harness).
- Upstream: unit tests for the optional token in both repos.
- Manual QA: `prisma login`, then `prisma deploy` of an example to Prisma Cloud, then a second deploy; deploy with `PRISMA_SERVICE_TOKEN` set still works.

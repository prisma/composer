# Slice S1: auth-module-core — dispatch plan

Sequential; one persistent implementer. Validation gate per dispatch:
`pnpm typecheck` + the named package-scoped tests + `pnpm lint` on touched
packages; D6 adds build + deployed smoke.

## D1 — authSecret resource

**Outcome:** the target mints a stable per-instance secret resource.
**Focus:** `packages/1-prisma-cloud/1-extensions/target`: `auth-secret.ts`
+ `auth-secret-resource.ts` mirroring `s3-credentials{,-resource}.ts`
(kind `'auth-secret'`, `{ value: string }`, 32 random bytes base64,
reconcile keeps output), registered everywhere `s3Credentials` is; unit
tests per its pattern.
**Builds on:** —. **Hands to:** `authSecret({name})`/`authSecret()`
importable and tested.

## D2 — pack requirement end to end in the target

**Outcome:** a pn database can carry an extension-pack requirement:
wireable, preflighted at deploy, migrated multi-space.
**Focus:** spec § Target changes items 2–4: `pnPackRequirement` +
`satisfies` branch (`orm-postgres.ts`); preflight with the three pinned
error messages (`preflight.ts` + hook into `descriptors/orm-postgres.ts`);
`resolvePnProject` (`orm-config.ts`) + `extensionPacks` threading +
noop-suppression + migration-resource key folding pack hashes
(`orm-migrate.ts`, `orm-migration-resource.ts`). Unit tests for
each; integration test for multi-space migrate against local PG using a
synthetic pack fixture.
**Builds on:** —. **Hands to:** target APIs the pack (D3) and module (D4)
consume.

## D3 — the auth pack

**Outcome:** the `auth` contract space exists, migrates, and matches
Better Auth.
**Focus:** scaffold `packages/1-prisma-cloud/2-shared-modules/auth`
(package.json/tsconfig/tsdown per email); `src/pack/` per spec § Pack:
contract.prisma (namespace `auth`; pinned better-auth version's tables
for jwt+admin+magicLink+bearer), emitted contract.json/d.ts, authored
`0001_init` migration, generated `schema.sql`, descriptor `index.ts`
(`AUTH_PACK_ID`, `AUTH_PACK_HEAD_HASH` constants file), `pnpm
generate:schema` script; schema-conformance test (spec § Test plan).
**Builds on:** D2 (integration test migrates the real pack).
**Hands to:** pack artifacts + constants D4–D6 import.

## D4 — contracts, module, service, store, handlers

**Outcome:** the module's full typed surface exists and its handlers pass
against local Postgres.
**Focus:** `contract.ts` (ports, record schemas, `authApi()`,
`jwtVerifier()`, `authDb()`), `auth-module.ts` (no email dep — S1 shape),
`auth-service.ts`, `auth-store.ts` + `pg-auth-store.ts` (pinned per-op
SQL, `AUTH_SCHEMA` constant, quoted `"user"`), `handlers.ts`; type tests
+ unit tests + store integration tests (pg-harness pattern).
**Builds on:** D1 (authSecret dep), D3 (schema for store tests).
**Hands to:** everything the entrypoint composes.

## D5 — boot, options, proxy, verifier, local server

**Outcome:** the module boots; the full local loop passes with no cloud
credentials.
**Focus:** `auth-options.ts` (pinned values; S1 no-op senders),
`execution/auth-entrypoint.ts` (fetch composition per spec),
`proxy.ts`, `execution/testing.ts` (`startLocalAuthServer` +
`capturedEmails`), exports barrels + planes config; integration suite:
signup/login/logout, cookie + bearer, `/api/auth/token` + `jose` verify
via `jwtVerifier` hydrate, session/admin ports over rpc, proxy behavior
tests.
**Builds on:** D4. **Hands to:** a runnable module.

## D6 — example, deploy, packaging polish

**Outcome:** `examples/auth` deploys to real Prisma Cloud; smoke passes;
packaging/lint surfaces clean.
**Focus:** `examples/auth` per spec (empty-app-space Prisma ORM project +
authPack; api service with proxy + verifier + session dep; ops service
with admin dep; `scripts/smoke.ts`; local integration tests); public
package re-exports; README (S1 sections); exports-entrypoints exception
list; depcruise green workspace-wide.
**Builds on:** D5. **Hands to:** slice DoD; PR-open.

Gate for D6 deploy: source `~/.config/prisma-compose/deploy.env` via
`PRISMA_DEPLOY_ENV` (never print values).

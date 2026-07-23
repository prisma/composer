# Project: `auth` module — implementation spec

> Status: settled design, 2026-07-22 (design sessions with Will; record in
> `design-notes.md`). This spec is exhaustive by intent: every name, type,
> behavior, and file placement is pinned. An implementer who finds a genuine
> gap records it here and asks — they do not improvise.

## At a glance

Signup, login, sessions, and JWT verification as a composed module wrapping
**Better Auth** (TypeScript library, in-process, owns Postgres tables — not a
remote IdP). Dedicated-service shape: one Compute service, three consumer
surfaces (`api` public HTTP, `session` rpc, `admin` rpc), plus a stateless
`jwtVerifier()` binding. The Better Auth schema ships as a **Prisma Next
extension pack** (`auth:` contract space) carrying the contract and authored
migrations: the consumer's one deploy migration step creates and evolves the
auth tables beside their own, the database's marker is signed per space, and
consumer tables FK `auth:User` via prisma-next ADR 226. Email (verification,
reset, magic links) rides the `email` module (PR #146) through
consumer-declared templates. The instance secret is platform-minted. Browsers
reach Better Auth through a proxy route on the consumer app's origin.

## Settled decisions (do not relitigate)

| # | Decision | Why |
|---|---|---|
| D1 | Dedicated Compute service wrapping Better Auth; module owns its tables behind the boundary | ADR-0016; Better Auth is a library — our service hosts it |
| D2 | The database is a boundary dependency (`db` slot), never self-provisioned by the module | Streams precedent (`store: s3()`); the root decides dedicated vs shared; sharing is a wiring choice, not a module-shape change (ADR-0013 one-provision-N-wirings) |
| D3 | Better Auth's schema ships as a Prisma Next **extension pack** (`id: 'auth'`, contract + authored migration packages); Better Auth's own migrator never runs anywhere | Framework-owned deterministic migration (ADR-0005/0022); per-space marker signing and pack-shipped migrations are shipped PN machinery; `auth:User` FK falls out of PN ADR 226 |
| D4 | Shared-DB-with-FK is the golden path from v1; dedicated DB is the same mechanism with an empty app space | No PN work needed; the FK story is the headline capability |
| D5 | The db dep's schema assertion runs at **deploy time**: a preflight checks the wired resource's PN config lists the `auth` pack at the installed package's head hash, before the migration step | Boot-time is too late (service down after a green deploy); wiring-time reads a stale proxy artifact. `pnContract().satisfies` stays wireability-only for pack requirements |
| D6 | Sessions: stateless JWT by default (15-min TTL, EdDSA via JWKS); instant logout is an explicit per-call opt-in via the `session` rpc port | "No DB access" is the JWT binding's whole value; revocation is a per-route decision |
| D7 | Social OAuth is post-v1; the factory reserves an options-driven mechanism (per-provider secret slots + params) but v1 ships none | Zero-click-ops golden path; ADR-0029 has no optional secrets, so slots must be option-conditional |
| D8 | The Better Auth instance secret is a **minted resource** (`authSecret`), mirroring `s3Credentials`: minted once deploy-side, stable across deploys, wired as a dependency binding; not exposed to consumers in v1; rotation unsupported in v1 (documented) | Zero-click-ops; the target already owns this exact pattern; rotating would invalidate sessions + AES-encrypted jwks rows |
| D9 | Ports: `api` (kind `'auth-api'`, connection param `url` — kind-only satisfies, storage's `s3Contract` shape), `session` (rpc), `admin` (rpc); all three backed by one service; least-privilege enforced by wiring | Email's multi-port convention (send/outbox); rpc ports get ADR-0030 per-binding keys for free |
| D10 | The `api` surface is public and unauthenticated (it IS the authentication), rate-limited by Better Auth; `/rpc/*` on the same service stays bearer-checked | Login can't demand a bearer key |
| D11 | Browser golden path: the consumer app proxies `/api/auth/*` to the auth service via the shipped `authProxy()` helper; first-party httpOnly cookies; direct + bearer documented as the SPA alternative | Cross-origin cookies are the thing browsers keep breaking; redirect flows (magic link) land cleanly on the app origin |
| D12 | `session` and `admin` handlers are DB-direct (SQL against the auth schema through the service's own pool), not `auth.api.*` calls | Better Auth's admin plugin authorizes via admin *sessions*; our ports authorize via wiring (ADR-0030) — impersonating sessions to satisfy the plugin would be a hack |
| D13 | Mounted-in-app is a library export (`./embedded`) sharing `buildAuthOptions()` with the service — not a module mode | ADR-0016 excludes embedded modules; one options-builder keeps the two shapes behaviorally identical |
| D14 | Email touchpoints: auth declares its own `defineTemplates` set and an `email` boundary dep (`emailSender(authTemplates)`); one idempotency key per send-callback invocation, derived deterministically; links validated against the app origin and HTML-escaped | #146 contract as-is; closes both #146 review findings structurally |
| D15 | JWT verification in consumers is signature + `exp`/`nbf` only (30 s tolerance) in v1; `iss`/`aud` not validated (single-issuer wiring — the JWKS itself is per-instance) | The verifier only trusts keys fetched from the wired instance; issuer checks add cross-instance confusion protection only when instances share keys, which they never do |
| D16 | Local dev: `startLocalAuthServer()` (testing export) — real Better Auth + real handlers against a caller-supplied local Postgres URL, fixed dev secret, schema applied from the pack's committed `schema.sql`, email captured in memory by default | Same topology as production; no cloud credentials (DoD 5) |

## Better Auth version and plugins

- Dependency: `better-auth` pinned exact (no `^`) in `@internal/auth`'s
  `package.json`, latest stable at implementation time. Every schema artifact
  (§ Pack) is generated at that pin; bumping the pin requires regenerating
  and re-running the schema-conformance test.
- Plugins enabled (v1, both service and embedded): `jwt`, `bearer`, `admin`,
  `magicLink`. Core features: email+password, email verification.
- Explicitly not enabled in v1: social providers, organizations, twoFactor,
  passkey, username, phone, openAPI. The contract must not preclude them.

## Package layout

New workspace package `packages/1-prisma-cloud/2-shared-modules/auth`, name
`@internal/auth`, published as `@prisma/composer-prisma-cloud/auth`. Mirrors
`@internal/email` (same `package.json` shape, scripts, `@internal/tsdown-config`,
`type: module`, private; `exports: false` + hand-maintained map per
`exports-entrypoints.mdc` multi-pass exception, which must be extended to name
`auth`).

```
packages/1-prisma-cloud/2-shared-modules/auth/
├── package.json          # exports: . | ./auth-service | ./auth-entrypoint | ./pack | ./embedded | ./testing | ./package.json
├── README.md
├── tsdown.config.ts
├── tsconfig.json
└── src/
    ├── contract.ts             # authApiContract, authSessionContract, authAdminContract, record schemas, authApi(), jwtVerifier(), authDb()
    ├── auth-module.ts          # auth() module factory
    ├── auth-service.ts         # authService() compute definition + default bare node
    ├── auth-options.ts         # buildAuthOptions() — the ONE Better Auth config (service + embedded)
    ├── templates.ts            # authTemplates: defineTemplates({verification, passwordReset, magicLink}) + safeLink()
    ├── handlers.ts             # session + admin rpc handlers (DB-direct)
    ├── auth-store.ts           # AuthStore interface: the SQL behind handlers.ts + row↔record mapping
    ├── pg-auth-store.ts        # Postgres implementation (service + testing)
    ├── proxy.ts                # authProxy()
    ├── embedded.ts             # createEmbeddedAuth()
    ├── pack/
    │   ├── contract.prisma     # authored PSL, namespace auth (source of truth)
    │   ├── contract.json       # emitted (committed)
    │   ├── contract.d.ts       # emitted (committed)
    │   ├── schema.sql          # generated flat DDL (committed; used by testing export)
    │   ├── migrations/         # authored PN migration packages (committed; v1: 0001_init)
    │   └── index.ts            # authPack descriptor (SqlControlExtensionDescriptor<'postgres'>)
    ├── execution/
    │   ├── auth-entrypoint.ts  # boot program
    │   └── testing.ts          # startLocalAuthServer()
    ├── exports/
    │   ├── index.ts            # authoring barrel: contract.ts + auth-module.ts + templates.ts + proxy.ts
    │   ├── auth-service.ts     # re-exports default + authService
    │   ├── auth-entrypoint.ts  # import '../execution/auth-entrypoint.ts'
    │   ├── pack.ts             # re-exports authPack (default + named)
    │   ├── embedded.ts         # re-exports createEmbeddedAuth
    │   └── testing.ts
    └── __tests__/              # see Test plan
```

Planes (`architecture.config.json`, non-overlapping globs, email's pattern):
`src/*.ts` → shared; `src/pack/**` → shared (descriptor + JSON only — the
pack's `index.ts` must not import `@internal/lowering`/`effect`/PN control);
`src/execution/**` → execution; `src/exports/index.ts`, `src/exports/pack.ts`,
`src/exports/embedded.ts`, `src/exports/auth-service.ts` → shared (the
service shim is re-exported from the authoring barrel — email's exact
classification; amended 2026-07-23, D4); `src/exports/auth-entrypoint.ts`,
`src/exports/testing.ts` → execution.
`embedded.ts` is shared-plane: it imports `better-auth` (pure library) and
`auth-options.ts`, never the runtime engine. Runtime dependencies of the
authoring barrel must stay free of `node:`/`bun` tokens (invariant tests, § Test
plan).

Public re-export in `packages/9-public/composer-prisma-cloud`: add
`src/exports/auth.ts`, `auth-pack.ts`, `auth-embedded.ts`, `auth-testing.ts`
mirroring the email PR's `email.ts`/`email-testing.ts` pattern, plus
`package.json`/`tsdown.config.ts` entries.

## Contracts (`src/contract.ts`)

arktype throughout (never Zod). Dates cross the wire as ISO-8601 UTC strings
(email's convention).

```ts
export const userRecord = type({
  id: 'string',
  email: 'string',
  emailVerified: 'boolean',
  name: 'string | null',
  image: 'string | null',
  role: 'string | null',
  banned: 'boolean',
  banReason: 'string | null',
  banExpiresAt: 'string | null',
  createdAt: 'string',
  updatedAt: 'string',
});

export const sessionRecord = type({
  id: 'string',
  userId: 'string',
  expiresAt: 'string',
  ipAddress: 'string | null',
  userAgent: 'string | null',
  createdAt: 'string',
  updatedAt: 'string',
});
```

### Port `api` — kind `'auth-api'`

```ts
export interface AuthApiConfig { readonly url: string; }

export const authApiContract: Contract<'auth-api', AuthApiConfig> = Object.freeze({
  kind: 'auth-api',
  __cmp: { url: '' },
  satisfies: (required: Contract<'auth-api', unknown>) => required.kind === 'auth-api',
});
```

Kind-only satisfies; connection param `url` is the compute service's own
producer output, wired exactly as `streamsProviderContract`'s `url` is (the
implementer copies streams' serializer/stash path; no new lowering concept).

Two dependency factories over this kind:

```ts
/** Thin URL-anchored client for the public surface — what authProxy() consumes. */
export function authApi(): DependencyEnd<AuthApiClient, typeof authApiContract>;
export interface AuthApiClient {
  readonly url: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}
// connection params: { url: string() }; hydrate mirrors target http.ts's defaultHttpClient.

/** Stateless JWT verifier over the instance's JWKS. */
export function jwtVerifier(): DependencyEnd<JwtVerifier, typeof authApiContract>;
export interface VerifiedSession {
  readonly userId: string;      // `sub`
  readonly sessionId: string;   // `sid`
  readonly email: string;
  readonly emailVerified: boolean;
  readonly expiresAt: Date;     // `exp`
  readonly claims: Record<string, unknown>;  // full verified payload
}
export interface JwtVerifier {
  /** Resolves null for ANY invalid token (bad signature, expired, malformed) — never throws on token content. */
  verify(token: string): Promise<VerifiedSession | null>;
}
```

`jwtVerifier()` hydrate: `jose`'s `createRemoteJWKSet(new URL('/api/auth/jwks', url))`
+ `jwtVerify(token, jwks, { clockTolerance: 30 })`. No `iss`/`aud` options
(D15). jose caches the JWKS and refetches on unknown `kid` — no further
caching layer. Network/JWKS-fetch failures DO throw (they are operational
errors, not invalid tokens). `jose` is a runtime dependency of the authoring
barrel (pure ESM, no `node:` imports — keep it out of the engine-only deps).

### Port `session` — consumer-facing online checks

```ts
export const authSessionContract = contract({
  getSession: rpc({
    input: type({ token: 'string' }),
    output: type({ session: sessionRecord.or('null'), user: userRecord.or('null') }),
  }),
  getUser: rpc({
    input: type({ id: 'string' }),
    output: type({ user: userRecord.or('null') }),
  }),
});
```

Semantics (DB-direct, D12; exact SQL contracts in § Store):
- `getSession`: look up `auth.session` by `token`; if absent, or
  `expiresAt <= now()`, or the owning user is currently banned → both fields
  `null` (one shape, no error). Otherwise both records. This is the
  instant-logout path: a revoked session is a deleted row.
- `getUser`: by primary key; `null` when absent. (Placement on the consumer
  port settled: profile rendering off a JWT `sub` must not require admin
  wiring.)

### Port `admin` — tier-1 admin path

```ts
export const authAdminContract = contract({
  // named findUser, not getUser: rpc dispatch is flat (POST /rpc/<method>),
  // so method names must be unique ACROSS ports — amended 2026-07-23, D5
  findUser: rpc({
    input: type({ 'id?': 'string', 'email?': 'string' }),
    output: type({ user: userRecord.or('null') }),
  }),
  listUsers: rpc({
    input: type({ 'query?': 'string', 'banned?': 'boolean', 'cursor?': 'string',
                  'limit?': '1<=number.integer<=200' }),
    output: type({ users: userRecord.array(), 'nextCursor?': 'string' }),
  }),
  listSessions: rpc({
    input: type({ userId: 'string' }),
    output: type({ sessions: sessionRecord.array() }),
  }),
  revokeSession: rpc({
    input: type({ sessionId: 'string' }),
    output: type({ revoked: 'boolean' }),   // false = no such session (idempotent)
  }),
  revokeUserSessions: rpc({
    input: type({ userId: 'string' }),
    output: type({ revokedCount: 'number.integer' }),
  }),
  banUser: rpc({
    input: type({ userId: 'string', 'reason?': 'string', 'expiresAt?': 'string' }),
    output: type({ user: userRecord }),     // rejects (thrown → rpc error) when user absent
  }),
  unbanUser: rpc({
    input: type({ userId: 'string' }),
    output: type({ user: userRecord }),
  }),
});
```

Semantics:
- `findUser`: exactly one of `id`/`email` must be set — both or neither is a
  handler-thrown error (`auth admin findUser: pass exactly one of id, email`).
  Email match is case-insensitive equality on `lower(email)`.
- `listUsers`: filters AND-combine. `query` = `ILIKE '%'||query||'%'` against
  `email` OR `name` (query string escaped for `%_\`). `banned` filters on the
  effective-ban predicate (below). Order `createdAt DESC, id DESC`; keyset
  cursor = base64url of `${createdAt ISO}|${id}` (email outbox's codec
  pattern); default limit 50.
- Effective-ban predicate (used by `userRecord.banned`, `getSession`, and the
  `banned` filter): `banned = true AND (banExpiresAt IS NULL OR banExpiresAt > now())`.
- `revokeSession` / `revokeUserSessions`: `DELETE` of session rows; counts
  reported; idempotent.
- `banUser`: sets `banned=true, banReason=reason??null, banExpires=expiresAt??null`
  AND deletes all the user's sessions (ban implies revoke). `unbanUser` clears
  the three columns, revokes nothing.
- Deliberately absent v1: `createUser`, `deleteUser`, impersonation
  (design-notes § Deferred).

### Db dependency — `authDb()`

```ts
/** The auth service's claim on a PN-typed database that carries the auth pack. */
export function authDb(): DependencyEnd<{ url: string }, PnPostgresContract>;
```

Built with core `dependency()`: `type: 'prisma-next'`, connection params
`{ url: string() }`, hydrate identity (`({url}) => ({url})`) — Better Auth
builds its own pool; no PN client. Its `required` contract is
`pnPackRequirement({ packId: 'auth', headHash: AUTH_PACK_HEAD_HASH })` (§
Target changes), where `AUTH_PACK_HEAD_HASH` is imported from
`src/pack/index.ts` (the emitted contract's `storage.storageHash`).

## The Prisma Next extension pack (`src/pack/`)

- `contract.prisma`: PSL under `namespace auth` containing the Better Auth
  tables at the pinned version with plugins jwt+admin+magicLink+bearer:
  `user`, `session`, `account`, `verification`, `jwks` — column set exactly as
  `npx @better-auth/cli generate` emits for the § Better Auth config, with
  Better Auth's default (camelCase) column names, transcribed to PSL. Tables
  live in Postgres schema `auth` (PSL namespace → PG schema, as
  `resolveDdlSchemaForNamespaceStorage` maps it).
- Emitted `contract.json`/`contract.d.ts`: produced by PN's contract emit
  toolchain (same procedure as `@prisma-next/extension-supabase`'s
  `src/contract/`), committed. Control policy: **managed** (the default) —
  unlike Supabase's `external`, OUR migrations create these tables.
- `migrations/0001_init`: one authored PN migration package creating the five
  tables + indexes, authored with PN's migration tooling against the emitted
  contract; committed. `headRef = { hash: contract.storage.storageHash,
  invariants: [] }`.
- `schema.sql`: flat DDL equivalent of applying the pack's migration graph to
  an empty database, generated by a package script (`pnpm generate:schema` —
  runs PN `dbInit` in plan mode against the pack space and renders SQL),
  committed. Consumed ONLY by the testing export (D16).
- `index.ts`: exports `authPack` (`SqlControlExtensionDescriptor<'postgres'>`,
  `id: 'auth'`, `familyId: 'sql'`, `targetId: 'postgres'`, `version` from
  package.json, `contractSpace: { contractJson, headRef, migrations }` with
  migrations loaded as in-memory `DescriptorMigrationPackage[]`), plus
  `export const AUTH_PACK_ID = 'auth'` and
  `export const AUTH_PACK_HEAD_HASH: string`. Mirror
  `supabasePack`'s descriptor construction (including
  `assertDescriptorSelfConsistency`-equivalent hash check at load, and a
  `blindCast` with the same reason discipline).

Consumer usage (shared DB, the golden path):

```ts
// prisma-next.config.ts
import authPack from '@prisma/composer-prisma-cloud/auth/pack';
export default defineConfig({ ..., extensionPacks: [authPack] });
```

```prisma
// consumer contract.prisma
namespace public {
  model Profile {
    id     String @id
    userId String @unique
    user   auth:User @relation(fields: [userId], references: [id], onDelete: Cascade)
  }
}
```

Cross-space relations are non-navigable in the generated client (PN ADR 226);
the value is the real FK constraint. Dedicated-DB standalone: a PN project
whose app space is empty and whose config lists only `authPack` (the smoke
example, § Examples).

## Target changes (`packages/1-prisma-cloud/1-extensions/target`)

Four additions, no new machinery classes:

1. **`authSecret` resource** (new files `auth-secret.ts`,
   `auth-secret-resource.ts`): mirror `s3-credentials.ts` /
   `s3-credentials-resource.ts` exactly. Kind `'auth-secret'`, contract
   `authSecretContract: Contract<'auth-secret', { value: string }>`
   (kind-only satisfies); `authSecret({ name })` resource /
   `authSecret()` dependency → binding `{ value: string }`. Mint:
   `btoa(String.fromCharCode(...randomBytes(32)))` on first create;
   reconcile keeps existing output (stable across deploys). Registered in
   the same descriptor tables `s3Credentials` is.
2. **`pnPackRequirement`** (in `prisma-next.ts`):
   ```ts
   export interface PnPackRequirement { readonly packId: string; readonly headHash: string; }
   export function pnPackRequirement(req: PnPackRequirement): PnPostgresContract;
   ```
   Returns a `'prisma-next'`-kind contract whose `__cmp` is
   `{ packRequirement: req }`. `pnContract()`'s `satisfies` gains one branch
   BEFORE hash comparison: if `required.__cmp` carries `packRequirement`
   (checked defensively like `storageHashOf`), return `true` — wireability
   only; enforcement is the deploy preflight (D5).
3. **Pack preflight** (new function in `preflight.ts`, invoked from the
   deploy lowering beside the existing pn migration-step construction in
   `descriptors/prisma-next.ts`): for every dependency edge whose consumer
   `required.__cmp.packRequirement` is set and whose provider is a
   `PnPostgresResourceNode` — load the resource's PN config (the same c12
   load `resolveMigrationsDir` does), read `config.extensionPacks`. Fail the
   deploy with:
   - missing: `prisma-next database "<resource name>" does not list extension
     pack "<packId>" in its prisma-next.config.ts extensionPacks — service
     "<consumer>" requires it. Add the pack and run migration plan.`
   - hash mismatch: `extension pack "<packId>" in "<config path>" is at head
     <found>, but the installed package requires <required>. Re-run
     migration plan so the pack's shipped migrations are materialised, then
     redeploy.`
   A `packRequirement` edge wired to a non-`pnPostgres` provider fails:
   `service "<consumer>" requires extension pack "<packId>", which only a
   pnPostgres resource can carry.`
4. **Multi-space migrate passthrough** (`prisma-next-migrate.ts` +
   `pn-config.ts`): `loadConfig` already returns the config; surface
   `config.extensionPacks ?? []` alongside `resolveMigrationsDir` (new
   `resolvePnProject(configPath) → { migrationsDir, extensionPacks }`).
   Thread `extensionPacks` into `createPostgresControlClient({ connection,
   extensionPacks })` — client-creation options only; the client threads
   them into `dbInit`/`migrate` internally (amended 2026-07-22, D2: the
   per-call options do not accept them, the creation options do). Decision change in `applyPnMigration`: when
   `extensionPacks.length > 0` and `decideMigrationAction` returns `noop`
   for the app space, still call `client.migrate` (PN's per-space path
   resolution no-ops each up-to-date space); `noop` is returned to the
   lowering only when packs are absent. The PnMigration resource key
   (hash+invariants) must additionally fold in each pack's
   `contractSpace.headRef.hash` (sorted by pack id) so a pack upgrade
   produces a distinct deploy step.

## Module factory (`src/auth-module.ts`)

```ts
export function auth(opts?: { name?: string }): ModuleNode<
  { db: ReturnType<typeof authDb>; email: ReturnType<typeof emailSender<AuthTemplates>> },
  { api: typeof authApiContract; session: typeof authSessionContract; admin: typeof authAdminContract },
  Record<never, never>,                       // no secret slots in v1 (D8: minted resource)
  { baseUrl: ParamNeed }
>;
```

Body: `module(opts?.name ?? 'auth', { deps, params: { baseUrl: paramNeed() },
expose }, ({ inputs, params, provision }) => { ... })`:
- `provision(authSecret({ name: 'secret' }), { id: 'secret' })`
- `provision(authService(), { id: 'service', deps: { db: inputs.db,
  email: inputs.email, secret }, params: { baseUrl: params.baseUrl } })`
- returns `{ api: service.api, session: service.session, admin: service.admin }`.

The email boundary dep lands in slice S2 (§ Plan); the S1 factory shape omits
`email` and S2 adds it (pre-release breaking change, accepted). `baseUrl` is
the PUBLIC origin of the consumer app (scheme+host, no trailing slash, no
path) — the origin browsers see, links target, and `trustedOrigins` allows.
Root binds it `envParam('AUTH_BASE_URL')` (module-boundary params accept env
sources only — recorded gotcha).

## Service (`src/auth-service.ts`)

```ts
export function authService(): ServiceNode<...> {
  return compute({
    name: 'auth',
    deps: { db: authDb(), email: emailSender(authTemplates), secret: authSecret() },
    params: { baseUrl: param(type('string'), {}) },
    // no `port` param: `port` is compute()'s reserved service param
    // (platform-injected; declaring it throws) — amended 2026-07-23, D4
    build: node({ module: './execution/auth-service-node.mjs', entry: './auth-entrypoint.mjs' }),
    expose: { api: authApiContract, session: authSessionContract, admin: authAdminContract },
  });
}
export default authService();   // bare node, main.run() target (cron/storage pattern)
```

(Exact `build` paths follow email's tsdown multi-pass output naming;
implementer mirrors `emailService`'s literal values.)

## Better Auth configuration (`src/auth-options.ts`)

One builder, used by the entrypoint AND `createEmbeddedAuth` (D13):

```ts
export interface AuthOptionsInputs {
  readonly databaseUrl: string;
  readonly secret: string;
  readonly baseUrl: string;                       // public app origin (D11)
  readonly sendEmail: AuthEmailSender;            // § Templates; S1: absent (see below)
}
export function buildAuthOptions(inputs: AuthOptionsInputs): BetterAuthOptions;
```

Pinned option values:
- `baseURL: inputs.baseUrl`, `basePath: '/api/auth'`, `secret: inputs.secret`,
  `appName: 'auth'`.
- `trustedOrigins: [inputs.baseUrl]`.
- `database`: `pg.Pool` with `connectionString: databaseUrl`,
  `options: '-c search_path=auth'`, plus the target's connection hardening
  values (`connectionTimeoutMillis: 20_000`, `idleTimeoutMillis: 5_000`,
  pool `error` listener logging — copied semantics from
  `prisma-next.ts`'s `resilientPool`, reimplemented locally; the module may
  not import target internals).
- `emailAndPassword: { enabled: true, requireEmailVerification: <S2: true / S1: false>,
  sendResetPassword: <cb>, revokeSessionsOnPasswordReset: true }`.
- `emailVerification: { sendVerificationEmail: <cb>, sendOnSignUp: true,
  autoSignInAfterVerification: true }`.
- `session: { expiresIn: 60*60*24*7, updateAge: 60*60*24 }` (Better Auth
  defaults, stated explicitly so they are pinned).
- `rateLimit: { enabled: true }` (defaults otherwise).
- No `advanced.database.generateId` override (amended 2026-07-23, D5:
  `generateId: false` DISABLES generation at 1.6.24 and breaks signup;
  omitting it yields the intent — Better Auth's default generator, 32-char
  text ids, matching the pack's `text` columns; pinned by a unit test).
- Plugins, in order: `jwt({ jwt: { expirationTime: '15m' }, jwks: {} })`
  (EdDSA/Ed25519 default; `/api/auth/jwks` default path; default
  `definePayload: ({ user, session }) => ({ ...user, sid: session.id })` —
  the default full-user shape plus the one claim the verifier contract
  requires; 1.6.24's default payload carries NO session claim, so a plain
  default would make every token fail `sid` extraction (amended
  2026-07-23, D5)), `bearer()`, `admin()`, `magicLink({ sendMagicLink:
  <cb>, expiresIn: 300, disableSignUp: false })`.

S1 (pre-email): the three send callbacks log
`auth: email delivery not wired (slice S2): <purpose> for <email>` and
return; `requireEmailVerification: false`; `magicLink` plugin still enabled
(its sends no-op). S2 replaces the callbacks with real sends and flips
`requireEmailVerification: true`.

## Templates and email touchpoints (`src/templates.ts`, S2)

```ts
export const authTemplates = defineTemplates({
  verification:  { data: type({ url: 'string', appName: 'string' }), render: ... },
  passwordReset: { data: type({ url: 'string', appName: 'string' }), render: ... },
  magicLink:     { data: type({ url: 'string', appName: 'string' }), render: ... },
});
export type AuthTemplates = typeof authTemplates;
```

- Subjects (exact): `Verify your email address`, `Reset your password`,
  `Sign in to ${appName}`.
- Every render: interpolations pass through `escapeHtml()` (`& < > " '`);
  the link additionally passes `safeLink(url, baseUrl)` which parses with
  `new URL` and throws unless `url.origin === new URL(baseUrl).origin` —
  a thrown render is a failed send, surfaced by the email module's result.
  Bodies: minimal semantic HTML (one heading, one paragraph, one `<a>`),
  plus a plain-text part with the bare URL. No external assets.
- Send callbacks (in `auth-options.ts`): each Better Auth callback
  `({ user|email, url, token }) =>` calls the hydrated template method with
  `to: email`, `data: { url, appName: 'auth' }`, and
  `idempotencyKey: sha256hex(`${purpose}:${email}:${token}`)` — deterministic
  per invocation, reused by any retry, closing #146's auto-minted-key
  finding (D14). Callbacks do not await delivery beyond the send RPC itself;
  a `failed` result is logged, never thrown (Better Auth treats callback
  throws as request failures — a down mail path must not brick signup;
  the outbox row is the operational record).

## Entrypoint (`src/execution/auth-entrypoint.ts`)

Storage/email's pattern: build a bare node, `service.load()` →
`{ db: { url }, secret: { value }, email }`, `service.config()` →
`{ baseUrl, port }`. Then:

1. `const auth = betterAuth(buildAuthOptions({ databaseUrl, secret, baseUrl, sendEmail }))`.
2. `const store = createPgAuthStore(db.url)` (own pool, `search_path=auth`).
3. `const rpcHandler = serve(service, { session: { getSession, getUser },
   admin: { findUser, listUsers, listSessions, revokeSession,
   revokeUserSessions, banUser, unbanUser } })` (handlers from
   `handlers.ts`, closed over `store`). Framework prerequisite (amended
   2026-07-23, D5): `serve()`/`Handlers<S>` skip exposed contracts that are
   not rpc contracts — the `api` port is resource-kind and carries no
   handlers; a small change in `@internal/service-rpc`, correct for any
   service mixing a public port with rpc ports.
4. Fetch composition (exact routing):
   - `pathname === '/health'` → `200 {"ok":true}` (no auth — platform probe).
   - `pathname.startsWith('/api/auth')` → `auth.handler(request)` (public,
     D10).
   - `pathname.startsWith('/rpc/')` → `rpcHandler(request)` (ADR-0030
     bearer-checked inside `serve`).
   - otherwise → `404`.
5. Listen on `config.port`, host `0.0.0.0`, via the same server bootstrap
   email's entrypoint uses.

NO schema work at boot: the deploy migrated and marker-signed the auth space
before this process exists (D5). No env reads outside the framework accessors.

## Store (`src/auth-store.ts`, `src/pg-auth-store.ts`)

`AuthStore` interface with one method per port operation (names match the
contract ops), row↔record mapping in one place (`Date` → ISO string;
`banExpires` column → `banExpiresAt` field; effective-ban predicate applied
to `banned`). `createPgAuthStore(url)` implements it with parameterized SQL
against `auth.user` / `auth.session` (quoted identifiers — `user` is a
reserved word: `auth."user"`). No writes outside `session` deletes and the
ban columns. A `memory` variant is NOT needed (testing uses real Postgres,
D16).

## Proxy helper (`src/proxy.ts`)

```ts
/** Mount-anywhere forwarder for the public auth surface (D11). */
export function authProxy(api: { url: string }): (request: Request) => Promise<Response>;
```

Behavior (pinned):
- Forwards method, body (streamed, not buffered), and all request headers
  except `host`; sets `x-forwarded-host` to the incoming `host` and
  `x-forwarded-proto` to the incoming URL's scheme.
- Target URL: `new URL(pathname + search, api.url)` — the proxy does NOT
  rewrite paths; the app mounts it so that the incoming pathname already
  begins `/api/auth` (Better Auth's `basePath`).
- Returns the upstream response as-is (status, headers including
  `set-cookie`, body streamed). `redirect: 'manual'` on the upstream fetch so
  302s (magic-link verify → callbackURL) pass through to the browser.
- No retry, no timeout beyond the platform's; errors surface as 502 with body
  `auth proxy: upstream unreachable`.

Consumer wiring (README example, storefront example): a route handler for
`/api/auth/*` that calls `authProxy(deps.authApi)`.

## Embedded export (`src/embedded.ts`)

```ts
export interface EmbeddedAuthInputs {
  readonly databaseUrl: string;
  readonly secret: string;
  readonly baseUrl: string;
  readonly email: EmailSender<AuthTemplates>;   // S2; optional in S1 with the same no-op logging
}
export function createEmbeddedAuth(inputs: EmbeddedAuthInputs): ReturnType<typeof betterAuth>;
```

Exactly `betterAuth(buildAuthOptions(...))` — nothing else. The consumer
mounts `auth.handler` on their own `/api/auth/*` route and may use
`auth.api.*` in-process. Schema: the consumer lists `authPack` in their own
PN config (same pack, same migrations — embedded changes WHERE the library
runs, not who owns the schema). README documents this as the
fully-idiomatic mode and its trade-off (no service boundary, no rpc ports).

## Testing export (`src/execution/testing.ts`)

```ts
export interface LocalAuthServer {
  readonly url: string;                    // http://127.0.0.1:<port>
  readonly capturedEmails: readonly CapturedAuthEmail[];  // append-only
  stop(): Promise<void>;
}
export interface CapturedAuthEmail {
  readonly template: keyof AuthTemplates; readonly to: string;
  readonly url: string;                    // the live link (verification/reset/magic)
}
export function startLocalAuthServer(opts: {
  databaseUrl: string;                     // caller-supplied local Postgres (prisma dev)
  port?: number;                           // default 0 = ephemeral
  baseUrl?: string;                        // default the server's own URL
  email?: AuthEmailSender;                 // default: capture into capturedEmails
}): Promise<LocalAuthServer>;
```

Boot: apply `pack/schema.sql` idempotently (`CREATE SCHEMA IF NOT EXISTS auth`
+ statements guarded the same way — the generation script emits IF NOT EXISTS
forms), fixed secret `'auth-local-dev-secret-not-for-production!'`, then the
SAME entrypoint composition (Better Auth handler + rpc handler with serve's
no-keys pass-through, email's local-server precedent). An e2e test signs up,
reads the link from `capturedEmails` (or, wired to the email module's local
server, from its outbox port), completes the flow — no cloud credentials.

## Examples

### `examples/auth` (S1) — smoke harness, dedicated DB

Root `module.ts`: `pnPostgres({ name: 'database', contract: <empty-app-space
emitted contract>, config: './prisma-next.config.ts' })` with
`extensionPacks: [authPack]`; `provision(auth(), { deps: { db }, params:
{ baseUrl: envParam('AUTH_BASE_URL') } })`; an `api` compute service with
`deps: { authApi: authApi(), verifier: jwtVerifier(), session:
rpc(authSessionContract) }` mounting `authProxy` at `/api/auth/*` and a
`/me` route that JWT-verifies `Authorization: Bearer`. `scripts/smoke.ts`
drives: signup (email+password) → login → `/api/auth/token` → verified
`/me` → `session.getSession` → `revokeUserSessions` (admin port wired to a
second `ops` service) → `getSession` now null. Deploys with creds from the
gitignored root `.env` (streams/email pattern), plus `tests/` integration
against `startLocalAuthServer`.

### `examples/storefront-auth` rework (S3) — the real consumer, shared DB

Replace the toy `modules/auth` with this module. One shared `pnPostgres`
database: app space = storefront's contract (gains
`Profile.userId → auth:User @relation(..., onDelete: Cascade)`),
`extensionPacks: [authPack]`. Storefront service proxies `/api/auth/*`,
renders signup/login/profile pages, verifies JWTs on API routes; a second
service (`fulfillment`) proves the cross-service JWT hop. e2e
(`scripts/e2e-verify.sh` + integration tests): signup → verification email
via the email module (local: outbox readback; deployed: `deliveryMode`
per stage) → login → magic-link login → JWT-verified request to
`fulfillment` → logout (`revokeUserSessions`) → `getSession` null → FK
proven by inserting a `Profile` row for the user and failing for a
random uuid. This example satisfies DoD items 3 and 4.

## README (package root; pinned section list)

Contract scope (three ports + verifier, what each is for, least-privilege
wiring) · Golden-path wiring (root module + proxy + verifier, complete
copy-paste) · The pack (extensionPacks, `auth:User` FK, migration flow,
upgrade procedure: bump package → `migration plan` → deploy) · Sessions & JWTs
(claims, TTL, revocation trade-off, D15 caveat) · Local dev
(`startLocalAuthServer`, prisma dev, reading links from capture/outbox) ·
Embedded mode (when and trade-offs) · The SPA alternative (bearer, direct
origin, its costs) · Limits (no social/orgs/2FA in v1, no rotation, no
deleteUser, 1 MiB rpc body cap).

## Test plan

Type-level (`*.test-d.ts`): factory shapes (`auth()` deps/expose/params),
`jwtVerifier`/`authApi` binding types, contract record types, embedded input
types. Unit: templates (escaping, `safeLink` origin rejection, subjects),
cursor codec, effective-ban predicate, idempotency-key derivation
(deterministic, distinct per purpose/token), proxy behavior (headers,
streaming, redirect passthrough, 502) against a stub upstream, option-builder
pinned values (snapshot of `buildAuthOptions` output shape). Integration
(local Postgres, `pg-harness` pattern): store SQL per op; full local server —
signup/login/JWT verify with real `jose`; bearer + cookie flows; magic-link
e2e via capture; S2: against the email module's local server reading the
outbox; embedded-vs-service parity (same flows through `createEmbeddedAuth`).
Schema conformance: migrate a scratch DB with the pack (PN control client),
run Better Auth's schema generation against it, assert zero pending
changes; also assert `schema.sql` equals regenerated output. Target unit
tests: `pnPackRequirement` satisfies branch, preflight failure messages,
`resolvePnProject`, migration-resource key folds pack hashes, authSecret
mint/stability (s3-credentials' test pattern). Invariants: authoring barrel
carries no `node:`/`bun`/`effect` tokens (email's invariant test extended);
depcruise planes clean. Deployed smoke: `examples/auth` (S1),
`examples/storefront-auth` (S3), streams' conformance-style split.

## Non-goals (v1)

Social OAuth (mechanism D7 reserved; no providers ship) · organizations /
2FA / passkeys / username / phone · secret rotation · `deleteUser` /
impersonation · admin web UI (tier 2+; the `admin` port is tier 1) ·
per-consumer contract slices on shared DBs · exposing the instance secret ·
`iss`/`aud` validation (D15) · custom JWT claims configuration.

## Project DoD

1. Design doc + contract committed alongside the module (this spec migrates
   to the package/docs at close-out).
2. `examples/auth` deploys to real Prisma Cloud via the framework and its
   smoke script passes.
3. `examples/storefront-auth` proves the full loop: signup → verification
   email via the email module → login → JWT-verified request to a second
   service → logout.
4. Magic-link login works end to end (local and deployed).
5. The same module runs locally via `prisma dev` with no cloud credentials.
6. README covers contract scope, wiring, local dev.
7. All lint/layering checks pass (`depcruise`, casts, rules symlinks).

## Open questions

1. **Consume `@prisma-next/extension-better-auth` instead of authoring our
   own pack?** Discovered at planning time (2026-07-22): Linear project
   "BetterAuth Extension" (Terminal, lead Serhii Tatarintsev, in progress
   since 2026-07-13) is building exactly the § Pack artifact in prisma-next
   itself — `spaceId: 'better-auth'`, managed control, BetterAuth core
   models (`user`, `session`, `account`, `verification`), plus a BetterAuth
   **database adapter** over contract-typed `sql-orm-client` collections.
   If it ships in time and covers our plugin schema (the `jwt` plugin's
   `jwks` table; the `admin` plugin's user/session columns), S1 should
   consume it: § Pack collapses to a dependency, the FK ref becomes
   `better-auth:User`, `authDb()`'s requirement pins `packId:
   'better-auth'`, and `buildAuthOptions` uses their adapter instead of a
   raw `pg.Pool` + `search_path`. Needs: Will's call + coordination with
   Serhii on plugin-schema coverage and timeline. Fallback: author our own
   pack as specced (rename consideration: avoid colliding with theirs).
   **Interim decision (orchestrator, 2026-07-22, after operator said
   proceed):** S1 authors our own pack (the fallback) — the extension
   branch (`tml-2994-better-auth-extension`) is unmerged, covers only the
   four core models in the `public` namespace, and lacks the `jwks` table
   and admin columns our plugins require; blocking S1 on it is
   unacceptable coupling. Mitigations: pack id + head hash live in one
   constants file, the store schema-qualifies through one `AUTH_SCHEMA`
   constant, and DB access stays behind `buildAuthOptions` — adopting the
   extension later is a contained swap. Upstream ask (plugin schema
   coverage) filed on the "BetterAuth Extension" Linear project. Revisit
   at S3 pickup.

Genuine gaps found during implementation are recorded here and asked — not
improvised.

## References

- `design-notes.md` (alternatives + reasoning), `plan.md` (slices).
- Email module: PR #146 (`.drive/projects/email-module/spec.md` on that
  branch); conventions inherited: multi-port module, ISO dates, cursor
  codec, testing-export shape, exports discipline.
- Prior art: `packages/1-prisma-cloud/2-shared-modules/{storage,streams,cron}`;
  target patterns: `s3-credentials*.ts`, `streams-keys.ts`,
  `prisma-next{,-migrate}.ts`, `http.ts`.
- Prisma Next (worktree `./prisma-next`): pack descriptor
  `packages/3-extensions/supabase/src/pack/index.ts`; per-space runner
  `packages/3-targets/3-targets/postgres/src/core/migrations/runner.ts`;
  seed phase `packages/1-framework/3-tooling/cli/src/utils/contract-space-seed-phase.ts`;
  multi-space ops `.../cli/src/control-api/operations/{migrate,db-init}.ts`;
  ADR 226 (cross-contract FKs), ADR 212 (contract spaces).
- Composer ADRs: 0005, 0013, 0015, 0016, 0022, 0029, 0030, 0031, 0032.
- Better Auth docs (pinned version): plugins jwt / bearer / admin /
  magic-link; email-password verification & reset callbacks.

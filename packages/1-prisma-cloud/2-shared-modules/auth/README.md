# @internal/auth

Signup, login, sessions, and JWT verification as a composed module wrapping
[Better Auth](https://better-auth.com) (in-process TypeScript library — not a
remote IdP), published as `@prisma/composer-prisma-cloud/auth`. One dedicated
Compute service; the schema ships as a Prisma ORM extension pack; the
instance secret is platform-minted.

## Contract scope

Three ports, one service behind them — least privilege is a WIRING choice:

- **`api`** (kind `'auth-api'`) — the public Better Auth surface
  (`/api/auth/*`): signup, login, logout, self-service account deletion,
  JWKS, token minting. Publicly reachable, with no service key (unlike the
  rpc ports) — it IS the authentication: Better Auth authenticates each
  request itself (logout and account deletion need a signed-in session)
  and rate limits it. Two consumer factories bind to it:
  - `authApi()` → `{ url, fetch }` — what `authProxy()` consumes.
  - `jwtVerifier()` → `verify(token)` — stateless JWT verification over the
    instance's JWKS (jose remote JWKS, 30 s clock tolerance). Resolves
    `null` for ANY invalid token content; throws only on operational
    errors (JWKS unreachable). No DB access — that is its whole value.
- **`session`** (rpc) — consumer-facing online checks: `getSession(token)`
  (null for unknown/expired/banned-owner — one shape, no error; a revoked
  session is a deleted row, so this is the instant-logout read) and
  `getUser(id)` (profile rendering off a JWT `sub` without admin wiring).
- **`admin`** (rpc) — the tier-1 admin path: `findUser` (exactly one of
  id/email; email match case-insensitive), `listUsers` (query/banned
  filters, keyset cursor), `listSessions`, `revokeSession`,
  `revokeUserSessions` (idempotent deletes), `banUser` (ban implies
  revoke, atomically), `unbanUser`, `createUser` (see Provisioning
  accounts below), `setEmailVerified`, `removeUser` (see Deleting
  accounts below).

Wire each port only where it belongs: the app gets `api` + `session`; the
back office alone gets `admin`.

`/api/auth/*` is the browser surface. Better Auth origin-checks any request
that looks like it came from a browser — one carrying a cookie, an
`Origin`/`Referer`, or any `Sec-Fetch-*` header — and refuses a missing
`Origin` with `403 MISSING_OR_NULL_ORIGIN`. Node's built-in `fetch` sends
`Sec-Fetch-Mode` on every request, so a Node script calling `/api/auth/*`
(directly or through `authProxy`) is refused unless it sends an `Origin`
that is in `trustedOrigins` (the module's `baseUrl`). Server-to-server work
belongs on the rpc ports instead.

## Golden-path wiring

```ts
// module.ts (the root)
import { module } from '@prisma/composer';
import { envParam } from '@prisma/composer-prisma-cloud';
import { auth } from '@prisma/composer-prisma-cloud/auth';
import { postgres } from '@prisma/composer-prisma-cloud/orm';
import { appContract } from './src/contract.ts';
import apiService from './src/api/service.ts';

export default module('app', ({ provision }) => {
  const db = provision(
    postgres({ name: 'database', contract: appContract, config: './prisma.config.ts' }),
    { id: 'database' },
  );
  const identity = provision(auth(), {
    id: 'auth',
    deps: { db },
    params: { baseUrl: envParam('AUTH_BASE_URL') }, // the PUBLIC app origin
  });
  provision(apiService, {
    id: 'api',
    deps: { authApi: identity.api, verifier: identity.api, session: identity.session },
  });
});
```

```ts
// in the app service: first-party cookies via the proxy (the browser golden path)
import { authProxy } from '@prisma/composer-prisma-cloud/auth';

const { authApi, verifier } = service.load();
const proxy = authProxy(authApi);
// route /api/auth/* → proxy(request); verify API calls with verifier.verify(<bearer>)
```

The database is a BOUNDARY dependency: the root decides dedicated vs shared.
`baseUrl` is the public origin browsers see (scheme+host, no trailing slash,
no path) — bind it with `envParam('AUTH_BASE_URL')`. The instance secret is
platform-minted inside the module; rotation is unsupported in v1 (rotating
would invalidate every session and the encrypted jwks rows).

A complete, deployable copy of this wiring lives in `examples/auth`.

## Provisioning accounts

An account an operator creates goes through the `admin` port, server to
server — never through the browser sign-up surface:

```ts
// in a service wired to `identity.admin`
const { admin } = service.load();
const { user } = await admin.createUser({
  email: 'ops@example.com',
  name: 'Ops',
  password: 'a-long-passphrase',   // optional; omit for a magic-link-only account
  emailVerified: true,             // optional; default false
});
```

`createUser` writes exactly what Better Auth's own sign-up writes — the
`user` row and, with a password, a `credential` account hashed by Better
Auth's own hasher — and sends no mail. The contract input applies the same
checks sign-up does (a well-formed email, a password of 8–128 characters),
so a caller mistake is a 400 at the rpc boundary; a duplicate email
(case-insensitive) is refused by the handler. Every refusal reaches a typed
rpc client as a thrown error, so a script cannot mistake it for success. `setEmailVerified({ userId, emailVerified })` flips
the flag a created account needs before `requireEmailVerification` lets it
sign in (`user: null` for an unknown id).

A deployed stack's rpc ports are reachable only by consumers in its graph:
a script on a laptop cannot call `admin.createUser`. The application
exposes its own operator route (allowlisted however it sees fit) from a
service wired to `admin`, and that route makes the call.

Invite-only applications close self-service sign-up with a module setting,
enforced by Better Auth itself, instead of filtering their proxy:

```ts
provision(auth({ signUp: 'closed' }), { id: 'auth', deps: { db, email: mail.send }, params: { … } });
```

`signUp: 'closed'` sets `emailAndPassword.disableSignUp` and the magic-link
plugin's `disableSignUp`: `/api/auth/sign-up/email` answers `400
EMAIL_PASSWORD_SIGN_UP_DISABLED`, and a magic link requested for an unknown
email is still sent but completes to an `error=new_user_signup_disabled`
redirect with no user created. Sign-in for existing accounts is unchanged.
Default `'open'`. Nothing about origin, CSRF, or `trustedOrigins` changes
either way.

## Deleting accounts

Two paths: users delete themselves through Better Auth's own endpoint;
operators delete through this module's `admin` port (a database-direct
rpc, not Better Auth's admin-session API).

**A user deletes their own account** ("delete my account") through
Better Auth's `POST /api/auth/delete-user` — on by default, reached through
`authProxy()` like the rest of `/api/auth/*`, no extra wiring:

```ts
// browser, signed in (cookie through the proxy); or `Authorization: Bearer <session token>`
await fetch('/api/auth/delete-user', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password }), // optional when the session is < 24 h old
});
```

It needs a signed-in session (`401` otherwise) and deletes only that
session's user — there is no `userId` parameter. It also demands either the
current `password` (`400 INVALID_PASSWORD` when wrong) or a session younger
than 24 hours (`400 SESSION_EXPIRED` otherwise — sign in again; magic-link
users have no password, so this is their path). It deletes the user row,
its sessions, and its accounts, and clears the session cookie.

**An operator deletes an account** (an erasure request by email, support
tooling, or when your app must clean up before the sign-in record goes)
with one `admin` call, server to server:

```ts
// in a service wired to `identity.admin`
const { removed } = await admin.removeUser({ userId });
```

It deletes the `user` row (email, name, timestamps); its sessions and
accounts (password hash, provider tokens) go with it. `removed: false`
means no such user, so a retried deletion flow is not an error. No mail is
sent.

Neither path touches pending verification tokens (an unused magic link or
password reset). They are short-lived — 5 minutes and 1 hour — and Better
Auth deletes every expired one whenever it next checks a token; a leftover
one cannot sign anyone into the deleted account.

**Either way, your own rows follow your own foreign keys** onto
`auth:User`: `onDelete: Cascade` deletes them with the user — what you want
for self-service deletion, since your app runs no code in between; one with
`Restrict` refuses the deletion and removes nothing; without an FK,
nothing links them — delete them yourself, in your own flow, before
calling `removeUser`. Data outside the database
(uploaded files, other stores) is yours to clean up, so route that
deletion through your own service and `removeUser`.

Already-minted JWTs keep verifying until they expire (≤ 15 min, see
Sessions & JWTs) — a route that must refuse a deleted user at once checks
`session.getSession(token)`, which is `null` immediately.

## The pack

Better Auth's tables (`user`, `session`, `account`, `verification`, `jwks` —
Postgres schema `auth`) ship as a Prisma ORM extension pack with authored
migrations — Better Auth's own migrator never runs anywhere. Consumers:

```ts
// prisma.config.ts
import authPack from '@prisma/composer-prisma-cloud/auth/pack';
export default defineConfig({ ..., extensions: [authPack] });
```

Run `prisma migration plan` once — it materialises the pack's shipped
migrations into `migrations/auth/` — and deploy: the ONE migration step
creates and evolves the auth tables beside your own, marker-signed per
space. On a shared database your own contract can FK `auth:User`
(cross-space relations are non-navigable in the generated client; the value
is the real constraint):

```prisma
model Profile {
  id     String @id
  userId String @unique
  user   auth:User @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

Upgrade procedure: bump this package → `prisma migration plan` (the new
shipped migrations materialise) → deploy. The deploy preflight fails loudly
when a wired database's config is missing the pack or is at a stale head.

## Sessions & JWTs

Stateless JWTs by default: 15-minute TTL, EdDSA via the instance's JWKS at
`/api/auth/jwks`. Verified claims: `sub` (userId), `sid` (sessionId),
`email`, `emailVerified`, `exp`. Cookie sessions last 7 days (rolling,
refreshed daily).

The trade-off is explicit: a revoked/banned session's already-minted JWTs
keep verifying until they expire (≤ 15 min). A route that needs instant
logout opts in per call with `session.getSession(token)` — a revoked
session is a deleted row. `iss`/`aud` are not validated in v1: the verifier
only trusts keys fetched from the wired instance, and instances never share
keys.

## Local dev

```ts
import { startLocalAuthServer } from '@prisma/composer-prisma-cloud/auth/testing';

const server = await startLocalAuthServer({ databaseUrl }); // e.g. `prisma dev`
// server.url            → real Better Auth + the real port handlers
// server.capturedEmails → { template, to, url } per send — read your
//                          verification / magic links straight from here
```

Real Better Auth, the real handlers, the same fetch topology as production;
the pack's schema applies idempotently at boot; a fixed dev secret; rpc runs
keyless. No cloud credentials anywhere.

## Email flows

Verification, password reset, and magic-link emails deliver through the
[email module](../email/README.md), wired as a boundary dependency:

```ts
const mail = provision(email(), { id: 'mail', params: /* … */, secrets: /* … */ });
const identity = provision(auth(), {
  id: 'auth',
  deps: { db, email: mail.send },
  params: { baseUrl: envParam('AUTH_BASE_URL') },
});
```

Signup requires verification (`requireEmailVerification: true`; the
verification send fires on signup, and verifying auto-signs-in; an
`admin.createUser` account skips the mail and is verified when created
with `emailVerified: true`). Magic links expire after 5 minutes. The three templates ship with the module —
minimal semantic HTML plus a plain-text part; every interpolation is
HTML-escaped, and a link whose origin differs from `baseUrl` fails the
send rather than going out.

Delivery is fire-and-forget from auth's perspective: a failed send is
logged, never thrown (a down mail path must not brick signup), and each
send carries a deterministic idempotency key, so Better Auth retries
can't double-deliver. The email module's outbox is the operational
record — read delivery state back through its `outbox` port.

Locally, `startLocalAuthServer` captures sends in `capturedEmails` by
default, or accepts an `email` sender hydrated against the email module's
own local server so the outbox-readback path is the one production uses.
`examples/auth` runs the full loop both ways: signup → verification link
read back from the outbox → verify → login → magic link.

## Embedded mode

Arrives with slice S4: `createEmbeddedAuth()` (`./embedded`) — the same
`buildAuthOptions()` mounted in your own service, for the fully-in-process
shape.

## The SPA alternative

Documented fully in S2 alongside the browser flows: talk to the `api` port's
origin directly with `Authorization: Bearer` (the bearer plugin is enabled),
at the cost of the first-party-cookie golden path.

## Limits (v1)

No social providers (mechanism reserved, none ship) · no organizations /
2FA / passkeys / username / phone · no secret rotation · no impersonation · admin web UI is tier 2+ (the `admin` port is tier 1) ·
rpc bodies cap at 1 MiB.

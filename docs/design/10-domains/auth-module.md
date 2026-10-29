# The `auth` module — why it is shaped the way it is

The `auth` module (`packages/1-prisma-cloud/2-shared-modules/auth`) provides
signup, login, sessions and JWT verification by hosting
[Better Auth](https://www.better-auth.com/) in a Compute service. It exposes a
public HTTP surface (`api`) and two rpc interfaces (`session` and `admin`), plus a
stateless `jwtVerifier()` dependency.

How to use it is in the package
[README](../../../packages/1-prisma-cloud/2-shared-modules/auth/README.md).
This note records why the main decisions went the way they did, and what was
rejected.

## The schema ships as a Prisma ORM extension pack

Better Auth owns its Postgres tables. Consumers need real foreign keys to the
auth user table, and the framework must be able to check the schema is there.

The auth package ships a Prisma ORM extension pack (`id: 'auth'`) with the
Better Auth schema contract and authored migrations. The consumer lists it in
`extensionPacks` in their `prisma.config.ts`. The deploy's one migration step
then brings every contract space in the database to its head, the database
records one marker row per space, and consumer models get a foreign key to
`auth:User` through Prisma ORM's cross-contract relations. A dedicated auth
database is the same mechanism with an empty app space; it is not a separate
mode.

Rejected:

- **Run Better Auth's own migrator at boot against a plain Postgres
  dependency.** Nothing the framework can see would assert the schema, boot-time
  DDL from a third-party migration engine is the kind of nondeterministic
  change the framework avoids, and consumers would get no foreign keys.
- **A dedicated Postgres contract per mode** (exact match first, "slice
  satisfaction" later). This assumed Prisma ORM could not hold several
  contracts in one database. It can: contract spaces, pack-shipped migrations
  and per-space markers are all shipped Prisma ORM features.

## The schema check runs at deploy time

The `db` dependency carries a requirement: the `auth` pack at the installed
package's head hash. A deploy preflight checks that the wired database's
Prisma ORM config lists the pack at that hash, before the migration step runs
(`runPackPreflight` in `target/src/preflight.ts`). Wiring-time contract
matching (`dataContract().satisfies`) deliberately says yes to any pack
requirement.

Rejected:

- **At wiring time**, by reading the emitted contract's `extensionPacks`. The
  emitted contract is a derived file that can lag both the installed package
  and the live database.
- **At boot**, by reading the auth space's marker row. A green deploy followed
  by a service that refuses to start is the worst failure shape; boot is too
  late.

## Browsers go through a proxy on the app's origin

The consumer app forwards `/api/auth/*` to the auth service with the shipped
one-line `authProxy()` helper. Browsers get first-party httpOnly cookies,
there is no CORS setup, and magic-link URLs land on the app's own origin.

Rejected as the default: browsers talking to the auth service's origin
directly. Cross-origin cookies are what browsers keep breaking. The workable
variant, a bearer token in JavaScript-readable storage, is a worse security
default (an XSS bug becomes session theft), and redirect flows such as magic
links then land on the auth origin. The direct-with-bearer shape stays
documented as the alternative for single-page and mobile apps; the bearer
plugin is enabled either way.

Better Auth's own examples assume it runs inside the app. With the proxy, the
browser-facing side is unchanged: same paths, same `createAuthClient`, and
any UI kit works. What changes is in-process `auth.api.*` calls; their
replacement is JWKS verification plus rpc, which is Better Auth's own
documented multi-service pattern.

## Embedded use is a plain library export, not a module

A module has the same boundary as a service and is not something you embed in
your process
([ADR-0016](../90-decisions/ADR-0016-a-module-has-the-same-boundary-as-a-service.md)).
So running Better Auth inside the consumer's own service is designed as a
plain library export (`./embedded`) that shares `buildAuthOptions()` with the
service, which keeps the two shapes behaving the same. It is not a module and
exposes nothing. The consumer lists the same pack in their own config.

This export has not shipped yet; see [`.drive/deferred.md`](../../../.drive/deferred.md).

## Sessions are stateless JWTs with opt-in revocation

By default a consumer verifies a 15-minute EdDSA JWT against the instance's
JWKS, with no database access. A route that needs instant logout calls
`session.getSession` over rpc, which reads the session row; a revoked session
is a deleted row.

Rejected: checking revocation on every request (it removes the reason to use
a JWT) and longer token lifetimes (they widen the window after logout for no
consumer benefit).

Verification checks signature and `exp`/`nbf` only, not `iss`/`aud`. The
verifier only trusts keys fetched from the instance it is wired to, and
instances never share keys.

## The session and admin interfaces query the database directly

The `session` and `admin` handlers read and write the auth tables with SQL,
instead of calling Better Auth's admin plugin. The plugin authorizes by an
admin's session; these ports are authorized by wiring, through the per-binding
service key
([ADR-0030](../90-decisions/ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md)).
Faking an admin session on the server to satisfy the plugin would be a hack.
Where a handler writes what Better Auth would write (for example
`admin.createUser`), it uses Better Auth's own hasher and id generator.

## Admin-port conventions

These came from the auth and email modules and should carry over to other
modules' admin interfaces:

- **Method names are unique across a service's exposed interfaces.** rpc dispatch is flat
  (`POST /rpc/<method>`), so `session.getUser` and `admin.getUser` would
  collide when `serve()` is constructed. The admin lookup is called `findUser`
  for this reason.
- **Pagination**: keyset cursor (an opaque base64url string of the sort key),
  `limit` from 1 to 200 with a default of 50, newest first, and filters that
  combine with AND.
- **Split consumer reads from operator actions.** Auth puts runtime checks on
  `session` and operator actions on `admin`. Email has one `outbox` port that
  only reads; auth's `admin` port also changes state (ban, revoke, create,
  remove).

## An rpc port should be mounted only if something is wired to it

The settled direction, not yet built: a service's rpc port exists on the
network only when at least one consumer is wired to it, and it accepts exactly
the keys of those wired edges. An unwired admin port would be absent, not
merely protected by a 401. Exposing a surface publicly, outside the topology,
would become its own explicit binding supplied by the root module.

Rejected: keeping one flat listener and partitioning keys per port. That
hardens the listener but keeps every port reachable by default.

Today `serve()` mounts every rpc port on one flat listener, with one accepted
key set for the whole service. The platform gives each Compute version one
port and one public URL, so the first version of this model would be
per-port path prefixes on that listener. See the wired-egress entry in
[`.drive/deferred.md`](../../../.drive/deferred.md).

## Not in v1

Social OAuth (option-driven per-provider secret slots are reserved, no
providers ship), organizations, 2FA, passkeys, username and phone login,
rotating the instance secret (it would invalidate every session and the
encrypted JWKS keys), impersonation, exposing the instance secret to
consumers, an admin web UI, and least-privilege contract slices for consumers
sharing one database.

## Related

- [`email-module.md`](email-module.md) — auth sends verification, reset and
  magic-link emails through it with its own templates.
- [ADR-0022](../90-decisions/ADR-0022-data-deps-carry-a-prisma-orm-contract.md)
  — data dependencies carry a Prisma ORM contract.

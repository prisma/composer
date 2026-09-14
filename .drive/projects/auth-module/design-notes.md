# Auth module — design notes

> Record of the design discussion (Will + agent, 2026-07-22) behind
> `spec.md`. The spec states what to build; this file records what was
> considered and why the losers lost. Nothing here is normative — if this
> file and `spec.md` disagree, the spec wins.

## The schema-ownership conflict, and how it resolved

The central design problem: the module owns Better Auth's Postgres tables,
consumers need real FKs to `auth.user.id`, and the framework must be able to
assert the schema is present.

- **Bare `rawPostgres()` dep + Better Auth's own migrator at boot** — rejected.
  Nothing the framework can see asserts the schema; boot-time DDL from a
  third-party migration engine is exactly the nondeterministic mutation the
  principles forbid. Also loses the FK story entirely.
- **A dedicated postgres contract per mode (exact-match v1, "slice
  satisfaction" milestone 2)** — collapsed. The two-milestone split assumed
  Prisma ORM lacked multi-contract-per-database. It doesn't: contract
  spaces are fully shipped — extension packs ship `contractSpace =
  { contractJson, headRef, migrations }`, the CLI seed phase materialises
  pack-shipped migrations, `planAllSpaces`/`executePerSpace` plan and apply
  per space, and `prisma_contract.marker` keys one row per space (each space
  signs the DB with its own hash). The Supabase pack ships zero migrations
  only because GoTrue owns its tables; the machinery is generic.
- **Winner: the auth package ships a Prisma ORM extension pack**
  (`id: 'auth'`) carrying the Better Auth schema contract and authored
  migration packages. The consumer lists it in `extensionPacks`; one deploy
  migration step brings every space to head; `auth:User` FKs come from
  prisma/orm ADR 226 unchanged. Dedicated-DB standalone use is the same
  mechanism with an empty app space, not a separate mode.

## Where the "does this DB carry the auth schema?" check runs

- **Wiring-time (`satisfies` reads the emitted contract's `extensionPacks`)**
  — rejected as the primary check: the emitted contract is a proxy artifact
  that can lag both the installed package and the live database.
- **Boot-time (service reads the `auth` space's marker row)** — rejected:
  a deploy that succeeds and then yields a service that refuses to boot is
  the worst failure shape (Will: "boot time is already too late").
- **Winner: deploy-time preflight.** The db dependency carries a pack
  requirement (`packId` + head hash from the installed package); the deploy
  lowering checks the wired resource's Prisma ORM config lists the pack at that
  hash before the migration step runs, and the same deploy then migrates
  the auth space and signs the marker. `dataContract().satisfies` stays
  wireability-only for pack requirements.

## Instance secret

- **ADR-0029 `envSecret`** — rejected as default: pure ceremony; breaks
  zero-click-ops for a value with no external meaning.
- **ADR-0031 provisioning need (streams-key pattern)** — rejected on
  grounding: needs mint per consumer edge; a provider-own unconditional
  mint would require extending the provisioned-edges machinery.
- **Winner: a minted resource, mirroring `s3Credentials`** — the target
  already has the exact pattern (mint once in deploy state, stable across
  deploys via reconcile-keeps-output, wired as a dependency binding). No
  new machinery class. Settled with Will: "start with platform-minted and
  expose it to the consuming application if necessary" (v1 does not expose
  it). Rotation deliberately unsupported in v1: rotating invalidates every
  session and the AES-encrypted `jwks` private keys; documented.

## Browser path

- **Direct (browser ↔ auth service origin)** — rejected as golden path:
  cross-origin cookies are the part browsers keep breaking, and the
  workable variant (bearer plugin, token in JS-readable storage) is a worse
  security default (XSS = session theft) and makes redirect flows (magic
  link lands a GET on the auth origin) awkward — you end up rebuilding
  OAuth handshake machinery for first-party login.
- **Winner: consumer app proxies `/api/auth/*`** — first-party httpOnly
  cookies, no CORS story, magic-link URLs on the app's own origin. Shipped
  as a one-line helper (`authProxy`). Direct+bearer stays documented as the
  SPA/mobile alternative (bearer plugin is enabled server-side either way).
- Idiomatic-consumption concern (Will): Better Auth's public examples all
  assume mounted-in-app. Resolution: with the proxy, the *browser-facing*
  idiom is preserved byte-for-byte (same paths, same `createAuthClient`,
  any UI kit works unchanged); the only casualty is in-process
  `auth.api.*`, whose replacement (JWKS verification + RPC) is Better
  Auth's own documented multi-service pattern. The embedded export covers
  the zero-deviation case.

## Mounted-in-app

ADR-0016 explicitly excludes an embedded module mode ("not a library you
embed in your process"). Winner: a plain library export
(`./embedded`) sharing `buildAuthOptions()` with the service, so embedded
and dedicated stay behaviorally identical. Not a module; no ports; no ADR
change needed.

## Session strategy

Stateless JWT by default (15-min TTL, JWKS-verified, zero DB access);
instant logout is an explicit per-call-site opt-in via the `session` RPC
port. Rejected: global revocation checks (defeats the point of the JWT
binding); longer TTLs (widens the logout gap for no consumer benefit).

## Admin/session handlers go DB-direct

Better Auth's admin plugin authorizes via admin *sessions*; our admin port
is authorized by wiring (ADR-0030 service keys) — impersonating an admin
session server-side to satisfy the plugin would be a hack. The `session`
and `admin` port handlers therefore query/mutate the auth-schema tables
directly (semantics pinned per-op in the spec). The write/read boundary on
auth's tables elsewhere remains convention (ADR-0022 concedes a shared DB
exposes the whole contract; least-privilege slices stay deferred).

## Email

PR #146's contract needs nothing added: templates are consumer-declared,
so auth ships its own `verification`/`passwordReset`/`magicLink` templates
and depends via `emailSender(templates)`. Two #146 review findings become
structural obligations here: one idempotency key minted per send-callback
invocation and reused across retries; links validated against the app
origin and HTML-escaped before interpolation.

## Deferred / non-goals recorded during discussion

- Social OAuth (factory options adding per-provider secret slots — D7
  mechanism specced, implementation post-v1).
- Organizations, 2FA, passkeys, username/phone auth (contract must not
  preclude; all post-v1).
- Secret rotation story.
- `deleteUser` on the admin port (cascade semantics across consumer FKs
  unresolved), impersonation (needs the deferred admin-path authz story).
- Exposing the instance secret to consumers (add an explicit binding when
  a real need appears).
- Per-consumer least-privilege contract slices on a shared DB (ADR-0022
  deferral, unchanged).

## Admin-path feedback (for the tier-1 conventions pass)

- Email's `outbox` port is read-only; auth's `admin` port mutates
  (revoke/ban). Tier-1 conventions need a stance on mutating admin ops.
- Auth splits consumer-facing runtime reads (`session`) from operator
  actions (`admin`); email collapses both into one port. If more modules
  grow the split, name the convention.
- Pagination/filter conventions (keyset cursor, limit 1–200 default 50,
  AND-filters) transfer cleanly from email and should become *the*
  admin-port idiom.
- Flat rpc dispatch (`POST /rpc/<method>`) imposes **cross-port method-name
  uniqueness** (found D5: `session.getUser` vs `admin.getUser` throws at
  `serve()` construction). Renamed the admin op `findUser` in S1.
- **Wired egress (Will, 2026-07-23), superseding the first isolation
  draft.** The orchestrator's path-scoped-dispatch + per-port-key-
  partitioning proposal was rejected: it hardens the flat listener but
  keeps serving as ambient authority. Settled model: listening is a wired
  capability — rpc ports mount iff a consumer edge exists (the binding
  carries the egress information; unwired = absent, not 401), and only
  "expose publicly" (the boundary outside the topology) gets a new
  explicit representation, supplied by the root at provision. See
  `slices/rpc-port-isolation/spec.md` v2. For the admin path: "admin
  ports are reachable only if wired" becomes the literal mechanism, not
  a deferral.

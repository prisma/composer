# Friction log — open-chat Composer port (S7)

Every workaround, missing capability, or illegible error hit while porting
[open-chat](https://github.com/prisma/open-chat) (the app behind oss.chat)
onto Prisma Composer. This log lives here, next to `gotchas.md` and
`dogfood-report.md`, because it is Composer dogfooding output — the port
branch itself ([prisma/open-chat#1](https://github.com/prisma/open-chat/pull/1))
carries only the port. Appended by each dispatch (D1–D7); filed as
`prisma/compose` issues in D5. The framework version under test is recorded
in each dispatch section's header.

## D1 — Topology scaffold

*Entries #1 and #2 below were rewritten in D1b (2026-07-16) after the
operator dropped `pnPostgres` for plain `postgres()` on both ends (spec:
open-chat-port Chosen design #7). Both workarounds they originally described
are gone from the code; the underlying framework gaps are not fixed, so the
findings stay, sharpened by having tried the fix.*

### 1. A `pnPostgres` resource cannot satisfy a plain `postgres()` dependency — and the converse is blocked too

**Where hit:** D1 wired `pnPostgres({ name, contract, config })` provisioning
a `pnPostgres(contract)` dependency. D1b then tried the shape this port
actually wants: provision a `pnPostgres` resource (framework-run migrations,
ADR-0022) but consume it through open-chat's own `pg.Pool` — i.e. a plain
`postgres()` dependency, since open-chat's `src/prisma/db.ts` builds its own
client from `{ url }` and does not accept a framework-built typed client.

**Symptom:** TypeScript rejects it at the `provision()` call site.
`pnPostgres({ ... })` returns a `ResourceNode<Contract<'prisma-next', PnCmp>>`;
`postgres()`'s dependency end requires a `Contract<'postgres', PostgresConfig>`.
The two contracts' `kind` literals (`'prisma-next'` vs `'postgres'`) don't
match, so assignability fails before `satisfies` is ever reached at Load —
"framework migrations + my own client" is inexpressible.

**Cause:** `Contract<Kind extends string, Cmp>`
(`packages/0-framework/1-core/core/src/contract.ts`) welds `Kind` into two
places at once, both using the SAME type parameter as the contract they're
declared on: the provision-site TypeScript assignability check
(`ResourceNode<C>` against a dependency's required contract, in `node.ts`),
and `satisfies(required: Contract<Kind, unknown>)`'s own signature. A
`prisma-next` database genuinely IS a Postgres database — its `PnCmp` carries
a `{ url }`-shaped connection underneath the typed client — but nothing in
`Contract`'s shape lets a `'prisma-next'`-kinded contract declare "I also
satisfy `'postgres'`". Kind equality is baked into the type itself, not a
policy `satisfies` chooses, so a cross-kind subtype relation can't be
expressed at all.

**Also tried, also blocked — the converse:** "provision a `pnPostgres`
resource but run my own migrations" (skip ADR-0022's framework-run migration)
is equally inexpressible. `PnPostgresResourceNode`'s `config` field (the
`prisma-next.config.ts` path) is required on the resource overload's argument
type — there is no `pnPostgres({ name, contract })` without it. And given a
`config` anyway, `prismaNextDescriptor`'s lowering
(`packages/1-prisma-cloud/1-extensions/target/src/descriptors/prisma-next.ts`)
unconditionally runs `PnMigration(...)` — no flag or resource variant
provisions the database and connection without migrating it.

**Workaround used:** neither direction — this port uses plain `postgres()`
on both ends (`module.ts`'s resource, `service.ts`'s dependency) and keeps
running open-chat's own `db:init`/`db:push` as an operator step (D3). Per
ADR-0022 the contract hash is the thing and migrations are only the means, so
this doesn't need the framework to run them; open-chat gets neither
framework-run migrations nor the typed client, by design (Chosen design #7)
— it only ever needed the URL.

**Recommendation:** let a `prisma-next` contract's `satisfies` accept a
`Contract<'postgres', unknown>` too, not just its own kind, when its
underlying storage genuinely is Postgres — which needs `Kind` widened off
`satisfies`'s parameter type, not just the value returned. Caution: a naive
"no required hash → satisfied" rule is wrong — it would let a `pnPostgres`
resource satisfy an unrelated `s3()`/`streams()` dependency too, since those
also have no required-hash concept. Any fix has to compare kind-compatibility
explicitly, not merely "hash present or absent". Not attempted here — a
`Contract` type change, out of scope for an app port.

> **Update (D6):** ADR-0040 dissolved the practical case by widening the
> binding rather than the kind system: a `pnPostgres` dependency now hydrates
> to `{ url, client }`, so an app that owns its client declares the
> contract-carrying dependency and reads `url`. The cross-kind `satisfies`
> recommendation above was considered and rejected in ADR-0040.

### 2. Version skew: framework's bundled `@prisma-next` 0.15.0 vs open-chat's 0.13.0-emitted `contract.json`

**Where hit:** D1's boot-time smoke test of the launcher (`chatService.run()`
with fabricated `COMPOSER_*` env vars) when it still used `pnPostgres`.

**Symptom (as hit under `pnPostgres`, before D1b removed it):**

```text
ContractValidationError: Contract structural validation failed:
execution.mutations.defaults[0].ref.namespace must be a string (was missing);
... [8 entries]
    at validateSqlContractStructure (.../@prisma-next/sql-contract/dist/validators.mjs)
    at deserializeContract (.../@prisma-next/family-sql/dist/sql-contract-serializer-*.mjs)
    at postgres (.../@prisma-next/postgres/dist/runtime.mjs)
    at hydrateSync (.../@prisma/composer/dist/dist-*.mjs)
```

thrown from inside `service.load()`.

**Cause:** the pkg.pr.new preview's `@prisma/composer-prisma-cloud` declares
its own `@prisma-next/*` dependencies at `0.15.0`; open-chat is pinned to
`@prisma-next/postgres@^0.13.0`, and `src/prisma/contract.json` was emitted
by that 0.13-vintage `prisma-next` CLI. Bun installs both — the top-level
hoisted `@prisma-next/postgres@0.13.0` (open-chat's own) and a *nested*
`node_modules/@prisma/composer-prisma-cloud/node_modules/@prisma-next/*@0.15.0`
(composer's own) — because the version ranges don't overlap. When
`pnPostgres(contract)`'s `hydrate` called into the *0.15.0* runtime with
open-chat's *0.13-emitted* `contractJson`, the newer runtime's structural
validator rejected it: `execution.mutations.defaults[].ref.namespace` is a
field the 0.13 emitter didn't write. A genuine data-format incompatibility,
not just a TypeScript nominal-branding annoyance.

**Compounding effect (also no longer hit, same reason):** `hydrateSync`
(`packages/0-framework/1-core/core/src/hydrate.ts`) hydrates *every* declared
dependency in one synchronous pass with no per-key laziness or isolation:

```ts
for (const [name, inputNode] of Object.entries(root.inputs)) {
  deps[name] = inputNode.connection.hydrate(values as never); // threw here for "db"
}
```

So `db`'s failure would have poisoned the *entire* `load()` call — the
launcher could not have called `service.load()` even just to read the
harmless, trivially-hydrated `streams.url`.

**Status:** not hit anymore — D1b dropped `pnPostgres` entirely (Chosen
design #7), so this port never calls into the 0.15.0 runtime with open-chat's
0.13-emitted contract. Recorded so the incompatibility isn't lost: any future
port or app that DOES need `pnPostgres`'s typed client will still hit it.

> **Update (D6):** retired for this port twice over. The binding's client is
> now lazy (ADR-0040), so a service that only reads `url` never runs the
> runtime's contract validation — and when validation does fail, it surfaces
> at the first `client` access attributed to that input instead of failing
> the whole `load()`. Separately, recommendation (a) was executed: the app's
> own toolchain moved to `@prisma-next` 0.15 and the contract was re-emitted
> (operator decision, D6), which also forced the 0.15 runtime's
> schema-namespaced ORM paths (`db.orm.public.<Model>`) through the app's
> query call sites. Recommendation (c) — a `@prisma-next` compat note for
> same-`schemaVersion` rejections — still stands upstream.

**Recommendation:** (a) real fix — align open-chat's `@prisma-next/*` pins
with whatever version `@prisma/composer-prisma-cloud` depends on (or vice
versa) and regenerate `contract.json`/`contract.d.ts`; an operator-level,
whole-app dependency decision, not a topology-wiring one. (b) framework-side
— `hydrateSync`/`hydrate` failing one input shouldn't prevent reading any
other already-hydratable input; consider per-key error attribution at
minimum (the current error gives no indication *which* dependency failed
without reading the stack). (c) `@prisma-next/postgres`'s runtime validator
rejecting a same-`schemaVersion` (`"1"`) contract emitted two minor versions
back is itself worth a `@prisma-next` compat note — `contract.json`'s own
`schemaVersion` field implies forward compatibility within a schema version
that didn't hold here.

### 3. `node()` build adapter's `assemble()` copies a single file — incompatible with a multi-file Bun static-asset build

**Where hit:** wiring the launcher's build script and reading
`@prisma/composer/node/control`'s `assemble()` source to understand what the
`entry` field needs to point at.

**Symptom (projected — not yet exercised; D3 will hit this for real):**
`open-chat`'s own build (`bun run build:chat`) produces **seven** files under
`dist/server/` — the server bundle plus the client bundle Bun's native HTML-import
feature emits alongside it:

```text
start.js                     2.48 MB    (entry point)
index-<hash>.js               0.98 MB    (entry point)
client/index.html             3.10 KB    (entry point)
index-<hash>.css              31.44 KB   (asset)
og-tour-<hash>.png            103.0 KB   (asset)
tour-app-<hash>.webp           0.31 MB   (asset)
tour-console-<hash>.webp      215.54 KB  (asset)
```

`@prisma/composer/node/control`'s `assemble()`
(`packages/0-framework/2-authoring/node/src/control.ts`) does:

```ts
const entryFile = path.basename(entryPath);
const bundleDir = path.join(workDir, 'bundle');
await fs.promises.mkdir(bundleDir, { recursive: true });
await fs.promises.copyFile(entryPath, path.join(bundleDir, entryFile));
```

— a single `fs.copyFile`, not a directory copy. Only the one file the `entry`
field names reaches the deploy bundle; the other six (including the client
HTML/JS/CSS/images the chat UI actually serves) are silently dropped.

**Cause:** the `node` build type's `assemble()` assumes a single-file
runnable. `@prisma/composer/nextjs`'s `assemble()`
(`packages/0-framework/2-authoring/nextjs/src/control.ts`) does the opposite —
a recursive `fs.promises.cp(standaloneRoot, bundleDir, { recursive: true })`
— because Next's standalone output is inherently multi-file. `node` has no
equivalent.

**Not worked around in D1** (deploying is D3's job; this dispatch only had to
produce a build the `node()` adapter's `entry` field type-checks against).
Recorded now because it was discovered while wiring the build, and it *will*
block D3 as written: pointing `entry` at `dist/composer/start.js` (which
dynamically imports `dist/server/start.js` at runtime, see `start.ts`) only
carries `dist/composer/start.js` into the deploy artifact — the dynamically
imported `dist/server/start.js` and its sibling client assets never arrive.

**Recommendation:** extend `node`'s `assemble()` to copy the entry's sibling
files (mirroring `nextjs`'s directory copy, or reading a manifest such as
Bun's own build metadata) — or document that a `node`-built service must ship
a genuinely single-file bundle, which open-chat's HTML-import-based client
delivery cannot do without moving asset embedding into app code (out of
scope: "we don't bundle the app's code").

### 4. `bun build --external` doesn't match a dynamic import's as-written relative specifier

**Where hit:** wiring `build:launcher`'s bundling of `src/composer/start.ts`.

**Symptom:** `bun build --external "../../dist/server/start.js"` (the exact
string as written in the `await import(...)` call) has no effect — bun still
resolves and inlines the target, duplicating the ~2.5 MB already-built app
bundle into the launcher's own output (and breaking `chdir.ts`'s
`import.meta.dir`-relative asset resolution, since the re-bundled code's
`import.meta.dir` would then point at `dist/composer/`, not `dist/server/`).

**Cause:** bun's `--external` glob matching (for a dynamic import) matches
against the path *relative to the build's working directory*, not the
specifier as written relative to the importing file.

**Workaround used:** `--external './dist/server/start.js'` (or a
`'*/dist/server/start.js'` glob) — either matches; documented in
`package.json`'s `build:launcher` script.

## D2 — Local dev loop

### 5. No local-dev harness for a `compute()` node with real dependencies — the deploy env-var wire protocol has to be hand-replicated

**Where hit:** writing `scripts/dev.ts` to run the app through the launcher
path (`src/composer/start.ts`), which reads `service.load()`/`config()`/`secrets()`.

**Symptom:** those three accessors read a process-local "stash" that only
`run(address, boot)` populates — and `run()` itself only exists to be called
by the bootstrap.js a deploy prints
(`packages/1-prisma-cloud/0-lowering/lowering/src/compute/artifact.ts`:
`` `import main from "./main.mjs"; await main.run(${address}, () => import("./${appEntry}"));` ``).
There is no local-dev equivalent of that bootstrap anywhere in the framework
or its examples. Grepping the whole framework repo for a working call to
`.run()` on a node with real deps/params turns up nothing — every example's
entry file only calls `.config()`/`.load()`, and the one example whose
`scripts/dev.ts` boots a `compute()` node locally
(`examples/store/scripts/dev.ts`) sidesteps the whole problem: that node
declares `deps: {}` and is driven through `@prisma/composer/rpc`'s `serve()`,
which never needs a real env var to be set.

**Cause:** `run()`'s job — deserialize the platform env keyed by the real
deployment address, then re-stash it address-free — is deploy machinery with
no local-dev-shaped door into it. To drive a real `compute()` node (deps,
params, secrets) outside a deploy, the only path is to write the exact env
vars `target/src/serializer.ts` expects and call `.run()` yourself: one write
per dependency's connection param (`COMPOSER_<ADDR>_<INPUT>_<NAME>`, the raw
resolved value), one per service param (same key shape minus the input
segment, JSON-encoded), and *two* per secret slot (a pointer row
`COMPOSER_<ADDR>_<SLOT>` naming a platform var, plus that platform var itself
holding the real value — never the value in the pointer row).

**Workaround used:** `scripts/dev.ts` does exactly that by hand, but built on
the extension's own exported `configKey()` (`@prisma/composer-prisma-cloud`)
rather than a re-derived uppercase transform, so the key format can't
silently drift from whatever `serializer.ts` actually does. Cross-checked
against `packages/1-prisma-cloud/1-extensions/target/src/__tests__/control-lowering.test.ts`'s
literal expected keys (e.g. `COMPOSER_INGEST_STRIPEKEY`,
`COMPOSER_WEB_APPORIGIN`) to confirm the format before trusting it.

**Compounding find:** the address to write these keys under isn't derivable
from the service declaration (`service.ts`) at all — it's assigned by
`provision()` in `load-module.ts` (`fullAddress = address === undefined ? id
: \`${address}.${id}\``), so a root-scope provision's address is its bare
`id`. `module.ts` provisions the chat service with `id: "chat"`, so the real
deploy address is `"chat"`, not `""` — nothing in `service.ts`, `start.ts`,
or any doc comment says so; it only falls out of reading the module-graph
builder. Using the wrong address (e.g. `""`) would still have worked for this
script, since it controls both the write side and the `run()` call — but it
would silently stop mirroring what a real deploy does, and wouldn't have
caught an address-handling bug if one existed.

**Recommendation:** ship a local-dev entry point for a `compute()` node with
real deps — something like `service.runLocal(values)` that takes hydrated
dependency bindings and param/secret values directly (mirroring how
`serve()` in `@prisma/composer/rpc` sidesteps the env-var channel entirely
for RPC services) instead of requiring a caller to reconstruct
`run()`'s deploy-shaped env-var protocol by hand. Short of that, exporting
the node's real deployment address (or a helper to compute it from a
module + provision id, matching `load-module.ts`'s logic) so a hand-written
dev script doesn't have to reverse-engineer it from `load-module.ts`.

### 6. `service.secrets()`'s eager, all-or-nothing resolution forces a placeholder for the one genuine external credential

**Where hit:** wiring `openrouterApiKey` for local dev with "no cloud
credentials" as a hard requirement.

**Symptom:** `service.secrets()` throws if *any* declared secret slot's
platform var is unset or empty (`deserializeSecrets` in `serializer.ts`) —
there's no way to leave one slot unbound and read the rest, and no
optional-secret declaration. Since `start.ts` calls `service.secrets()`
before doing anything else, an unset `OPENROUTER_API_KEY` doesn't just break
chat generation — it would crash the whole process before the HTTP server
ever starts, taking sign-in and the live-tail SSE path down too, neither of
which touches OpenRouter.

**Cause:** by design (ADR-0029/Chosen design #8) — a required secret slot
is meant to fail loudly rather than silently run with a missing credential in
a *deployed* environment, which is the right default there. Local dev has a
different, legitimate need this doesn't distinguish: "let me run everything
that doesn't need this one credential."

**Workaround used:** `scripts/dev.ts` generates a harmless local placeholder
string for `OPENROUTER_API_KEY` (and prints a warning) when the shell doesn't
already have one set, so `secrets()` resolves and the app boots. The
placeholder reaches OpenRouter's real API and fails there
(`"Missing Authentication header"`, confirmed by driving a message send
end-to-end) — chat generation fails exactly as expected, while sign-in,
history, and live tail all work, because none of them read that secret.
Exporting a real `OPENROUTER_API_KEY` before running the script uses it
instead (`scripts/dev.ts` prefers whatever's already in the shell's env over
generating a placeholder).

**Recommendation:** no framework change proposed here — the workaround is
adequate and the strict-by-default behavior is correct for deploys. Worth
noting in local-dev-facing docs (the framework's, not just this port's) that
"missing secret" and "missing *this* secret, on purpose, for local dev" are
different needs the API doesn't distinguish.

### 7. The `node()` build adapter's static entry means the launcher path can't hot-reload

**Where hit:** `scripts/dev.ts` boots through `src/composer/start.ts`, whose
last line unconditionally does `await import("../../dist/server/start.js")`
— the app's own *built* production bundle, not its source.

**Symptom:** `dev:composer` cannot be a fast edit-refresh loop the way `bun
run dev` (`bun --hot src/server/index.ts`) is — a code change requires
rerunning `bun run build:chat` (which `scripts/dev.ts` does unconditionally
on every invocation) before it's reflected.

**Cause:** not really a bug — `start.ts`'s whole point (per its own comment)
is to import "the app's existing, already-built server entry unchanged," so
that the dev loop exercises the same artifact a deploy would build, not a
bypass. A static, pre-built entry point is inherent to that goal; hot reload
and "prove the deploy-shaped wiring" are different things to optimize for.

**Workaround used:** none needed — `bun run dev` remains the fast loop for
business-logic iteration (untouched by this dispatch); `dev:composer` is a
separate, slower loop for proving the topology, rebuilding on every run.
Recorded because "why doesn't my composer dev loop hot-reload" is a
predictable point of confusion without this being written down somewhere.

## D3 — Real cloud deploy

Framework version under test for this dispatch: the pkg.pr.new preview of
`prisma/composer`'s `main` at `668c8b0` (adds `node()`'s directory form,
entries #3 and #4 above's blocker).

### 8. The directory form's `dir`/`entry` has to reproduce the exact on-disk nesting a pre-existing dynamic import specifier assumed — "put the referenced files inside dir" isn't enough

**Where hit:** switching `service.ts`'s `build: node(...)` to the directory
form so the deploy artifact carries `dist/server/` (the app's built server
plus the client JS/CSS/image siblings its HTML import emits) alongside the
composer launcher (`dist/composer/start.js`, entry #3's blocker).

**Symptom:** the natural-looking config —
`node({ module: import.meta.url, dir: "../../dist", entry: "composer/start.js" })`,
with `dist/` containing `composer/` and `dist/server/` as siblings — fails at
`bun build` time, not deploy time: changing `start.ts`'s dynamic import from
`"../../dist/server/start.js"` to the sibling-relative `"../server/start.js"`
(matching that layout) makes bun's bundler report
`error: Could not resolve: "../server/start.js"` for a file that plainly
exists on disk one level up from `dist/composer/`.

**Cause:** bun resolves a dynamic `import()`'s specifier against the
*source* file's on-disk location at build time (confirmed dist/server does
exist relative to `dist/composer/`... but the resolution happens against
`src/composer/start.ts`'s own directory, where no `server/` sibling exists —
only `dist/server/` two levels up, at the repo root). Having resolved it,
bun leaves the specifier string untouched in the bundled output — so the
*same* string then has to resolve correctly again at runtime, relative to
wherever the entry lands once `dir` is copied into `bundle/`. Entry #4 above
already found half of this (build-time resolution happens against the
specifier as written); the other half — that the resolved specifier is
frozen into the bundle unchanged, so its literal relative-path depth has to
match in two unrelated locations (the source tree at build time, the copied
`bundle/` tree at runtime) — only bites once a directory of siblings is
actually shipped, which single-file `node()` never triggered.

**Workaround used:** left `start.ts`'s import as the original
`"../../dist/server/start.js"` (unchanged — it already resolves correctly
against `src/composer/` at build time, two levels up to the repo root and
back down). Added a `build:pack` script
(`rm -rf dist/pack && mkdir -p dist/pack/dist && cp -R dist/composer dist/pack/dist/composer && cp -R dist/server dist/pack/dist/server`)
that reproduces that same two-levels-deep nesting inside a dedicated tree,
and pointed `dir` at it: `node({ module: import.meta.url, dir: "../../dist/pack", entry: "dist/composer/start.js" })`.
Verified by resolving the exact specifier against the built `dist/pack` tree
with `path.resolve` before deploying, and by the live deploy in this
dispatch: the deployed URL serves both the app shell and a client asset
fetched from it (`index-<hash>.js`/`.css`, 200, correct content-type), which
only happens if the whole copied tree — launcher, server, and client
siblings — arrived and resolves.

**Recommendation:** the building-an-app.md guide's directory-form section
says to resolve siblings "against `import.meta.url`, not the working
directory," which is necessary but not sufficient advice for a dynamic
`import()` specifically — it doesn't warn that the specifier is resolved
once, at build time, against the *source* module's location, then reused
unchanged at the *copied* location. A worked example with a dynamic import
inside the entry (not just static sibling reads, as `examples/env-param`'s
`Bun.file(new URL(...))` case shows) would have surfaced this faster; today
nothing in the docs or the `prisma-composer` skill mentions dynamic imports
inside a directory-form entry at all.

## D4 — Preview-stage deploy and stage isolation

Framework version under test for this dispatch: same pkg.pr.new preview of
`prisma/composer`'s `main` at `668c8b0` D3 used — no framework version bump.
Date: 2026-07-17.

### 9. Correcting an `envParam`'s value after the URL it depends on is known doesn't survive a redeploy — Alchemy sees no diff, so the correction never reaches a running instance

> **Superseded — do not use this workaround.** The manual `PATCH` + throwaway
> artifact-hash marker described below is the wrong fix, and on
> `@prisma/composer@0.1.0-dev.18` it actively breaks the deploy: the raw
> PATCHed value lands in the wire key, which the deserializer now `JSON.parse`s,
> so the service crash-loops on boot. The real problem is a category error —
> `APP_ORIGIN` is the service's own provisioned URL, a framework value, not
> operator config. It should never have been an `envParam`.
>
> **Resolved by framework PR #147 (ADR-0039, `@prisma/composer@0.2.0-dev.1`):**
> a service's own origin is now a platform-resolved property, read at runtime
> via `service.origin()` — the framework injects it into the service's env as
> the reserved `COMPOSER_ORIGIN` row at deploy. The port adopted it (the
> `appOrigin` param is deleted from `module.ts`/`service.ts`; `start.ts` sets
> `APP_ORIGIN` from `service.origin()`), and the deploy needs no second pass
> and no manual correction. Recommendation (b) below is exactly what landed.

**Where hit:** setting `APP_ORIGIN` on the `preview-d4` stage. The real
preview URL (`https://iyhpiotsvrlr10zce97gifph.ewr.prisma.build`) isn't known
until after the chat service's first deploy assigns it — the same
chicken-and-egg `deploying.md` § CI already documents for a fresh stage's
first deploy ("CI must export the values... preflight copies missing ones up
on that first deploy"). What the guide doesn't cover is *correcting* that
value once you know it.

**Symptom:** deploy #1 (with a placeholder `APP_ORIGIN` in the deploy shell)
succeeds, preflight fills the platform variable from the placeholder since
the branch had none yet, and the app is reachable at its real URL. Directly
`PATCH`ing the platform variable's value via the Management API
(`/v1/environment-variables/{id}`) to the real URL succeeds (200). Redeploying
immediately after — same command, same shell env, now with the corrected
`APP_ORIGIN` — reports `Plan: 39 to noop` and creates nothing. The running
instance keeps serving the placeholder value; guest sign-in fails with a
`Set-Cookie` whose `Secure`/origin checks quietly don't match the placeholder
host.

**Cause.** Two facts compound. First (already known, PRO-211/FT-5227's
family): a compute deployment's env map is materialized once at
deployment-create and never re-resolved — confirmed reading
`packages/1-prisma-cloud/0-lowering/lowering/src/compute/Deployment.ts`'s
comment on `DeploymentProps.environment`: "the provider never reads this...
its only job is the Alchemy dependency edge... force a new deployment when
any upstream value changes." Second, and the actual new finding: **an
`envParam`'s stored row is a pointer to the platform variable's NAME
(`APP_ORIGIN`), not its value** (`config-params.md` § Binding a param at
provision) — and that pointer's *value* (the string `"APP_ORIGIN"`) never
changes across deploys, regardless of what the real platform value is. Since
`EnvironmentVariable`'s own value field is "stored encrypted; not readable
back" (`EnvironmentVariable.ts`), Alchemy has nothing to diff against and
correctly reports no change — from its point of view nothing about the
declared graph changed. The one thing that *does* force a new deployment is
`artifactHash` (a comment on `DeploymentProps` says so explicitly: "part of
the props so a new build... forces a fresh deployment; a byte-identical
`artifactPath` alone would diff as a no-op") — but an unmodified rebuild is
byte-identical (`build:pack`'s tar is deterministic, fixed mtimes, per
`compute.ts`'s own comment), so even re-running `bun run build && deploy`
doesn't help.

**Workaround used:** after the `PATCH`, force a genuinely different artifact:
add a one-line, clearly-marked temporary side-effecting statement to
`src/composer/start.ts` (a `console.error` — a bare comment risks
minification stripping it), rebuild, redeploy (this time `chat-deploy`
correctly shows `updating`/`updated`), then `git checkout --
src/composer/start.ts` to drop the marker before committing. Verified: guest
sign-in against the redeployed preview URL returns a `__Secure-` cookie
scoped to that URL, and chat creation + the SSE `ready` event both work.

**Recommendation:** this is a real gap, not just an inconvenient CLI surface
— `deploying.md`'s CI section documents the *first*-deploy fill-from-shell
path but says nothing about correcting a value afterward, and there's no CLI
affordance for it (no `--force`, no "touch this deployment" command). Two
independent fixes would close it: (a) let `prisma-composer deploy` accept an
explicit "redeploy anyway" flag that bypasses the no-op short-circuit for a
named target, sidestepping the need for a fake artifact change; (b) since the
whole reason `APP_ORIGIN` needs a second pass is "the value isn't known until
the first deploy assigns the URL," consider whether the framework could
resolve and inject the app's own assigned URL as a well-known dependency
input (the way a database's connection string already flows in) rather than
requiring the operator to round-trip it through a platform env var by hand.

### 10. Direct-write env var mutations show up correctly in the platform's own class/branch scoping, confirming stage isolation is real, not just believed

**Where hit:** verifying `APP_ORIGIN` and the database were actually isolated
per stage, per this dispatch's mandate to verify rather than assume.

**Not friction — a clean result worth recording.** Every check came back
exactly as ADR-0023/0024 predict, with no surprises:

- `GET /v1/projects/{id}/branches` classified `preview-d4` as
  `"role": "preview"` on its own — the framework never asserts this
  (`ADR-0024` § Rationale: "the platform's classification... derived from
  Branch presence, never from a role lookup"), and the platform result
  matched.
- The chat service's `database` resource minted a *separate* database row
  per branch (`db_cmrowto9509yj1adz03twh7bw` on `main`,
  `db_cmroyr1g80dyw1adzfm3lljef` on `preview-d4`) — confirmed by listing
  `GET /v1/projects/{id}/databases` and cross-checking `branchId`.
- `APP_ORIGIN` lives as two entirely separate `environment-variables` rows —
  one `class: "production"` at the project level (`branchId: null`), one
  `class: "preview"` scoped to the branch id — and `PATCH`ing the preview row
  provably left the production row's `updatedAt` untouched.
- A chat created on the preview URL (`chat_7c6c4442-...`) exists only in the
  preview database (`psql`, direct connection, confirmed by row count and by
  id lookup); the two chats already in the production database from D3
  (`chat_08616685-...`, `chat_dd7c47ca-...`) are absent from the preview
  database and vice versa.

**One easy way to get this wrong:** the project holds *three* databases per
branch — the resource named `database` (this port's own schema, what
`module.ts` provisions), the auto-provisioned default database named after
the project (`open-chat`, always empty — this port never uses it, see
gotchas.md "Creating a database with isDefault:true fails"), and
`storage.db` (the storage module's own). A first attempt at this isolation
check queried the project's *default* database by mistake (same name as the
project, easy to reach for) and found it completely empty on both stages —
which briefly looked like a real bug before re-reading `module.ts` and
querying the correctly-named `database` resource instead. Recorded because
"three databases per branch, only one of which your app's migrations ever
touch" is exactly the kind of thing an operator debugging a "why is
production empty" alarm would want written down.

## D5 — service.origin() adoption and re-deploy on the ADR-0039 build

Framework version under test: `@prisma/composer` / `@prisma/composer-prisma-cloud`
`0.2.0-dev.1` (npm — the automated dev release of `prisma/composer` merge
`ace693b`, PR #147 / ADR-0039). Date: 2026-07-22.

### 11. A standalone install can't run `prisma-composer deploy` — the alchemy CLI needs alchemy's *optional* peers, and nothing declares them

**Where hit:** the first deploy attempt on `0.2.0-dev.1`, from a standalone
clone of this repo.

**Symptom.** `prisma-composer deploy` dies before planning anything:
`error: Cannot find module '@effect/platform-node/NodeServices' from
'…/node_modules/alchemy/src/Cloudflare/Workers/WorkerBridge.ts'`; after
supplying that package, the same failure repeats for
`@effect/platform-bun/BunRuntime` (from alchemy's `Util/PlatformServices.ts`).

**Cause.** The deploy path runs the `alchemy` CLI, whose command tree
statically imports the Cloudflare provider namespace and alchemy's platform
services — which import `@effect/platform-node` and `@effect/platform-bun`.
alchemy declares both as **optional** peerDependencies, so `bun install`
doesn't install them, and neither `@prisma/composer` nor
`@prisma/composer-prisma-cloud` declares them either. In practice they are
hard requirements of every deploy.

**Why every earlier dispatch missed it:** this clone used to sit *inside* a
`prisma/composer` worktree, so Node module resolution walked up out of the
app and found both packages in the framework workspace's own pnpm
`node_modules`. The deploy only ever worked by inheriting the framework's
dev tree — an accident of directory nesting a real user won't have.

**Workaround.** Declare the two packages as devDependencies of the app
(`@effect/platform-node@4.0.0-beta.92`, `@effect/platform-bun@4.0.0-beta.92`
— versions matching alchemy `2.0.0-beta.59`'s peer range).

**Recommendation.** `@prisma/composer-prisma-cloud` (or whatever package
fronts the alchemy CLI) should carry these as real dependencies, or the CLI
should lazy-import provider namespaces so unused providers' peers stay
genuinely optional. An app deploying to Prisma Cloud should not need to know
alchemy's Cloudflare provider exists.

### 12. A plain-`postgres()` app has no path to its own provisioned database at deploy — the port's documented "app runs its own migrations" step can't be automated

> **Resolved by framework PR #154 (ADR-0040).** `pnPostgres(contract)`'s
> binding now carries `{ url, client }` with the typed client built lazily on
> first access — so "framework-run migrations + my own client" is expressible.
> The port switched its `database` resource to
> `pnPostgres({ name, contract, config })` and its dependency to
> `pnPostgres(chatData)`; the launcher reads `db.url` and never constructs
> the client. The deploy migrates the database itself (`[database-migrate]`,
> a `PrismaNext.Migration` resource, in the plan) and the operator step below
> is gone — verified end to end in D6. Recommendation (a) below (surfacing
> connection values to the deploy shell) remains open as a general
> affordance, but this port no longer needs it.

**Where hit:** first request against the fresh D5 deploy — guest sign-in
500, service logs `ERROR [Better Auth]: relation "user" does not exist`.

**Symptom.** The deploy succeeds (84 steps, all green) and the app boots, but
every DB-backed route 500s: nothing ever applied the schema to the freshly
provisioned `database` resource.

**Cause.** This port's settled design (Chosen design #7, PR #1) is a plain
`postgres()` resource with the app owning its schema —
`prisma-next db init` against the provisioned URL. That step needs the URL,
and the framework never surfaces it to the operator: the deploy resolves the
DSN internally (it writes `COMPOSER_CHAT_DB_URL` into the service's env),
but the CLI has only `deploy` and `destroy` — no outputs/state read — and
the deployment report prints resource ids, not connection strings.
`pnPostgres()` has managed deploy-time migrations, but can't satisfy a plain
`postgres()` dependency (#1), so an app that owns its own pool is locked out
of both mechanisms. Earlier dispatches papered over this without noticing:
D3/D4 ran `db init` by hand against a Management-API-minted connection, an
operator step outside the deploy that FRICTION.md never recorded as such.

**Workaround (this dispatch, recorded as an operator step, not automated):**
mint a connection on the `database` resource
(`POST /v1/databases/{id}/connections`, DSN in
`endpoints.direct.connectionString` — PRO-212), then
`bunx prisma-next db init --db <dsn> -y` (additive-only, safe to rerun).
After it, every DB-backed route works — see the D5 verification.

**Recommendation.** Either of two affordances closes this: (a) a
`prisma-composer` way to read a provisioned resource's connection values
from the deploy shell (an outputs command, or a post-deploy hook handed the
resolved bindings), or (b) a migrations hook on plain `postgres()` — "run
this command against the resolved URL before the dependent service starts" —
the deploy already sequences exactly this for `pnPostgres()`.

## D6 — pnPostgres with framework-run migrations (ADR-0040 build)

Framework version under test: pkg.pr.new preview of `prisma/composer` PR
#154 (`@prisma/composer{,-prisma-cloud}@1909260` — the `{ url, client }`
lazy binding), swapped to npm `0.2.0-dev.6` once the merge published it. App
toolchain aligned to `@prisma-next` 0.15; contract re-emitted; migrations
store regenerated (`migration plan --name init`). Date: 2026-07-22.

Same-day follow-up: the framework moved its bundled `@prisma-next` to 0.16
(`0.2.0-dev.7`), and the app re-aligned as a matched pair — contract
re-emitted (the 0.16 emit changes the contract format, so the storage hash
moved and the init migration was regenerated), fresh deploy re-verified with
`[database-migrate]` on the 0.16 tooling. No CLI or store-format changes; no
app code touched.

### 13. bun cannot install two pkg.pr.new previews where one depends on the other — same-URL dedupe fails

**Where hit:** pinning the PR #154 preview builds of `@prisma/composer` and
`@prisma/composer-prisma-cloud` for the D6 proof.

**Symptom.** With both packages pinned to their pkg.pr.new URLs,
`bun install` fails with "failed to resolve" on the `@prisma/composer` URL.
Each URL installs fine alone.

**Cause.** The preview `composer-prisma-cloud` tarball declares its
`@prisma/composer` dependency as the same pkg.pr.new URL that also appears
top-level; bun's resolver refuses the identical URL appearing at both
levels instead of deduplicating it.

**Workaround.** Suffix the top-level pin with a distinguishing query
(`…@1909260?dedupe=1`) and add an `overrides` entry mapping
`@prisma/composer` to that same query-suffixed URL — one hoisted copy
results. Removed again as soon as an npm version carrying the change
existed (`0.2.0-dev.6`); this only afflicts the preview-pin workflow.

**Recommendation.** Worth an upstream bun issue if it recurs; for this
repo's workflow, prefer npm dev releases over pkg.pr.new pairs whenever the
change is already merged.

## D7 — nativization: open-chat as an idiomatic Composer app

Framework version: npm `0.2.0-dev.7` (unchanged from D6's re-alignment).
Date: 2026-07-23. The port's original "app code unchanged" constraint was
dropped by operator decision: the deliverable became a showcase of idiomatic
Composer usage. The `src/composer/` directory, the launcher, and the
env-name mapping shim — all scaffolding that constraint had forced — were
deleted; the app now consumes `service.load()`/`config()`/`secrets()`/
`origin()` directly at each natural site, the node() build entry is the
app's own server entry (no more two-tree `build:pack` dance from finding
#8), and the deploy story is one command. Re-proven end to end on a fresh
stack. One capability gap prevented full nativization:

### 14. `StreamsClient` has no routing-key support — an app multiplexing one stream cannot use the hydrated binding

**Where hit:** replacing open-chat's own streams client with the
`durableStreams()` dependency's hydrated `StreamsClient` during
nativization.

**Symptom.** The app keeps one append-only stream per user and multiplexes
chats over it with a routing key: a `stream-key` header on append and a
`key=` query filter (with `live=true&timeout=4s` long-poll) on read. The
hydrated `StreamsClient`/`StreamHandle` expose only
`create`/`append(event)`/`read({ offset })`/`tail({ offset, timeoutMs,
signal })` — no routing-key parameter on any of them — and the client's
`url`/`apiKey` are private fields with no public accessor. The binding can
neither express the app's read/write pattern nor hand over the raw
connection values so the app's own client can.

**Workaround.** The app builds its own HTTP client and obtains the
dependency's resolved `url`/`apiKey` through the `configKey()` address-free
env rows — the reach-around first recorded in D3, now the single remaining
non-native seam in the app (housed in `src/server/streams.ts` with a
comment naming this gap).

**Recommendation.** Either close (a): routing-key support on
`StreamHandle.append/read/tail` (it is part of the streams wire protocol —
the server honors `stream-key`/`key=` today), or (b): a public accessor for
a dependency binding's raw connection values, the general escape hatch that
also retires the `configKey()` idiom. (a) serves this app best; (b) serves
every app whose client the framework hasn't wrapped yet.

### 15. No optional secret slots — credentials for an off-by-default feature can't live on the service node

**Where hit:** nativization review. The four GitHub/Google OAuth variables
are the only values left reading `process.env` in app code; everything else
moved onto the service node.

**Symptom.** open-chat shows a social sign-in provider on the auth screen
exactly when that provider's credentials are present. Declaring those
credentials as `secret()` slots makes them *required*: `secrets()` resolves
every declared slot eagerly and one unbound or empty slot fails the whole
call (finding #6's mechanism), taking guest sign-in down with it. So a
feature that is legitimately off in a given deployment forces every operator
to invent placeholder values — and a placeholder makes the app's
"is this provider configured?" presence check read as configured.

**Workaround.** The four variables stay plain `process.env` reads in
`src/server/auth.ts`, with a comment naming this gap. Their delivery in a
deployment would be hand-set platform env vars — the exact off-framework
pattern the rest of the port eliminated.

**Recommendation.** Optional secret slots: `secret({ optional: true })`
typing its `secrets()` entry as `SecretString | undefined`, unbound (or
bound to a platform var absent in that deploy) resolving to `undefined`
instead of failing, required slots keeping today's eager all-or-nothing
behavior. The deploy should report which optional slots resolved absent, so
a typo'd variable name reads as a visible "absent" line rather than a
silently disabled feature.

## Referenced elsewhere

The following are recorded in the slice spec's "Chosen design" and
"Pre-investigated edge cases" rather than duplicated here: cron not
applicable (no scheduled work in open-chat), OAuth secrets omitted (social
sign-in off), `DURABLE_STREAMS_R2_*` unsuppliable (local-disk fallback),
PRO-218 (Compute ingress buffers SSE), the `APP_ORIGIN` two-step deploy
(PRO-211).

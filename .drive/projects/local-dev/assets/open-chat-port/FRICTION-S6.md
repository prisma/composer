# Friction log — S6 (open-chat port onto `prisma-composer dev`)

Everything hit while pointing the open-chat port at locally-built
`@prisma/composer` / `@prisma/composer-prisma-cloud`, switching its build
descriptor to `node()`'s directory form, and replacing `scripts/dev.ts` with
`prisma-composer dev`. Framework version under test: the compose worktree's
own build (`0.2.0`, packed as tarballs — see the S6 report for the exact
mechanism), on top of `claude/local-dev-s5-dev-command`.

Mode: the port repo (`/Users/wmadden/Projects/prisma/open-chat`) is owned by
a different user and not writable from this session (`touch` there returned
`Permission denied`). Worked on a full copy (including `.git`) in the
scratchpad, producing real commits there; `git format-patch` output for
those commits is saved alongside this file
(`.drive/projects/local-dev/assets/open-chat-port/patches/`).

## 1. `defineConfig`'s `state` field is a descriptor, not a thunk

**Where hit:** first `prisma-composer dev module.ts` run.

**Symptom:**
`Error: prisma-composer.config.ts: \`state\` must be a state descriptor
(e.g. prismaState()) — see defineConfig() in '@prisma/composer/config'.`

**Cause:** the port's `prisma-composer.config.ts` (written during D1,
against an earlier framework preview) had `state: () => prismaState()`.
`PrismaAppConfig.state` is typed `StateDescriptor`, not a function returning
one — the current API wants the descriptor directly.

**Fix (port-side):** `state: prismaState()`.

## 2. The streams module no longer accepts a `secrets` option, and a
   consumer no longer declares a `streamsKey` secret slot (ADR-0031)

**Where hit:** second `prisma-composer dev` run, after fix #1.

**Symptom:**
`Error: The secrets for "streams" name "apiKey", which is not a secret slot
of that module (module "open-chat").`

**Cause:** the port's `module.ts` (D1/D1b) predates a framework change: the
streams module's bearer key is now an ADR-0031 provisioning need, minted
once per provider and carried automatically by a consumer's
`durableStreams()` dependency — `streams()` takes only `{ name? }`, and
`examples/streams`' own `jobsService` confirms the current pattern declares
no secret at all for it ("no secret slot, nothing to bind at the root —
declaring the dependency IS what causes the key to exist").

**Fix (port-side):** dropped `secrets: { apiKey: envSecret(...) }` from the
streams module's `provision()` call in `module.ts`, and dropped
`streamsKey: secret()` from the chat service's secret slots
(`src/composer/service.ts`) and its binding in `module.ts`.

**Compounding find — no public API for a consumer that needs the raw
connection.** `durableStreams()` (bare form) now hydrates to a typed
`StreamsClient` wrapper with no accessor for the underlying `{ url, apiKey }`
— by design (ADR-0031 hides it deliberately). open-chat's own server talks
to Durable Streams through its own client
(`@prisma/streams-local`/`@prisma/streams-server`), which needs the raw
values, not the wrapper, and there's no public "raw connection" form of
`durableStreams()` and no public re-export of the low-level `dependency()`
authoring primitive an app could use to build one. Not a bug exactly — this
app predates the typed-client design and was never the intended consumer
shape — but it is a real gap for any app that wants to plug its own client
into a module-provisioned dependency. **Workaround (port-side, in
`src/composer/start.ts`, which is Composer launcher glue, not app business
logic):** read the `streams` dependency's two connection params directly
off the same address-free env channel `run()` re-stashes them onto, via the
public `configKey()` helper (`@prisma/composer-prisma-cloud`) —
`configKey('', { owner: { input: 'streams' }, name: 'url' | 'apiKey' })`.
This is the same "reconstruct the deploy-shaped env-var protocol by hand"
technique `scripts/dev.ts` already used for other values, just narrower now
that most of the surface has typed accessors.

**Recommendation:** either a documented raw-connection form of
`durableStreams()` for apps with their own streams client, or a note in the
module's docs that a non-typed consumer has to fall back to `configKey()`
in launcher glue (worth writing down — this isn't obvious from the
compute()/durableStreams() API surface alone).

## 3. `node()`'s directory form: a launcher's relative import baked at
   build time can't resolve both "in-tree" and "as an assembled bundle"

**Where hit:** switching `service.ts`'s `build` from the single-file form
to `node({ module, dir: '../../dist', entry: 'composer/start.js' })`.

**Symptom:** `[chat] error: Cannot find module '../../dist/server/start.js'
from '.../bundle/composer/start.js'`.

**Cause:** `src/composer/start.ts`'s last line was
`await import("../../dist/server/start.js")` — a path written relative to
the SOURCE file's own location (`src/composer/start.ts`, two directories
above the project's `dist/`), which only happens to resolve correctly when
this built file runs from its unmoved, original location
(`dist/composer/start.js`, itself two directories below the project root).
`node()`'s directory form copies the whole `dir` (`../../dist`) verbatim
into the deploy/dev bundle as one unit, so `composer/` and `server/` land
as *immediate siblings* inside it — but under whatever name the bundle
mount gets (a content-hashed artifact directory), not literally `dist`. A
build-time-literal specifier can't satisfy both "resolves to a real file so
`bun build --external` accepts it" (only the two-level-up path does, from
the source location) and "resolves correctly once assembled" (only a
one-level-up path does, from wherever `composer/start.js` ends up at
runtime) — the two locations differ by a directory level in exactly the
cases that matter (assembled bundle vs. in-place `dist/`).

**Not a framework bug** — this is a pre-existing assumption in the port's
own launcher script, from before the directory-form adapter existed (see
`FRICTION.md` finding #3, "no build adapter fits an app whose built runnable
is a directory" — the fix that finding asked for). The old single-file
`node()` form never actually carried `dist/server/` into a deploy bundle at
all (finding #3's whole point); this bug was latent because nothing ran the
launcher from a MOVED location until directory-form assembly made that
possible.

**Fix (port-side):** resolve the import at runtime, relative to the
launcher's own `import.meta.url`, instead of a build-time-literal specifier:

```ts
const serverStartUrl = new URL("../server/start.js", import.meta.url);
await import(serverStartUrl.href);
```

One level up from `composer/` is `server/` in both the source-adjacent
`dist/` and the copied bundle, so this resolves correctly in both places.
Also dropped the now-unnecessary `bun build --external './dist/server/start.js'`
flag on `build:launcher` (a `new URL(...)`-computed specifier isn't a
literal bun's bundler statically resolves, so nothing needs excluding).

## 4. Packing `@prisma/composer-prisma-cloud` as a tarball still let bun
   resolve a stale, separately-sourced `@prisma/composer` underneath it

**Where hit:** wiring the port to locally-built packages via `file:`
tarball dependencies.

**Symptom:** after switching both `@prisma/composer` and
`@prisma/composer-prisma-cloud` to local `file:./vendor/*.tgz` tarballs and
running `bun install`, `node_modules/@prisma/composer-prisma-cloud/node_modules/@prisma/composer`
existed as a SEPARATE, older copy (missing the `dev` command's exports,
e.g. no `DEV_DIR` export) even though its `package.json` claimed the same
version (`0.2.0`) as the top-level tarball.

**Cause:** `@prisma/composer-prisma-cloud`'s own `package.json` declares
`"@prisma/composer": "0.2.0"` (a plain semver, from `workspace:0.2.0`
rewritten at pack time) — bun apparently doesn't treat "top-level package
installed from a `file:` tarball" and "nested package's plain-semver
requirement of the same version" as provably the same artifact (different
resolution sources), so it kept a separately-resolved nested copy instead
of hoisting/deduping — most likely a stale one from an earlier `bun install`
against the pkg.pr.new preview, before this session switched to local
tarballs (`bun install` alone, even after `rm -rf node_modules bun.lock`,
reproduced it).

**Fix (port-side):** added a top-level `"overrides": { "@prisma/composer":
"file:./vendor/prisma-composer-0.2.0.tgz" }` to `package.json`, which pins
every nested resolution too. Confirmed after a clean reinstall: no nested
`@prisma/composer` copy.

**Recommendation:** not a framework bug — an operational note worth adding
to whatever local-testing doc tells a port author how to point their
`package.json` at a locally-built framework: use `overrides`/`resolutions`
alongside the direct `file:` dependency, not the direct dependency alone.

## 5. `prisma-composer dev` doesn't run an app's own migrations

**Where hit:** first sign-up attempt against a fresh dev instance.

**Symptom:** `error: relation "user" does not exist` (Better Auth).

**Cause:** by design — `dev` provisions the local Postgres instance and its
connection, but running an app's OWN migrations (as opposed to a
framework-run `PnMigration`, which this app doesn't use — module.ts's own
comment: "the app runs its own migrations") is squarely the app's job, same
as a deploy. `scripts/dev.ts` used to do this automatically
(`prisma-next db init`); `prisma-composer dev` has no equivalent hook.

**Not a bug** — recorded because it's exactly the kind of thing an operator
would burn time on without a note. **Workaround:** run
`bunx prisma-next db init --db <url from .prisma-composer/dev/postgres.json> -y`
once per fresh instance. Documented in the port's README (see the S6 report).

## 6. BLOCKING FRAMEWORK BUG — warm restart after Ctrl-C can leave every
   service `stopped` while `prisma-composer dev` reports the app ready

**Since FIXED on #164 — see the Update at the end of this finding. The
text below records the bug as found.**

**Where hit:** proving criterion 6 (warm restart) against this port,
independently of the store's own S5 proving script.

**Symptom:** after a clean Ctrl-C (`SIGINT`, `stopServices()` ran, CLI
exited 0), a second `prisma-composer dev module.ts` (no source edit)
converged with `Plan: 43 to noop` / `Done: 0 succeeded`, printed
`[dev] ready:` with all three services' URLs, and then every one of those
URLs refused connections. `GET /apps/open-chat/services` on the compute
emulator showed `chat`, `streams.service`, and `storage.service` all
`"status": "stopped"`.

**Cause:** the local `Deployment` provider (`LocalDeploymentProvider` — at
the time in `@internal/lowering`'s `src/dev/compute.ts`; after the
localTarget rename it lives in `@internal/local-target`,
`packages/1-prisma-cloud/0-lowering/local-target/src/compute.ts`) only
calls the emulator's
`PUT .../deployment` — which is what triggers the emulator's documented
"a stopped/held service always starts on a deployment PUT" rule — from
inside its `reconcile`. Alchemy itself decides whether to call `reconcile`
at all, by diffing the resource's PROPS (`artifactHash`, `env`, …) against
its last recorded apply; a Ctrl-C stop changes neither of those (it's a
side channel — the emulator's live process state, which Alchemy's own state
file never tracks), so Alchemy sees no diff, treats the resource as a
no-op, and never calls `reconcile` — never issuing the PUT that would have
restarted the service.

**Why the existing S5 proving script (`test/integration/test/local-dev-store.integration.ts`)
doesn't catch this:** its own criterion-6 assertion checks that a warm
restart's front-door PORTS match the first session's (`assertEqual(...,
'criterion 6: warm restart keeps the same ports')`) and reads Postgres
DIRECTLY via a raw SQL connection (`withSql`), never an HTTP round-trip
against the actual restarted service — a stopped service still has a
persisted, stable port, so the port-equality assertion passes even though
nothing is listening on it.

**Confirmed twice** against this port (a clean `--fresh` run works every
time — the deployment PUT is issued as a genuine `create`; only a
plain-restart-after-stop breaks) and traced to the mechanism above by
reading `Deployment.ts`'s reconcile function, `compute.ts`'s
`LocalDeploymentProvider`, and the emulator's own documented restart rule
(`compute-main.ts`'s `PUT .../deployment` semantics, spec § 2).

**Not worked around here** — per this dispatch's instructions, a framework
bug that blocks the proof gets reported, not silently patched around. The
rest of this proof (sign-in/history/live-tail/generation-fails-as-expected)
was completed against a `--fresh` run instead, which is unaffected (every
deployment there is a genuine `create`, always reconciled). Documented in
`docs/design/10-domains/local-dev.md` ("Known gap (S6 finding,
unresolved)") and `ADR-0041` (a footnote on the same paragraph that
originally claimed "only the changed service restarts — Alchemy's diff
already limited which deployments were re-put").

**Recommendation:** either (a) `run-dev.ts`'s pipeline forces a converge
that always re-puts every deployment on a plain `dev` start (not just
`--fresh`), independent of Alchemy's own props diff, or (b) the local
`Deployment` provider grows an `observe` step that compares desired state
against the emulator's ACTUAL reported status (not just stored props) and
treats "provider says stopped, desired says running" as itself a diff. This
is very likely the SAME root cause across every local app, not just this
port — `examples/store`'s own criterion-6 check should be tightened to an
HTTP round-trip so a regression here is caught in the framework's own test
suite, not rediscovered by the next port.

**Update (S6 close-out): FIXED on #164**, by a third route close to
recommendation (b)'s spirit: the attachment seam grew a session-resume
call. `LocalTargetAttachment.startServices()` ("start every stopped
service from its last deployment — a no-op converge cannot start
anything") is called by the dev command on every attachment after each
converge, before it prints the front door (`run-dev.ts`, step 8, with a
rollback to stopped on partial failure). A warm start therefore restarts
whatever the previous session's Ctrl-C stopped, regardless of Alchemy's
props diff.

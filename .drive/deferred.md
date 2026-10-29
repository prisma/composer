# Deploy CLI MVP — Deferred items

- **Destroy without a build.** The programmatic `destroy` operation
  (`cli/src/operations/execute-deploy-destroy.ts`) evaluates the same stack
  program as deploy, so it refuses to run until the app is built. Investigate
  whether `alchemy destroy` can run the generated stack with placeholder
  bundles (does destroy-time evaluation invoke the pack's `package()`?).
  Needs live credentials. Origin: S3 review finding #1; MVP documents the
  build-first requirement instead.
- **Assemble-time native-addon detection.** The catch-all wrapper inlining
  ships a `.node`-bearing dep's JS without its binary → boot failure. Detect
  and fail loudly at assemble, or keep known-native packages external and copy
  their binaries. Origin: S3 review finding #3.

# Authoring layer — deferred at project close (2026-07-09)

## Capability backlog (later projects — from the authoring-layer roadmap)

- **In-memory/mock contract bindings** (next up): bind a consumer's contract
  slot to a co-located handler or test mock instead of a network client —
  tests + local dev without deploy. Design pass first (where the binding
  decision lives in wiring).
- **DIP swap** (replace a dependency by interface); **structural
  `satisfies`**; **gRPC/WS contract kinds**; **PDL authoring**; **contract
  errors**; **distributed spec compare**.
- **Platform-sourced secrets wired to DI**; **provisioned credentials →
  transient platform secret** (avoid credentials in state — ADR-0009 notes
  the standing concern).
- **Deterministic Next-standalone artifact** (BUILD_ID non-determinism →
  Next services re-version on unchanged redeploys).

# RPC service keys — deferred at project close (2026-07-16)

Shipped: ADR-0030 (every RPC binding carries an auto-provisioned per-binding
key; `serve()` 401s a caller without one) and ADR-0031 (the generic mechanism —
an opaque branded `ProvisionNeed` resolved through the target's `provisions`
registry). What we deliberately didn't do:

- **Cross-extension provisioned edges.** An edge whose consumer and provider
  belong to different extensions fails closed (`crossExtensionProvisionError`).
  The real shape is a cross-target contract (who mints, who validates) and there
  is no second target to design it against. ADR-0031's registry +
  resolve-against-the-consumer's-extension rule is chosen so lifting this adds a
  code path, not a redesign.
- **More than one provisioned param on one connection** — also fails closed
  (`multipleProvisionedParamsError`). One edge mints one value keyed by
  `${consumer}.${input}`, so a second need on the same connection would silently
  take the first's value under the first's brand. If a second need ever appears,
  design per-param keying (note: that churns the `servicekey-${edgeId}` resource
  id, so it re-mints keys).
- **Rotation UX.** Rotation is "remove the binding (or destroy the stack) and
  redeploy" — no rotate command, and no way to rotate without a redeploy.
- **Per-method / per-contract authorization.** The key authorizes at the service
  level: any valid key reaches every method the service exposes. Splitting into
  two services is the workaround (operator: out of scope, "easily mimickable by
  creating multiple RPC contracts").
- **Publishing the provisioning SPI.** `provisionNeed` / `ProvisionNeed` /
  `ProvisionerDescriptor` live in `@internal/*`, so only first-party authoring
  kinds and targets can use ADR-0031's mechanism. This is *consistent* with
  secrets — `secretSource` is equally internal — so it's not a regression; if
  third-party extensions ever land, both SPIs publish together.
- **Security: a service with no accepted-keys variable accepts every caller.**
  `serve()` reads `COMPOSER_RPC_ACCEPTED_KEYS` straight from the environment
  (`packages/0-framework/2-authoring/service-rpc/src/serve.ts`,
  `acceptedKeys()`). Absent or empty means "unprovisioned: local or test", and
  every request passes; `"[]"` means "deployed with no wired callers", and
  every request is refused. So a target that forgets to set the variable
  ships a service that accepts anyone, instead of one that refuses everyone.
  Mock/in-memory bindings rely on the same pass-through today, because a mock
  binding has no edge and no minted key. Fix: make enforcement the default
  and have local/test runs opt out explicitly, then design the mock-bindings
  slice against that. Related: the variable's name is spelled separately in
  two packages (`RPC_ACCEPTED_KEYS_ENV` in service-rpc, `RPC_ACCEPTED_KEYS`
  through `configKey` in the target's `service-keys.ts`). A rename on one
  side already fails the cross-package test that pins the two spellings
  together (`target/src/__tests__/extension.test.ts`, "writer and reader
  cannot drift"); sharing the constant would still remove the duplication.
  Origin: forcing-function-apps streams-binding audit, 2026-07.
- **Wired egress: mount an rpc port only if something is wired to it.**
  Today `serve()` mounts every rpc port of a service under one flat
  `/rpc/<method>` route, with one accepted key set for the whole service, so
  method names must be unique across ports and a key for one port reaches
  every port. The settled direction (Will, 2026-07-23): a port exists on the
  network only when a consumer is wired to it, it accepts only those edges'
  keys, and public exposure becomes an explicit binding the root supplies.
  The platform gives a Compute version one port and one public URL, so v1
  would be per-port path prefixes on the one listener. The design as settled:
  - An unwired port is not key-protected; it is absent (404).
  - Lowering mints a mount table per service: for each wired port, a path
    prefix from the port name (`/session`, `/admin`) and that port's edge
    keys. The provider reads the table from config. The consumer's `url`
    connection param is minted with the prefix already in it, so consumers
    never change.
  - `serve()` splits into a protocol-blind router that matches the prefix,
    checks the mount's keys and hands the request to that port's server.
    rpc is one kind of port server; Better Auth's HTTP API is another.
  - Public exposure is the only new authoring: a binding the root supplies
    at `provision()`, like `envSecret`. A surface with no binding, public or
    in-graph, is not served. For auth, the recommended wiring gives the auth
    service no public surface at all; the storefront proxies to it.
  Rationale in `docs/design/10-domains/auth-module.md`. The full design
  record (spec, rejected alternatives) is on branch
  `claude/wired-egress-project` under `.drive/projects/wired-egress/`.

# Prisma ORM data contract — deferred at project close (2026-07-12)

- **Multi-contract / contract-space extension** — full design preserved in
  ADR-0022 §Alternatives ("Deferred, not rejected"). Prerequisite spike before
  pickup: confirm Prisma ORM handles multiple peer app-authored spaces in one database
  end-to-end (Prisma ORM ADR 212's monorepo-aggregator case).

# Config params — deferred (2026-07, PR #41 review)

- **HTTP ingress should be a declared capability, not a reserved `port`
  param.** `compute()` reserves a `port` config param (default 3000) that the
  service reads to bind its server and deploy reads for `portMapping.http`
  (`packages/1-prisma-cloud/1-extensions/target/src/compute.ts`). The listen
  port is a platform runtime binding, not user configuration. Instead: the
  service declares that it serves HTTP, the platform supplies the bind
  address at runtime, and deploy derives `portMapping` from the declaration.
  Not a `deps` entry, since nothing in the graph is on the other end. Likely
  its own ADR.

# Composition — deferred (2026-07, PR #39 review)

- **One `ControlClient` for `(extension, type)` lookups.** Three places look
  up an extension descriptor by `(extension, node type)` on their own:
  `core/src/control/deploy.ts`, `cli/src/validate-coverage.ts` and
  `assemble/src/assemble-services.ts`. Replace them with one in-memory client
  that performs control-plane operations, not a state map. Open design.

# Upstream alchemy — asks (2026-08, provider adoption)

- **Raise or make configurable `destroyApp`'s 409 retry budget, or drain the
  App's deployments before deleting it.** It retries for about 3.75 seconds in
  total; Composer's old provider retried for up to 5 minutes. See
  `docs/design/05-prisma-cloud/alchemy-lowering.md`.
- **Export `PrismaUploadClient` / open `alchemy/Prisma/Internal/*`.** The
  package export is `null`, so an outside stack cannot compose the scoped
  upload client; the only alternative is overriding the ambient
  `HttpClient`.

# Build reporting — deferred (2026-10, ADR-0051 follow-ups)

- **The display-name fallback can adopt another app's Project.**
  `resolveProject` in `packages/1-prisma-cloud/0-lowering/lowering/src/container.ts`
  falls back to matching Projects by display name when none has the app's
  `logicalId`. That fallback also matches a Project that already carries a
  different `logicalId`. It should only consider Projects with no
  `logicalId`.
- **Document recovery from a duplicate-`logicalId` 409.** A deploy that lost
  its state hits a 409 when it recreates an App, Database or Bucket whose
  `logicalId` already exists; Composer never adopts the existing row. No doc
  says what to do.
- **Ask pdp to change the branch-topology spec's example.** Its worked example
  uses `catalog-db` as a node `logicalId`. Composer cannot produce that
  address (below the root, addresses contain only letters, digits and dots),
  and it reads like an Alchemy resource ID. Ask for `catalog` instead.

# Auth module — deferred (2026-07/09)

- **The embedded export never shipped.** `createEmbeddedAuth()` (`./embedded`),
  which runs Better Auth in the consumer's own service with the same
  `buildAuthOptions()`, was the auth project's slice S4 and was not built.
  The package README still says "Arrives with slice S4". Design in
  `docs/design/10-domains/auth-module.md`.
- **`composeServiceFetch` matches the public prefix as a plain string.**
  `/api/auth` also matches `/api/authorize`. Match on a path-segment boundary
  (`packages/0-framework/2-authoring/service-rpc/src/compose-fetch.ts`).

# Forcing-function apps — deferred at shelving (2026-07)

- **Upstream the open-chat `@prisma/streams-server@0.1.11` performance
  patch.** open-chat patches the server for parallel bootstrap of segment
  heads (`STREAMS_BOOTSTRAP_HEAD_CONCURRENCY`) and an AbortController that
  honours `DS_OBJECTSTORE_TIMEOUT_MS` in the R2 client. Composer's streams
  module pins 0.1.11 unpatched: correct, but cold-start bootstrap is
  sequential. Make it a minimal PR to prisma/streams, not a vendored copy.
  Same PR: `withTimeout` in the server's `src/util/retry.ts` never clears its
  losing timer, so the process lingers up to `DS_OBJECTSTORE_TIMEOUT_MS`
  after SIGTERM.
- **Streams wiring checks only the kind.** `streamsContract.satisfies` is
  `required.kind === 'streams'`. Two consumers with conflicting typed stream
  definitions are not caught at wiring, only when one reads the other's
  events.
- **The datahub live deploy and cutover never happened.** The datahub port
  (branch `claude/prisma-app-port` in prisma/datahub) was proven by a graph
  test and a local boot, but never refreshed to the current packages,
  deployed with real credentials, or cut over. Needs operator credentials.

# Emulator commands — deferred at project close (2026-10-21)

Shipped: `prisma dev url`, `prisma dev stop`, `prisma dev --detach` and
`prisma emulator list` (Composer 0.32.0, `prisma@8.0.0-rc.24`). The design is
ADR-0052 (Composer maps its nodes to emulator instances per directory) and
ADR-0053 (the commands). What we deliberately didn't do:

- **A deployment that arrives while its instance is being deleted can start a
  process the emulator no longer tracks.** Same race as an app delete in the
  Compute emulator.
- **`env.json` in `.prisma-composer/dev/` is shared by every app run from a directory, and `--fresh` wipes it.** One app's `--fresh` can drop rows another app in the same directory needs on its next redeploy. Making it per app, like bucket objects (`buckets/<app>/<bucket>/`), would fix it.
- **`[dev]` notices bypass the CLI engine's output.** The emulators hook
  writes `[dev] compute emulator ready`, the port-change line and the
  app-switch line with `console.log` to stdout, so they land among a piped
  `prisma dev`'s data lines and inside `--json` frames. Fixing it needs a
  channel for the local target's hooks to report through the engine.
- **`prisma dev url` doesn't retry an emulator that is briefly unreachable.**
  `prisma dev` and `prisma log` use `withEmulatorRetry`
  (`cli/src/operations/emulator-retry.ts`); `dev url` should too.
- **`prisma dev url` loads the config's extensions, and so Alchemy, to read
  one JSON file.** It only matters when a script calls it in a loop.
- **`prisma dev url` and `prisma dev stop` in a directory with no
  `prisma.config.ts` fail with two stacked config-section errors instead of
  `DEV.NOT_STARTED_HERE`.** The commands declare that they need the `composer`
  config section, so the CLI engine refuses them before the operation can say
  that `prisma dev` never ran here. Either the commands stop requiring the
  section, or the engine's missing-config error names the real requirement.
- **`prisma deploy` and `prisma dev --detach` print no data lines to a
  pipe.** The deploy engine runs as a delegated child that inherits stdout, so
  its log would share the pipe with the data. Once a delegated child's output
  stops sharing stdout, give `deploy` one line per deployed node (address and
  public URL) and `--detach` one line per service (address and URL). Until
  then, scripts use `prisma dev url <address>` after `--detach` returns.
- **A run-then-stop mode for CI: `prisma dev --exec "<cmd>"`,** like Firebase
  `emulators:exec`. It would bring the app up as `--detach` does, run the
  command, stop the app and exit with the command's code.
- **ORM commands print nothing to a pipe.** The `prisma` CLI now gives a
  piped stdout plain data, and each command needs data lines in its owning
  repo (`@prisma/orm-toolchain`): `migration list`, `migration ref list`,
  `migration status`, `migration log`, `migration show`, `migration plan`,
  `migration new`, `migration check`, `migration graph`, `migration ref set`,
  `migration ref delete`, `contract infer`, `contract format`, `db init`,
  `db schema`, `db sign`, `db update`, `db verify`, `db migrate`, `orm init`. (`contract print` is not on the list: it already writes
  the contract to stdout, so a pipe gets data from it.)
- **The `prisma` CLI's "agent skills out of date" notice names
  `@prisma/orm-postgres` in projects that don't use it** (prisma/prisma-cli).
- **Removing instances and their data, and `prisma emulator start` /
  `stop`.** A deleted worktree leaves its stopped instances' records and
  Postgres data on disk, holding their ports. Planned for the emulator
  start/stop project.

# Node addressing — deferred (2026-10-22)

- **`prisma deploy delete @<stage>:<address>`: tear down a subtree.** Not built: `project delete`, the `destroy` operation and platform deletes by address cover every teardown scenario we found. Its only own jobs are emptying a stage while keeping its Branch (equivalent: `destroy`, then redeploy) and resetting one module (equivalent: a few platform deletes, then redeploy). Design if it is ever needed: follow containment (the node and everything its modules provisioned), not dependency edges; delete compute before data and wait until each instance can be deleted; list nodes outside the subtree that depend on it and warn without blocking; leave the stored topology and deploy state alone so the next deploy rebuilds it; a subcommand of `deploy`; production must be named explicitly. Origin: node-addressing design discussion.

# Node addressing — deferred at project close (2026-10-28)

- **Stage removal through the platform: a cascading Branch delete in the Management API and `prisma branch delete`.** Canceled by Will, 2026-10-27: it is not about addresses. pdp-control-plane's Branch spec also records a decision against a cascading Branch delete. Removing one environment stays the `destroy` operation. Origin: node-addressing plan.
- **Remove CI's `deleteProjectDeep` workaround** in `scripts/ci-cleanup-utils.ts`. It retries `project delete` after a 409 caused by live compute, which the platform no longer returns: `project delete` succeeded while services ran in the node-addressing QA. Not done because it is CI cleanup, not addressing. Origin: node-addressing plan.


# Public URLs — deferred at project planning (2026-10-27)

- **Follow-on project `module-input`.** The second half of ADR-0061 and ADR-0062, left out of the public-URLs project because none of its scenarios need it: a spike proving a module body can hold `input.someKey` as an opaque typed reference, pass it where a value is accepted, and get a clear error on reading or branching on it; `module()` taking `input` in place of `params` and `secrets`, the root declaring it, `paramNeed()` and the module form of `secret()` going, the shipped `auth()` and `email()` modules and the examples migrating; `resolve([input.a, environment.name], ([a, name]) => …)` with `a` typed from the schema; the `config` field on the `composer` section with adapters merged by top-level key, later wins, and `dotenv()` first. Builds on the public-URLs project's `resolve()`. Origin: public-URLs design discussion; Will put config adapters off the critical path.

## Public URLs — deferred, 2026-10-28

- **An environment named `main` resolves to the production Branch.** `production` finds the Project's default Branch by its flag; any other name finds a Branch by git name, and the default Branch's git name is `main`. So `--environment main` and `production` share one Branch and one deploy state. This predates the public-URL work (it exists today with `--stage main`) and is left as it is; a fix would refuse an environment name whose Branch is the default Branch and point at `production`.

# dev-secrets-from-env — deferred (2026-10-23)

- **Deploy fails when an optional secret is missing on the platform.** ADR-0042 says an env-bound leaf whose variable is unset resolves to "key omitted" and the schema decides whether that is legal. For `envSecret` leaves this is not implemented in deploy: the serializer always writes a `$secret` pointer, and deploy preflight fails when a bound secret is missing on both the platform and the shell, even when the schema marks the field optional. Fix inside deploy's own preflight: leave the field out when the schema accepts its absence. Origin: Will scoped the `prisma dev` secrets change (prisma/composer#379) to dev only.
- **Alchemy state stores resource props as given, including redacted values.** The local `.alchemy/state/` files hold Composer-minted credentials in plain text (the fixture's `web-deploy.json` shows the local S3 secret key), and hosted deploy state very likely does the same. Check the hosted state and decide whether minted credentials should leave props. Origin: dev-secrets-from-env review round 2.
- **The compute emulator saves each deployment's full environment, secret values included, in its machine-wide `instances.json`** (mode 0600). `prisma dev` reads values fresh each run, but the last values stay on disk. Decide whether the emulator should keep the environment only in memory. Origin: dev-secrets-from-env review round 2.
- **A rebuild during a `prisma dev` session skips the dev preflight.** It reuses the payload from session start, so a secret added to a binding mid-session is not checked or left out. Fix: run each local target's preflight again in `rebuild` and rebuild the invocation from its payload. Existing behaviour before this slice. Origin: dev-secrets-from-env final review (C02).
- **The reproduce command printed after a failed converge carries neither the preflight payload nor the container variables.** Re-running it by hand sends unset optional secrets as pointers and every trigger member as `'?'`. Fix both together.
- **`scopedEnvRows` and `pointedVariableNames` match env rows by address prefix,** so a service at `shop` also reads the rows of `shop.billing` and gets its param values. It over-shares one value and breaks nothing.
- **The Prisma Cloud wire-format helpers are copied into `@internal/local-target`:** `servicePortEnvKey`, `ownEnvKeyPrefix` and the new pointer formats (`$secret`, the param pointer prefix, the `INPUT` key). They were not moved to `@internal/lowering` because the serializer runs inside deployed services (the shared plane) and `@internal/lowering` is control-plane only; a shared-plane wire-format module at the lowering layer would fix it, modelled on `packages/1-prisma-cloud/0-lowering/s3-protocol`, a shared-plane package at the lowering layer. `dev-pointed-variables.test.ts` checks the pointer formats agree meanwhile.
- **Tag the deploy preflight payload too** (for example `deploy:`), so both kinds are explicit on the wire. Do it with the deploy optional-secret fix above, which changes deploy anyway.
- **Rename the persisted `<name>:updatedAt` trigger member** to match `pointerVersion`. It redeploys every hosted deployment once, so do it only together with a deploy change that already accepts one redeploy.
- **Remove `removeRetiredSecretsFile`** (it deletes the `secrets.json` older `prisma dev` versions wrote) once no supported `@prisma/composer` release older than the one shipping this slice is in use: at the next major release, or three minor releases after this one, whichever comes first.

## Public URLs — deferred, 2026-10-29

- **Composer publishes a hostname's DNS records through an adapter.** An option on the Prisma Cloud extension naming a DNS provider, lowered to the Alchemy DNS adapter, publishes the ownership TXT record and the CNAME the deploy would otherwise print. The records are already outputs of the Alchemy RoutingUrl resource and of the `DeployedEntity`. Origin: public-URLs design discussion with Will, prompted by alchemy-run/alchemy#2701.
- **`prisma deploy list` shows a public URL with no platform id and no URL.** `deployed-nodes.ts` in `@prisma/composer-cli` joins each topology node to its platform row by `logicalId`, and a `Prisma.CustomDomain` row carries none. P2's RoutingUrl row carries the node's address as its `logicalId`; add a `public-url` case then, reading the row's hostname. Origin: public-URLs slice P1.
- **The deploy output does not say which services have no public URL but are still reachable at their platform hostname** (ADR-0060). Saying so needs the output to know which nodes are public URLs. Do it with P3, when the platform hostname becomes opt-in and the message changes anyway. Origin: public-URLs slice P1.
- **A deploy that dies after the platform creates a custom domain, but before Alchemy records it, cannot finish.** The next deploy finds the domain on the service and `Prisma.CustomDomain` refuses it as not its own. P2's RoutingUrl row carries the node's address as its `logicalId`, so the resource finds its own row and adopts it. Until then the user deletes the domain in the Console and deploys again. Origin: public-URLs slice P1 code review.

# Values — deferred (2026-10-29)

- **`ServiceNode.inputs` and `InputRef` keep the retired port word** (the decision that a node depends on an interface or exposes one). Both are inside core and the extensions; rename them to `deps` and `DepRef` when a change already touches every reader, since `inputs` on a node is read by the Prisma Cloud extension and the local target.

- **`resolveParam` in `control/deploy.ts` uses "resolve" for a different act** (picking a param's binding or default and validating it) than Load's resolving of values. Rename it, for example to `bindParam`, when that file is next touched.

- **Rename `Values<P>` to `ParamValues<P>` at the next breaking release.** `Values<P>` is the hydrated data of a node's params, exported from `@prisma/composer`. Since `Value<T>` became the type `resolve()` returns, the two names read as related when they are not. Renaming a public type breaks callers, so it waits for a release that already breaks them. Origin: public-URLs slice C1.
- **Move `PostgresResourceNode`'s `config` and `targetRef` into `props`.** A resource's configuration now has one home, `props`, which is the only place on a resource where Load resolves a value. The Prisma Cloud Postgres resource still carries its own fields, so a value cannot configure it. Origin: public-URLs slice C1.

# Module input — deferred (2026-10-29)

- **Deprecate `envParam()`.** Once a root declares `input` from config adapters, `envParam('NAME')` in a binding is the same as `input.NAME`. Deprecate it in a later step. Origin: module-input design discussion with Will.
- **A run-time config source.** Like `envSecret()`, but it provisions a plain platform variable and keeps its value in Alchemy state, so a service reads it at boot. Fills the empty run-time config cell. Origin: module-input design discussion with Will.
- **`doppler()` and other secrets adapters.** `secrets: [doppler()]` beside `config: [dotenv()]`; only the default `environmentVariables()` ships with module-input.
- **Route run-time secrets to a secret store such as Doppler.** A source whose pointer names a Doppler key, dereferenced at boot by the target, with preflight checking and filling it. Core does not change.
- **A service whose ArkType input schema has a secret field and any morph is refused at deploy.** ArkType clones its input when the schema has a morph, `SecretBox` included, and the clone loses the box's private value. At boot `readInput` returns the schema's output, so `expose()` on the secret would throw. The serializer refuses such a schema with an error that names the copied secret (`packages/1-prisma-cloud/1-extensions/target/src/serializer.ts`). A real fix needs `SecretBox` to survive the copy, which is a foundation change. Found by the module-input S1 spike; the S2 review showed that tagging the deploy sentinel only moved the failure from deploy to boot.

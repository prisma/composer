# ADR-0056: `prisma dev --serve` runs one service with its own dev command

## Decision

`prisma dev` takes a repeatable `--serve <address>=<command>` flag. For each
named service it runs the given command, such as `next dev`, in place of the
service's assembled artifact. Everything else in the app runs as it always
does: databases, buckets, the other services and the keys minted between them.

```bash
$ prisma dev module.ts --serve web="next dev"
[dev] web: not assembled; it runs its dev command
[dev] ready
  api   http://localhost:3000
  web   http://localhost:3001  (dev command: next dev — not the deployed artifact)
   ▲ Next.js 16.0.0
   - Local:        http://localhost:3001
 ✓ Ready in 1.2s
```

```jsonc
// package.json — the opt-in is written once, in the script a developer runs
{ "scripts": { "dev": "prisma dev module.ts --serve web=\"next dev\"" } }
```

- **The served service is not assembled.** It needs no built output, such as
  `.next/standalone`, and its build output is not watched. Its node is still
  lowered and converged: its environment rows are written, its Compute
  instance exists and keeps its port, and its dependents get its URL. Only its
  deployment is left out.
- **`prisma dev` runs the command itself, in the foreground.** The command runs
  through `/bin/sh -c`, in the directory `prisma dev` was started from, with
  `prisma dev`'s own stdin, stdout and stderr. Its output, its hot reload and
  its terminal behaviour are the dev server's own. `prisma dev` prints `ready`
  once the command accepts connections on the service's port.
- **The command gets the environment the service's process would get.** That
  is the environment the local `Deployment` provider would give the service's
  deployment, re-stashed address-free exactly as the bootstrap's
  `run(address, boot)` does, so `service.load()`, `service.input()` and
  `service.origin()` work inside the dev server. `PORT` is the service's
  instance port, and `HOST` is `0.0.0.0` unless the shell sets it, as `run()`
  does. These are laid over the shell's own environment, so `PATH`, `.env`
  loading and everything else the developer's tools rely on still apply;
  Composer's values win over the shell's.
- **The port moves from the instance to the command.** The service's Compute
  instance keeps its port, so no other instance can take it, but runs no
  process: `prisma dev` stops it before starting the command. The Compute
  emulator learns nothing new.
- **It is honest about what runs.** The front door, `dev url --json` and
  `prisma dev`'s notices say the service runs its dev command, not the
  artifact a deploy would ship.

This amends
[ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md),
which leaves hot reload out ("Hot reload is deliberately absent from this
decision"), says every service boots exactly as deployed, and says the dev
command supervises no process. It also amends
[ADR-0053](ADR-0053-dev-url-dev-stop-and-emulator-list.md): `dev url` reports
a served node, `dev stop` ends a served command, and `--detach` refuses
`--serve`.

## Reasoning

### Why a framework dev server needs Composer

`prisma dev` runs built output (ADR-0041, ADR-0005): a change to a Next.js
service means `next build`, then re-assembly, then a converge, then a cold
restart of that service. That loop is correct, and fast enough for a service
that is one build step away from its source. It is not the loop a developer
expects from a framework that ships a dev server with hot module replacement.

Running `next dev` beside `prisma dev` does not work either. A Composer
service reads its configuration through `service.input()` and its
dependencies through `service.load()`, and both read rows that only the
bootstrap's `run()` writes. `run()` takes the address-keyed rows a deploy
writes (`COMPOSER_WEB_INPUT`, `COMPOSER_WEB_API_URL`, …) and writes them again
without the address, the *stash* that `load()` and `input()` read. Under a
plain `next dev` nothing writes the stash, so `service.input()` throws
`env COMPOSER_INPUT is unset`. This is by principle: configuration reaches a
compute unit through the environment, and that channel ends at the
framework's host shim ([architectural
principles](../01-principles/architectural-principles.md), "No globals").
App code does not get a `process.env` fallback. What is missing is a host shim
for a process the framework did not start from an artifact.

[core-model.md](../10-domains/core-model.md) already says how a Next page
reaches `load()` without `run()`: "local dev supplies the stash through a dev
harness". [local-dev.md](../10-domains/local-dev.md) sketched that harness: a
service may opt into a dev command that replaces its artifact process, the
harness resolves bindings and materializes the same environment, and the
opt-in "must be explicit precisely because it trades away artifact parity".
This ADR decides it.

### The opt-in is per run, not per service

The flag is a property of one `prisma dev` run, not of the service. Declaring
the dev command on the service (`nextjs({ dev: 'next dev' })`) or in
`prisma.config.ts` would make every `prisma dev` of that app run something a
deploy never ships, including the runs by agents and CI that use `prisma dev`
to check deploy-shaped behaviour without cloud credentials. A run that skips
the artifact has to say so where it is started. A package script records the
choice once for the people who want it, and a bare `prisma dev module.ts`
still runs every artifact.

Code over configuration does not argue the other way. It says the topology is
read from code. The dev command is not part of the topology: it changes no
node, no edge and no address, only which process stands behind one address for
one run.

Composer does not guess the command. It does not read `package.json` scripts
and does not infer `next dev` from a `nextjs()` build adapter. The developer
writes the command, as they would in a package script, and Composer runs it
as written. The same goes for its directory: the command runs where
`prisma dev` was started, and a monorepo package that needs its own directory
says so (`--serve web="cd apps/web && next dev"`, or the package manager's
filter flag). Using the build adapter's directory would work for `nextjs()`,
which declares one, and not for adapters that declare only an entry file.

### Lowering keeps the node and drops the deployment

The served service is left out of assembly, so lowering has no artifact for
it. Lowering a service has three steps after `provision`: `serialize` writes
its environment rows, `package` turns its assembled bundle into an artifact,
and `deploy` creates the `Deployment` that runs the artifact and returns the
service's URL to its dependents. The dev command needs the first and replaces
the third.

So `lower()` takes the addresses it lowers without an artifact
(`unassembled`), and a service descriptor gains an optional step for them:

```ts
export interface ServiceLowering<P, S> {
  // provision, serialize, package, deploy — unchanged
  /** Lower the service without an artifact: everything `deploy` produces except the deployment. */
  reserve?(ctx: LowerContext, provisioned: P, serialized: S): Effect.Effect<LoweredService, unknown, unknown>;
}
```

For an unassembled address, core runs `provision` and `serialize` as always,
skips `package`, and calls `reserve` in place of `deploy`. Prisma Cloud's
compute descriptor implements it by returning the service's outputs from its
`App`, whose endpoint locally is the same `http://localhost:<port>` the
`Deployment` would report. Its dependents' rows therefore do not change when a
service starts or stops being served, so they do not restart. A descriptor
without `reserve` cannot be served, and `prisma dev` fails before converging.
Only the dev stack file sets `unassembled`; `prisma deploy` has no way to.

This narrows ADR-0041's parity claim. Lowering is still the same code in dev
and deploy, and a local target still cannot add nodes or provisions. For each
address the developer names with `--serve`, the `Deployment` is left out. The
exception is visible in the command line, and for one run only.

### The environment comes from the code `run()` uses

The command's environment is built in two steps, both of them existing code.
The local `Deployment` provider already materializes a service's environment:
the service's own rows from the dev environment store, its port row and the
secret values (from the shell, or the persisted placeholders preflight mints).
`run()` then turns that into what the app reads. Today `run()` does that by
writing to its own `process.env` (`stash`, `stashProviderParams`,
`stashInput`, then `PORT` and `HOST`). That step becomes one function of the
service node, its address and an environment, which returns what `run()`
writes. `run()` calls it on `process.env`, and the dev command's environment is
built by calling it on the materialized environment. There is one protocol and
one implementation of it. A row the app could not read fails before the
command starts, with the error `run()` would have thrown at boot.

The Prisma Cloud target owns both steps, so core reaches them through the
local-target attachment:

```ts
export interface LocalTargetAttachment {
  // … existing members …
  /** Start every stopped service except `except` (the served ones). */
  startServices(opts?: { readonly except?: readonly string[] }): Promise<void>;
  /** The environment a served service's command runs with, its port and its URL. */
  serveEnv(service: { readonly address: string; readonly node: ServiceNode }): Promise<{
    readonly env: Readonly<Record<string, string>>;
    readonly port: number;
    readonly url: string;
  }>;
  /** Stop these services' processes; their instances keep their ports. */
  stopServices(addresses: readonly string[]): Promise<void>;
}
```

The environment is laid over the shell's, which a deployed process never
sees: the materialized environment carries only `PATH` and `HOME` from it. A dev
server needs more of the developer's environment than an artifact does
(`node_modules/.bin` on `PATH`, `NODE_OPTIONS`, the framework's own `.env`
files), and it runs on the developer's machine anyway. Composer's values are
laid last, so a stale `COMPOSER_…` export in the shell cannot shadow them.
Next.js loads `.env` files without overriding variables already set, so a
`.env` fills in the developer's own variables and cannot override Composer's.

### The port is handed over, and the emulator stays generic

Every dependent of the served service reaches it at its instance's port, and
the service's own environment names that port. So the command must listen on
that port, and nothing else may take it.

The Compute emulator already has the state needed: an instance holds its port
from creation until it is deleted, whether a process runs or not
([ADR-0052](ADR-0052-composer-maps-its-nodes-to-emulator-instances-per-directory.md)),
and a stopped instance's port is never given to another instance. So
`prisma dev` keeps the served service's instance, stops it if it runs, and
starts the command on its port. On a first run the instance is created as
usual and never gets a deployment, so it never runs.

Three things would start that instance again, and each one is told not to.
Session resume starts every stopped service after each converge, so it skips
the served addresses. A deployment the instance received in an earlier,
unserved run would be put again only if the `Deployment` were lowered, and
it is not. When the service is no longer in the stack, Alchemy deletes its
earlier `Deployment`, which locally does nothing. The emulator gets no new
state, no route and no field. It does not know that the port is in use by
something it did not start.

Composer records the hand-over in the directory's record: while a session
serves a node, its entry carries `served: { command, pid }`. Only Composer
reads it.

- `dev url <address>` reports a served node as `{ state: "served" }` with its
  URL while the recorded process is alive and the port accepts connections.
- `dev stop` ends a recorded served command, so a session killed without the
  chance to clean up leaves nothing running on the port.
- An entry whose process is gone is cleared on the next `prisma dev`.

### The CLI runs one kind of process

ADR-0041 says the dev command supervises nothing, and keeps every long-lived
process in the emulators. A dev server cannot run there and still do its job.
The emulators are detached daemons: a process they run has no terminal and
writes to a log file, and it outlives the session. Visible logs and hot reload
are the two things the developer is asking for. So `prisma dev` runs the
command as its own child process, and runs it simply:

- **Ready** when the service's port accepts a TCP connection, the rule the
  Compute emulator applies to a service. The wait uses the same timeout,
  `PRISMA_COMPOSER_SERVICE_READY_TIMEOUT_MS`, which `prisma dev` reads itself
  for this. A command that does not listen on `$PORT` in time fails with the
  address, the port and that variable. Many dev servers pick their own port
  unless told (`vite --port "$PORT"`), and the message says so. A service
  declared `listens: false` is ready once the command has started.
- **No restarts on a crash.** When the command exits, for any reason,
  `prisma dev` stops the app and exits with the command's exit code. The
  developer reads the crash in their terminal. Restarting would scroll it away
  and make the CLI a supervisor.
- **Ending the session ends the command first.** On Ctrl-C, SIGTERM or a
  failure, `prisma dev` signals the command's process tree, waits a short
  grace period, kills what is left, clears the record's `served` entry and
  then stops the app as usual.

Several `--serve` flags run several commands on the same terminal. Their
output interleaves as each writes it. Output is not prefixed, because
prefixing needs a pipe in place of the terminal, and dev servers turn off
colours, spinners and keyboard shortcuts when they do not write to a terminal.

### The watch loop and reconverging

The served service is not assembled again and is not watched: its dev server
watches its sources. A rebuild of any other service reconverges as it does
today. After each converge, `prisma dev` builds every served command's
environment again.

- **Unchanged** (the usual case: ports are stable and a rebuild elsewhere
  changes only that service's rows): nothing happens.
- **Changed**: `prisma dev` prints which variables changed, never their
  values, ends the command and starts it again with the new environment:

  ```text
  [dev] web: its environment changed (COMPOSER_API_URL); restarting next dev
  ```

  A dev server reads its environment once, at start, so a notice alone would
  leave a server running against a dependency that has moved. That is the
  stale environment ADR-0052 keeps instance ports stable to avoid. A deployed
  service gets the same treatment: the Compute emulator restarts a
  deployment whose environment changed.
- **A failed converge** leaves the command running, as it leaves the rest of
  the app running.

A change to the served service's own module (its `deps` or `input`) reaches
the command through the same rule, when a converge has written the new rows.

### `--detach` refuses `--serve`

`--detach` returns once the app answers and leaves no session behind
(ADR-0053). A served command belongs to the session that started it, so
detaching would either orphan it with no terminal or hand it to an emulator,
which is the alternative rejected below. `prisma dev --detach --serve …`
fails before doing anything, with `DEV.SERVE_WITH_DETACH`.

### `prisma dev exec` would share the environment, not the process

A command that runs once against an already running app, such as
`prisma dev exec web -- bun run seed.ts` for a script or a test, needs the
same thing a dev server needs: a service's environment, re-stashed
address-free. It needs none of the rest. The app is already converged, the
service's own process holds the port, and nothing should be restarted. So it
would share `serveEnv` (reached through `current()`, as `dev url` and
`dev stop` are, because it acts on the directory's current app without
converging), without `PORT` and `HOST`, and would share nothing of the
lifecycle. It is not part of this decision. The seam above is shaped so
adding it does not change the seam. It is not ADR-0053's `--exec "<cmd>"`,
which runs a whole app for one command and then stops it.

### Errors

| Situation | Code |
| --- | --- |
| `--serve` names an address the app does not have (the known ones are listed) | `DEV.ADDRESS_UNKNOWN` |
| `--serve` names a node that is not a service | `DEV.SERVE_NOT_A_SERVICE` |
| `--serve` without `=<command>`, or the same address twice | `DEV.SERVE_INVALID` |
| The service's descriptor has no `reserve`, or its target's attachment no `serveEnv` | `DEV.SERVE_UNSUPPORTED` |
| `--serve` with `--detach` | `DEV.SERVE_WITH_DETACH` |
| The command exited before it accepted connections | `DEV.SERVE_EXITED`, with its exit code |
| The command did not accept connections on its port in time | `DEV.SERVE_NOT_LISTENING`, with the port and the timeout variable |

## Consequences

- A Next.js service, or any service whose framework has a dev server, gets
  hot reload and visible logs under `prisma dev`, with the same bindings,
  secrets, keys and URLs as its deployed artifact gets.
- The served service needs no build. Its dependents still need theirs.
- A served run is not deploy parity for the served service. A bug that only
  the standalone build has, such as a file missing from Next's output trace,
  shows up only in a run without `--serve`. The front door says which services
  are served. Agents and CI verify with a run that serves nothing.
- `lower()` gains `unassembled`, and the service descriptor SPI an optional
  `reserve`. Prisma Cloud's compute descriptor implements it.
- `LocalTargetAttachment` gains `serveEnv` and `stopServices`, and
  `startServices` an `except` option. The Prisma Cloud target implements them.
- The bootstrap's re-stash becomes a function that returns the address-free
  rows. `run()` writes its result into `process.env`. Its behaviour is
  unchanged.
- The CLI owns one kind of process: the commands it serves. It never restarts
  one that exits, and it ends them before it stops the app.
- The directory's record gains an optional `served` field on a service node.
  A reader that does not know it ignores it, so the record stays readable by
  other Composer versions.
- `dev url`'s `state` gains the value `served`. `dev stop` ends a served
  command.
- The `dev` operation on `@prisma/composer/control` gains a `serve` option,
  a list of `{ address, command }`, and refuses it together with `detach`.
- The error codes above are registered under ADR-0044's `DEV` namespace.
- Remote bindings (a local service against real cloud resources) and
  detecting a framework's dev command stay out of scope.

## Alternatives considered

- **Declare the dev command on the service** (`nextjs({ dev: 'next dev' })`)
  **or in `prisma.config.ts`.** Written once and found by every developer,
  but every `prisma dev` of the app would then run something no deploy ships,
  including the runs agents and CI use to check deploy behaviour. The
  trade has to be visible where the run starts. A package script gives the
  same "written once".
- **Detect the dev command** from `package.json` or from the build adapter.
  Guessing, which the principles rule out, and wrong for every app whose
  script is not the obvious one.
- **Let the Compute emulator run the command.** The deployment body would
  carry a command and a working directory in place of an artifact. It would
  work with `--detach` and keep every process in the emulators, as ADR-0041
  wants. But the command would have no terminal and would write to a log file
  the developer has to tail, which keeps both problems this ADR exists to
  fix, and it would outlive the terminal it was started from. It could be
  added later for a detached served run; it is not needed for this one.
- **A new emulator instance state, "external"** (a port held for a process
  the emulator did not start). It names what this ADR does, but the emulator
  already holds a stopped instance's port. A new state would be Composer's
  concept in the emulator's model, for nothing the emulator would do with it.
- **Delete the served service's instance and let the command take the
  port.** The port would be free for any other instance or process to take,
  and the next unserved run would recreate the instance, possibly on another
  port, which changes every dependent's environment.
- **Assemble the served service anyway, as a stand-in artifact.** A small
  generated bootstrap that holds the port would keep lowering untouched, but
  it is a framework-made artifact that pretends to be the service, and it
  still needs a built output that the dev server makes unnecessary.
- **Print a notice when the environment changes, instead of restarting.**
  Cheaper, and some dev servers keep state across restarts that a developer
  would rather not lose. But the server then runs with an environment built
  for the old app, which is the failure ADR-0052 avoids. Changes are rare,
  because ports are stable, so the restart rarely happens.
- **Keep the app running when the command exits.** That is what
  `concurrently` and Docker Compose do. But the command is what the developer
  is looking at, the port would be empty while the front door says it is
  served, and keeping it up would mean restarting it.
- **Prefix each served command's output with its address.** Readable with
  several commands, but it needs a pipe, and dev servers drop their colours,
  progress output and keyboard shortcuts when not writing to a terminal.

## Related

- [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md)
  — local dev runs the deploy pipeline against local providers; amended here.
- [ADR-0053](ADR-0053-dev-url-dev-stop-and-emulator-list.md) — `dev url`,
  `dev stop` and `--detach`; amended here.
- [ADR-0052](ADR-0052-composer-maps-its-nodes-to-emulator-instances-per-directory.md)
  — instances hold their ports; the emulators know nothing about Composer.
- [ADR-0005](ADR-0005-users-build-the-framework-assembles.md) and
  [ADR-0047](ADR-0047-compute-assembly-preserves-safe-runtime-topology.md) —
  users build, Composer assembles. A served service is neither built nor
  assembled by Composer. `HOST` follows ADR-0047's default.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md),
  [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) and
  [ADR-0032](ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md)
  — the input document, secret pointers and env-sourced params the served
  environment carries unchanged.
- [ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md) — the
  `prisma dev` command this flag is on.
- [ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md)
  — where the error codes are registered.
- [local-dev.md](../10-domains/local-dev.md) — the mechanics.
- [core-model.md](../10-domains/core-model.md) — `run()`, `load()` and the
  stash.
- [Architectural principles](../01-principles/architectural-principles.md) —
  no globals; no bundling and no guessing; code over configuration.

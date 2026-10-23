# ADR-0056: `prisma dev` runs a service with its build adapter's dev server

Amended 2026-10-23: `prisma dev` takes no positional entry; the entry is `entry` in the `composer` section of `prisma.config.ts`, or `--entry <path>` ([ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md)).

## Decision

Under `prisma dev`, a service runs the dev server its build adapter declares, when it declares one, in place of its built artifact. `nextjs()` declares `next dev`. `node()` declares none unless the author writes one on it. The dev server runs on the local Compute emulator exactly as an artifact does: on the service's instance, on its port, with the environment a deployment would give it, under the emulator's readiness check, log, crash supervision and restart rules. There is no flag. `prisma dev module.ts` is the whole command.

Take an app with a Node API and a Next.js front end:

```ts
// apps/web/src/service.ts — the Next.js front end
import nextjs from '@prisma/composer/nextjs';
import { rawHttp } from '@prisma/composer/http';
import { compute } from '@prisma/composer-prisma-cloud';

export default compute({
  name: 'web',
  deps: { api: rawHttp() },
  build: nextjs({ module: import.meta.url, appDir: '..' }),
});
```

```ts
// apps/api/src/service.ts — the API, with a dev command the author chose
import { rawHttpContract } from '@prisma/composer/http';
import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';

export default compute({
  name: 'api',
  build: node({
    module: import.meta.url,
    entry: '../dist/server.mjs',
    dev: ['bun', '--watch', 'server.ts'],
  }),
  expose: { http: rawHttpContract },
});
```

```ts
// module.ts — the root
import { module } from '@prisma/composer';
import api from './apps/api/src/service.ts';
import web from './apps/web/src/service.ts';

export default module('shop', ({ provision }) => {
  const apiService = provision(api);
  provision(web, { deps: { api: apiService.http } });
});
```

```bash
$ prisma dev module.ts
dev  web: runs `next dev` in apps/web
dev  api: runs `bun --watch server.ts` in apps/api/src
dev  ready
  api   http://localhost:3000   bun --watch server.ts
  web   http://localhost:3001   next dev
[web]    ▲ Next.js 16.0.0
[web]    - Local:        http://localhost:3001
[api]  Started development server: http://0.0.0.0:3000
[web]  ✓ Ready in 1.2s
```

Edits to `apps/web` are picked up by Next's hot reload, edits to `apps/api/src/server.ts` by bun's watcher. Inside both, `service.load()` returns the bindings and `service.input()` the input document a deploy would give them. Remove `dev` from `api` and it runs `dist/server.mjs` from its assembled artifact, rebuilt and restarted when `dist/` changes, as every service did before this decision.

What this decides:

- **The build adapter declares the dev server.** A build descriptor gains a `serve` step beside `assemble`. The Next.js descriptor returns `next dev -p <port> -H <host>` in `appDir`, with the `next` binary resolved from the app's own dependencies. The Node descriptor returns the `dev` argv the author wrote, run in the authoring module's directory, or nothing.
- **A service with a dev server is not assembled.** It needs no `next build` and no `.next/standalone`, and nothing of its build output is watched. Its environment, its instance, its port and the URL its dependents see are what they would be for the artifact.
- **The emulator runs the dev server as a deployment.** A deployment on an instance is now either an artifact or a command. Readiness, the log, crash supervision, the restart on a changed environment, `--detach`, `dev stop`, session resume and `dev url` apply to a command as to an artifact.
- **The session shows the dev servers' output.** `prisma dev` follows the log of every service that runs a dev server and prints it inline, each line prefixed with the service's address. Services that run artifacts are not streamed, as before.
- **A topology edit still reconverges.** `prisma dev` watches the entry module and every service's authoring module, in addition to the built output it watched before, so an app whose services all run dev servers still picks up a change to `module.ts`.
- **`dev url` says what runs.** Its JSON result gains `runs`, `"artifact"` or `"dev-server"`.

This amends [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md), which says every service under `prisma dev` boots from its artifact and leaves a dev-command opt-in to a later decision, and [ADR-0053](ADR-0053-dev-url-dev-stop-and-emulator-list.md), whose `devUrl` result gains a field. It extends [ADR-0005](ADR-0005-users-build-the-framework-assembles.md): a build adapter performs its framework's documented deploy step, and now its documented dev step.

## Reasoning

### Why `prisma dev` ran artifacts, and why `next dev` alone does not work

ADR-0041 made `prisma dev` run the same pipeline as `prisma deploy` against local emulators. For each service it *assembles* an artifact from the author's built output, the way the service's build adapter says to, and the Compute emulator runs that artifact. Running the artifact was the simplest thing that worked: every service already had a documented way to be built and started, so nothing framework-specific was needed to run it locally. The cost is the loop. A Next.js service needs `next build`, a re-assembly, a converge and a cold restart for every edit, when the framework ships a dev server with hot module replacement.

The obvious fix, running `next dev` in another terminal, fails for a reason that is by design. A Composer service never reads `process.env` itself ([architectural principles](../01-principles/architectural-principles.md), "No globals"). Its configuration reaches it through the artifact's bootstrap, which calls the node's `run(address, boot)`. A deploy writes the service's rows keyed by its address; `run()` reads them and writes them back without the address, and that address-free copy, the *stash*, is what `service.load()` and `service.input()` read:

```text
COMPOSER_WEB_API_URL=http://localhost:3000   # written by the deploy, keyed by the address "web"
COMPOSER_WEB_INPUT={"...":"..."}

COMPOSER_API_URL=http://localhost:3000       # written by run() at boot: the stash
COMPOSER_INPUT={"...":"..."}                 # what load() and input() read
```

A plain `next dev` has no bootstrap in front of it, so nothing writes the stash, and `service.input()` throws `env COMPOSER_INPUT is unset`. What is missing is the host shim for a process Composer did not start from an artifact. [core-model.md](../10-domains/core-model.md) anticipates this: "local dev supplies the stash through a dev harness". This ADR is that harness, and it puts the framework-specific half of it, which command to run, in the one place Composer already keeps framework-specific knowledge.

### The build adapter declares the dev server

A service's build adapter is where Composer holds what it knows about a framework. `nextjs({ module, appDir })` says where the Next app is, and its build descriptor performs the Next docs' standalone deploy step at assembly: ship the standalone tree, copy in `.next/static` and `public/`. Running the same app in development is the same kind of knowledge, from the same docs: `next dev` in the app's directory, with the port and host as flags because `next dev` does not read `HOST`. So the build descriptor gains a second step:

```ts
// @internal/core, control/app-config.ts
export type NodeDescriptor =
  | ({ readonly kind: 'resource' } & Lowering)
  | ({ readonly kind: 'service' } & ServiceLowering)
  | {
      readonly kind: 'build';
      assemble(input: AssembleInput): Promise<Bundle>;
      /**
       * How this app runs in development, or `undefined` when it has no dev server and is assembled instead.
       * Never spawns anything: it resolves paths and binaries and returns data.
       */
      serve?(input: ServeInput): Promise<DevServer | undefined>;
    };

// @internal/core, control/deploy.ts
export interface ServeInput {
  /** The service's build adapter declaration, as `assemble` receives it: paths relative to `dirname(build.module)`. */
  readonly build: BuildAdapter;
  /** The service's graph address, as `assemble` receives it. */
  readonly address: string;
}

export interface DevServer {
  /** Absolute. The command's working directory. */
  readonly cwd: string;
  /**
   * The command for the port and host the service is given. `argv[0]` is an absolute path, or a bare
   * name the emulator resolves on the command's `PATH`. The same input always returns the same argv.
   */
  argv(input: { readonly port: number; readonly host: string }): readonly string[];
  /** The command as the front door and `dev url` show it: `argv` without the port and host flags, joined by spaces. */
  readonly display: string;
}
```

`serve` runs before assembly, so it cannot know the port. It returns the working directory and a function of the port and host, and the function is called once the instance's port is known. The function is pure: core calls it after every converge and compares nothing, because the emulator does the comparing.

**The Next.js descriptor.** `serve` resolves `appDir` against `dirname(build.module)` as `assemble` does. It resolves the `next` package from that directory with `import.meta.resolve('next/package.json', pathToFileURL(appDir + '/'))`, reads that package's `bin.next` field, and takes the file it names. It returns:

```ts
{
  cwd: appDir,
  argv: ({ port, host }) => [nextBin, 'dev', '-p', String(port), '-H', host],
  display: 'next dev',
}
```

Resolving from `appDir` means the app's own Next version runs, not one on the developer's `PATH`. A `next` that cannot be resolved throws an `Error` whose message is ``cannot find the `next` package from <appDir> — install it there to run this service's dev server``, which core structures as `DEV.DEV_SERVER_UNAVAILABLE` with the address. The descriptor never reads `package.json` scripts.

**The Node descriptor.** `node()`'s declaration gains an optional field:

```ts
// @prisma/composer/node
export interface NodeBuildAdapter extends BuildAdapter {
  readonly type: 'node';
  readonly dir?: string;
  readonly dependencies?: NodeDependencies;
  /** The command that runs this service in development, in the authoring module's directory. Absent: the service runs its assembled artifact. */
  readonly dev?: readonly string[];
}
```

`node({ ..., dev: ['bun', '--watch', 'server.ts'] })` records it verbatim. The descriptor's `serve` returns `undefined` when `dev` is absent, and otherwise:

```ts
{
  cwd: dirname(fileURLToPath(build.module)),
  argv: () => build.dev,
  display: build.dev.join(' '),
}
```

An empty `dev` array is rejected at Load, by the same validation that rejects a missing `entry`, with the message ``node(): `dev` must name a command``. The command gets the port and host as `PORT` and `HOST` in its environment, as an artifact does, and must listen on `PORT`. The author's command is not inspected and nothing is appended to it. A command that ignores `PORT` fails the readiness check below, whose message says to pass it.

This is not guessing. The principles rule out inferring a command from `package.json` scripts, which is a guess about what the author meant. The Next.js adapter running the framework's own documented dev command in the directory the author declared is the dev counterpart of `assemble` copying `.next/static`, which the principles bless as a documented step. The Node adapter runs the command the author wrote. In both cases the author declared what runs, in code, next to how it builds.

### What `prisma dev` does, step by step

`prisma dev`'s pipeline is: load the graph, assemble each service, resolve the local targets, run preflight and the emulators hook, write the dev stack file and converge through Alchemy, attach, start stopped services, print the front door, watch. A dev server changes each step as follows. Everything not named here is unchanged.

**Assemble.** `assembleServices` takes a new option, `{ devServers: boolean }`. `prisma deploy` passes `false` and assembles every service as today. `prisma dev` passes `true`. With it, for each service node, before assembling, the assembler looks up the node's build descriptor and calls `serve({ build, address })` when the descriptor has one. A returned `DevServer` is recorded and the service is not assembled: no `service-started` or `service-assembled` event, no bundle. `AssembledServices` gains the result:

```ts
export interface AssembledServices {
  /** One bundle per assembled service, keyed by address. A service with a dev server has none. */
  readonly bundles: Record<string, Bundle>;
  /** One dev server per service that runs one, keyed by address. Empty under `prisma deploy`. */
  readonly devServers: Record<string, DevServer>;
}
```

An address is in exactly one of the two. A `serve` that throws is structured as `DEV.DEV_SERVER_UNAVAILABLE` with the address and the thrown message, and `prisma dev` fails before anything starts, as an assembly failure does today.

**Lower.** Lowering a service has four steps: `provision` creates its identity (locally, its instance on the Compute emulator); `serialize` writes its environment rows; `package` turns the bundle into an artifact; `deploy` ships the artifact as a `Deployment` and returns the service's URL and entities. A service with a dev server needs the first two and has nothing for the third. `LowerOptions` gains:

```ts
export interface LowerOptions {
  // name, bundles, stage, state, providers, report — unchanged
  /** Addresses lowered without an artifact: `package` and `deploy` are skipped and `reserve` runs instead. Only the dev stack file sets it. */
  readonly unassembled?: readonly string[];
}
```

and `ServiceLowering` gains:

```ts
export interface ServiceLowering<P = unknown, S = unknown> {
  // provision, serialize, package, deploy — unchanged
  /** Lowers the service without an artifact: the outputs and entities `deploy` returns, with no deployment behind them. */
  reserve?(ctx: LowerContext, provisioned: P, serialized: S): Effect.Effect<LoweredResult, unknown, unknown>;
}
```

In core's lowering loop, for an address in `unassembled`: `provision` and `serialize` run as always; the bundle lookup and `missingBundleError` are skipped; `package` is not called; `reserve` is called with the same `ctx`, `provisioned` and `serialized` that `deploy` would get; its result is stored in `lowered` and `entries` exactly as `deploy`'s is. A descriptor without `reserve` fails the lowering with a `LowerError` whose message is ``service "<address>" runs a dev server but its descriptor (<extension>/<type>) has no `reserve` step``, which `prisma dev` reports as `DEV.DEV_SERVER_UNSUPPORTED`. An address in `unassembled` that is also in `bundles`, or that is not a service, is a `LowerError` naming it.

The Prisma Cloud compute descriptor's `reserve` returns what its `deploy` returns with the `Deployment` removed: `outputs: { url: provisioned.app.appEndpointDomain, projectId: provisioned.projectId }` and the one `compute-service` entity with `id: provisioned.serviceId`, `url` the same, and the `details` built from `serialized.input` exactly as in `deploy`. Locally the App's `appEndpointDomain` is `http://localhost:<port>` from the instance, the same string the `Deployment` would have reported, so dependents' rows do not change between a run that serves a service and one that does not, and dependents do not restart.

The dev stack file renders `unassembled` from `Object.keys(assembled.devServers)`:

```ts
export default lower(app, config, {
  name: "shop",
  bundles: {
    // one entry per assembled service, as today
  },
  unassembled: ["api", "web"],
  providers: localTargetProviders(resolved, containers, devDir),
  state: devState(),
});
```

**Converge.** Unchanged. On a run where a service newly has a dev server, Alchemy deletes its `Deployment` resource; the local provider's `delete` is a no-op, so the instance and whatever it runs are untouched until the serve step replaces it. On a run where a service no longer has one, the `Deployment` is created again and its put replaces the command with the artifact.

**Attach and resume.** Unchanged. `startServices` starts every stopped instance from its last deployment, which for a command instance is the command. On a warm start after Ctrl-C the dev server is therefore already starting before the serve step; the serve step's put is then identical and a no-op, or changed and a restart.

**Serve.** After `startServices` and before `endpoints()`, and again after every successful reconverge, core calls, for every address in `assembled.devServers`, in `graph.nodes` order:

```ts
// @internal/core, control/app-config.ts
export interface LocalTargetAttachment {
  // startServices, endpoints, logs, stopApp — unchanged
  /**
   * Runs a command on the service's instance in place of its artifact, with the environment the
   * service's deployment would get. Returns once the command accepts connections on the instance's port.
   */
  serve(input: {
    readonly address: string;
    readonly node: ServiceNode;
    readonly server: DevServer;
  }): Promise<{ readonly restarted: boolean }>;
}
```

The Prisma Cloud target's `serve`:

1. Finds the service's instance through the directory's record (`ensureServiceInstance(scope, address)`, which creates none here because the converge already did), taking its `id` and `port`.
2. Materializes the deployment environment with the existing `materializeEnv(devDir, address, port)`: the service's own rows from `env.json` (`scopedEnvRows`), `COMPOSER_<ADDRESS>_PORT`, every value in `secrets.json`, and `PATH` and `HOME` from the shell.
3. Applies the stash to it (next section), producing the address-free rows, `PORT` and `HOST`.
4. Builds the command's environment as `{ ...process.env, ...materialized, ...stashed }`, in that order, dropping entries whose value is `undefined`.
5. Calls `server.argv({ port, host: '0.0.0.0' })`.
6. Puts the command deployment: `computeClient().putDeployment(id, { command: { cwd: server.cwd, argv }, env, listens })`, where `listens` is the compute node's `listens` (`false` only for a service declared `compute({ listens: false })`; the target narrows the `ServiceNode` to its own node class to read it), the same value the artifact's manifest would carry.
7. Returns `{ restarted: true }` when the put's response says the process was started, `{ restarted: false }` when it was a no-op. The put response gains `{ "started": boolean }` for this; today it returns no body.

An error from the put is rethrown with the address substituted for the instance id by `withServiceAddresses`, as the `Deployment` provider does, and core structures it as `DEV.SERVICE_START_FAILED`. A target whose attachment has no `serve` fails with `DEV.DEV_SERVER_UNSUPPORTED` before the first converge, when core finds a dev server in `assembled.devServers` and the resolved attachment lacks the method.

**Ready.** `prisma dev` emits `ready` with the front door once every service, dev server or artifact, accepts connections. `ServiceEndpoint` gains an optional `devServer?: string`, the `DevServer.display`, which the command renders after the URL. Then the session starts following logs (below).

**Watch.** The watch targets are the assembled bundles' declared paths, as today, plus one target per *authoring module*: the entry file and, for every service node, the file `build.module` names (`fileURLToPath(build.module)`), deduplicated. A change to any of them runs the existing rebuild: `runPipeline` again, the stack file rewritten, a converge, then the serve step for every dev server, then `ready`. Services with dev servers are not in the bundle targets because they have no bundle. `prisma.config.ts` handling is unchanged.

**Reconverge.** After every successful reconverge the serve step runs again for every dev server. The emulator decides whether anything restarts (below). When `serve` returns `{ restarted: true }`, `prisma dev` emits a `dev-server-restarted` event for the address. When a converge fails, the serve step does not run and every dev server keeps running, as the rest of the app does.

**Stop.** `stopApp` stops every instance of the app, command instances included. `--detach` leaves them running until `prisma dev stop` or the next `prisma dev` in the directory. Nothing changes in either.

### The environment comes from the code `run()` uses

Today `run()` builds the stash by writing into its own `process.env` in three functions: `stash` (declared params), `stashProviderParams` (the reserved provider rows: the rpc key set, the origin, …) and `stashInput` (the input document), then sets `PORT` and `HOST`. Each reads `process.env[<address-keyed key>]` and writes `process.env[<address-free key>]`. They become one pure function:

```ts
// @prisma/composer-prisma-cloud, serializer.ts
/**
 * What `run()` writes for a service whose deployment environment is `env`: the address-free stash rows,
 * `PORT`, and `HOST` (`env.HOST` when set, else `0.0.0.0`). Throws the error `run()` would throw at boot
 * for a row the service cannot read.
 */
export function stashRows(
  node: ServiceNode,
  address: string,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string>;
```

`run()` becomes `Object.assign(process.env, stashRows(this, address, process.env))` followed by `boot()`, and behaves exactly as before. The target's `serve` calls `stashRows(node, address, materialized)`. `deserialize`, `coerce`, `coerceEnvSourcedParam` and `stashInput` take the environment as a parameter instead of reading `process.env`; `serializeInput` already does. `load()` and `input()` still read `process.env`, which is where `run()` and the emulator's spawn both put the rows.

The command's environment is the shell's, then the materialized deployment environment, then the stash rows, later entries winning. A deployed artifact gets only `PATH` and `HOME` from the shell, but a dev server needs more (`NODE_OPTIONS`, a framework's own `.env` loading, the developer's proxy settings), and it runs on the developer's machine anyway. Composer's values are laid last, so a stale `COMPOSER_…` export in the shell cannot shadow them, and Next's `.env` loading, which never overrides a variable already set, cannot either.

### The emulator runs the dev server

The Compute emulator holds one instance per service and runs a deployment on it. Today a deployment is an artifact directory, its hash, an environment, and whether the service listens. The body gains a second form:

```ts
type DeploymentBody =
  | { readonly artifactDir: string; readonly artifactHash: string; readonly env: Record<string, string>; readonly listens?: boolean }
  | { readonly command: { readonly cwd: string; readonly argv: readonly string[] }; readonly env: Record<string, string>; readonly listens?: boolean };
```

`isDeploymentBody` accepts either form: `command.cwd` a non-empty string, `command.argv` a non-empty array of strings. A body with both `artifactDir` and `command`, or neither, is malformed (400, `malformed deployment body`). The instance record stores `command` in place of `artifactHash` and `artifactDir`; a put of one form clears the other's fields.

`handleDeployment`'s `changed` becomes: the stored form differs from the body's form, or for an artifact `artifactHash` differs, or for a command `cwd` differs or `argv` differs element by element, or `env` differs (`envEquals`), or `listens` differs. Everything after that line is unchanged: an unchanged body on a running instance is a no-op, a joinable start is joined, anything else is a fresh start with a cleared log after the old process has exited. The response to a put becomes `200` with `{ "started": boolean }`, `true` for a fresh start and `false` for a no-op or a joined start; today's clients, which ignore the body, are unaffected.

`spawnAndWaitUntilListening` spawns, for a command, `spawn(executable, argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })`, where `executable` is `argv[0]` when it is an absolute path, else the first file named `argv[0]` on `env.PATH` that is executable, found by the same loop `resolveBunOnPath` uses for `bun`. A name that is not found fails the start with the message ``command "<argv[0]>" was not found on the deployment's PATH``, and the instance is `stopped`, as a missing `bun` is handled today. Readiness, the log, crash supervision with backoff, `held`, stop, delete, `startInstances` and `followLogs` apply to the child without distinction. The readiness failure messages gain one sentence when the deployment is a command: `A dev server must listen on the port in its PORT variable.`

`instanceView` reports `command: { cwd, argv }` for a command instance and omits `artifactHash`; for an artifact instance it is unchanged. The instance-list route, which ADR-0053 makes a cross-version contract, therefore gains one optional field and loses nothing.

The emulator learns one thing: a deployment can be a command. It does not learn what the command is for, and nothing in the body carries an app name, a node address or a directory, which ADR-0052 forbids. Why the emulator and not `prisma dev` itself: ADR-0041 keeps every long-lived process in the emulators and makes the session a view that owns none. A dev server is a long-lived process. Run anywhere else it would need a second readiness probe, crash handling, stop and log, and it would die with the session, so `--detach` could not apply. The price is the dev server's own terminal: its stdout is the emulator's log file, so a dev server that detects a terminal drops its colours and keyboard shortcuts, and its output reaches the screen within the log poll interval rather than as it is written.

### The session shows the dev servers' output

`LocalTargetAttachment.logs` gains an option:

```ts
logs(signal: AbortSignal, opts?: { readonly tail?: number; readonly addresses?: readonly string[] }): AsyncIterable<{ service: string; line: string }>;
```

With `addresses`, only those services are followed; the relist still runs, so a dev server that restarts is re-followed. After the first `ready`, the foreground session calls `logs(signal, { addresses: Object.keys(assembled.devServers) })` and emits each line as a `dev-server-output` event. The command renders it as a `message` of severity `info` with the text `[<address>] <line>`. A detached run follows nothing. A session with no dev servers calls nothing and behaves as today.

### `dev url` and the events

`LocalNodeLocation`'s running form gains `command?: readonly string[]`, set from the instance view's `command.argv` when present. `DevUrl` gains:

```ts
export interface DevUrl {
  readonly address: string;
  readonly kind: string;
  readonly url: string;
  readonly state: string;
  /** `"dev-server"` when a service runs its build adapter's dev server, `"artifact"` for every other service; absent for a database or bucket. */
  readonly runs?: 'artifact' | 'dev-server';
}
```

The plain output is still the URL alone. `dev stop`, `emulator list` and the directory's record are unchanged.

`DevEvent` gains three members, and the `dev` command renders them as shown:

| Event | Rendered |
| --- | --- |
| `{ kind: 'dev-server'; address; command: string; cwd: string }`, once per dev server, before the first converge | `message`, `info`: `` <address>: runs `<command>` in <cwd relative to the working directory> `` |
| `{ kind: 'dev-server-restarted'; address; command: string }`, after a reconverge that restarted it | `message`, `info`: `` <address>: its environment changed; `<command>` restarted `` |
| `{ kind: 'dev-server-output'; address; line }`, per log line while the session runs | `message`, `info`: `[<address>] <line>` |

`DevInput`, `DevSession` and the `dev` operation's signature are unchanged. `ServiceEndpoint` gains `devServer?: string`, rendered by the `endpoint` engine event's `data`.

### Errors

| Situation | Code | Message |
| --- | --- | --- |
| A build descriptor's `serve` threw (the Next.js adapter cannot resolve `next` from `appDir`) | `DEV.DEV_SERVER_UNAVAILABLE` | `` service "<address>" cannot run its dev server: <the thrown message> `` |
| The service descriptor has no `reserve`, or the target's attachment has no `serve` | `DEV.DEV_SERVER_UNSUPPORTED` | `` service "<address>" runs a dev server but <its descriptor (<extension>/<type>) has no `reserve` step \| its target's local attachment has no `serve`> — update <the package> `` |
| The dev server exited before it listened, did not listen in time, or its executable was not found | `DEV.SERVICE_START_FAILED` | the emulator's existing message with the address in place of the instance id, plus `A dev server must listen on the port in its PORT variable.` for the first two |

Both new codes are registered under ADR-0044's `DEV` namespace. A dev server that crashes after it listened is not an error of `prisma dev`: the emulator restarts it with backoff, its supervision lines appear in the inline log, and `dev url` reports `crashing` while it is held, as for any service.

## Consequences

- A Next.js service gets hot reload and visible logs under `prisma dev` with nothing to write. A Node service gets them by declaring `dev` on `node()`. Both see the same bindings, secrets, keys and URLs as their deployed artifact.
- A service with a dev server needs no build. A service without one still does, and still restarts when its built output changes.
- Nothing under `prisma dev` runs a Next.js service's standalone build any more. A bug that exists only in that build, such as a file Next's output trace left out, is found by `prisma deploy`. Running an app locally from its artifacts, with dev servers off and optimisations on, is a different command, which this ADR does not design.
- The build descriptor SPI gains an optional `serve`; `AssembleInput`'s sibling `ServeInput` and the `DevServer` type are added to core. The Next.js and Node descriptors implement `serve`; `node()` gains `dev`.
- `assembleServices` gains `{ devServers }`; `AssembledServices` gains `devServers`. `LowerOptions` gains `unassembled`; `ServiceLowering` gains `reserve`; the Prisma Cloud compute descriptor implements it. The dev stack file renders `unassembled`.
- `LocalTargetAttachment` gains `serve` and `logs` gains `addresses`; the Prisma Cloud target implements both. `LocalNodeLocation` gains `command`.
- The `stash`, `stashProviderParams` and `stashInput` functions become `stashRows`, pure over an environment; `run()` applies its result to `process.env`. `deserialize` and its helpers take the environment as a parameter.
- The Compute emulator's deployment body gains a command form, its put returns `{ started }`, its instance view gains `command`, and it resolves a command's executable on the deployment's `PATH`.
- `prisma dev` watches the entry module and every service's authoring module.
- `DevEvent` gains `dev-server`, `dev-server-restarted` and `dev-server-output`; `ServiceEndpoint` gains `devServer`; `DevUrl` gains `runs`. `DevInput` is unchanged, so `@prisma/composer/control`'s `dev` operation is unchanged.
- The foreground `prisma dev` streams dev servers' logs inline, prefixed with the address. Artifact services' logs are read as before.
- A dev server loses its terminal: no colours, no keyboard shortcuts, output delayed by the log poll interval.
- `DEV.DEV_SERVER_UNAVAILABLE` and `DEV.DEV_SERVER_UNSUPPORTED` are registered.
- Remote bindings (a local service against real cloud resources) stay out of scope.

## Alternatives considered

- **A per-run flag that names the services to serve** (`prisma dev --serve web`), with every service built by default. It makes the developer discover and type the flag, or hide it in a package script, to get the behaviour a framework's dev server exists for. The reason to keep the artifact as the default would be to run a deploy-shaped artifact locally, and that is a production emulation, a different command with its own needs (no hot reload, optimisations on), not a default for `dev`.
- **The developer always writes the command** (`--serve web="next dev"`), run in the directory `prisma dev` was started from. Every framework fact lands on the person typing: the directory in a monorepo, the port flag, the host, which `next` binary runs. The adapter already knows them. The Node adapter's `dev` field keeps the author's command, in code, for the adapter that has no canonical dev server.
- **Detect the dev command** from `package.json` scripts. Guessing, which the principles rule out, and wrong for every app whose script is not the obvious one.
- **`prisma dev` runs the dev server itself, in the foreground, with inherited stdio.** The dev server keeps its terminal. But the CLI then owns a process, against ADR-0041, and needs a second lifecycle: its own readiness probe, a stop with a process-group kill, a pid in the directory's record for `dev stop` with a check against pid reuse, its own restart on environment change, and no `--detach`, because a detached session has no terminal for the process to belong to. One lifecycle on the emulator costs the terminal and buys all of that.
- **Stop the whole app when a dev server exits**, so the crash stays on screen. With the emulator running it, a crash is supervised like any service's: restarted with backoff, `held` after a loop, visible in the inline log and in `dev url`. The edit that fixes the crash is picked up by the restart.
- **A separate `DevServer` method that returns argv without a port**, with `PORT` in the environment only. Simpler, but `next dev` does not read `HOST` and some servers do not read `PORT`; the adapter that knows the flags passes them.
- **Put the command's hash in the deployment's `artifactHash` field** so the emulator's change detection stays byte-identical. A field named for an artifact would hold something that is not one, and every reader of the instance view would have to know. The command form compares `cwd` and `argv` directly.
- **A new emulator instance state, "external"**, for a port held by a process the emulator did not start. Not needed once the emulator runs the process.
- **Delete the served service's instance and let the dev server take the port.** The port would be free for any other instance or process to take, and the next run would recreate the instance, possibly on another port, which changes every dependent's environment.
- **Assemble the service anyway, as a stand-in artifact** that holds the port. Keeps lowering untouched, but it is a framework-made artifact that pretends to be the service, and it still needs the built output the dev server makes unnecessary.
- **Print a notice when the environment changes, instead of restarting.** Some dev servers keep state across restarts that a developer would rather not lose, but the server would then run with an environment built for the old app, which is the failure ADR-0052 avoids. Changes are rare, because ports are stable.

## Related

- [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md) — local dev runs the deploy pipeline against local providers; the emulators own every long-lived process; amended here.
- [ADR-0053](ADR-0053-dev-url-dev-stop-and-emulator-list.md) — `dev url`, `dev stop` and `--detach`; amended here.
- [ADR-0052](ADR-0052-composer-maps-its-nodes-to-emulator-instances-per-directory.md) — instances hold their ports; the emulators know nothing about Composer.
- [ADR-0005](ADR-0005-users-build-the-framework-assembles.md) and [ADR-0047](ADR-0047-compute-assembly-preserves-safe-runtime-topology.md) — users build, Composer assembles, by documented steps; extended here to the documented dev step. `HOST=0.0.0.0` follows ADR-0047.
- [ADR-0004](ADR-0004-paths-resolve-relative-to-the-authoring-file.md) — a build adapter's paths are relative to its authoring module; a Node dev command runs there.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md), [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) and [ADR-0032](ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md) — the input document, secret pointers and env-sourced params the dev server's environment carries unchanged.
- [ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md) — the `prisma dev` command.
- [ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md) — where the error codes are registered.
- [local-dev.md](../10-domains/local-dev.md) — the mechanics of `prisma dev`.
- [core-model.md](../10-domains/core-model.md) — `run()`, `load()` and the stash.
- [Architectural principles](../01-principles/architectural-principles.md) — no globals; no bundling and no guessing; code over configuration.

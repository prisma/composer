# Design notes — emulator commands

Decisions taken while shaping, with the reasoning. Will's rulings are marked; the rest are orchestrator decisions he can overturn.

## Rulings (Will, 2026-10-13)

- The commands are `prisma dev url <address>` and `prisma emulator list`. A top-level `prisma url` was rejected as ambiguous (local and deployed running objects).
- `emulator` commands act on the machine's emulators, not on a project.
- The emulators know nothing about Composer. Composer maps (directory, app, address) to emulator instances itself, per directory. Instances carry informative labels only.
- `dev url` resolves a Composer node address only, never an emulator instance id.
- Databases and buckets are in scope alongside services.
- Piped output stays JSON; docs use `jq`. No output-format change to the CLI engine.
- The CLI engine changes so a path can be both a command and a group, keeping `prisma dev <entry>`.
- The emulators may move out of Composer later (own project, or prisma-cli). Not part of this work.

## Facts the design rests on (checked against main, 90a30381)

- The config does not name the entry or the app. ADR-0003 rejected a config that names the app; `deploy-cli.md` lists entry discovery as out of scope. So `dev url` cannot find the app from `prisma.config.ts`; it needs a record `prisma dev` leaves in the directory.
- Today the emulators are app-aware: Compute routes are `/apps/:app/services/:id`, Postgres server names come from `instanceNameFor(app, db)`, buckets are named `<app>--<bucket>`. The local identity is the root name alone (`target/src/local-target/container.ts`), so two directories running one app share instances.
- `LocalTargetAttachment.endpoints()` returns `{ address, url }` only. The emulator's `ServiceInfo` has `status: running | backoff | held | stopped`.
- The engine rejects a command path under another command (`packages/cli-engine/src/execution/command-tree.ts:157`).
- When stdout is not a terminal the engine prints JSON frames: `{"kind":"result","envelope":{"ok":true,"result":…}}` (`shared-flags.ts:191`, `settlement.ts:83`).
- `9-public` may import both `framework` and `prisma-cloud` (`architecture.config.json` cross-domain rules). `framework` imports nothing outside itself.

## Where the code lives

- **Emulators** (`dev-emulators`): instance-keyed routes and state; every create call accepts a `labels: Record<string, string>` that is stored and returned verbatim. Each emulator gains a route that lists all its instances.
- **The mapping** is owned by the Prisma Cloud local target (`local-target` / `target/src/local-target`), because that code creates the instances and learns their ids. It lives in `<cwd>/.prisma-composer/dev/` (the dev state directory, already per working directory), and records the app name plus, per node address, the emulator kind and instance id.
- **`prisma dev url`** goes through the core seam, like the `log` operation: config, then `resolveLocalTargets`, then the target's attachment. The attachment gains a method that resolves one address to `{ address, kind, url, state }`. Core stays target-agnostic; the framework domain imports nothing new. It runs from a Composer project, which `dev url` needs anyway.
- **`prisma emulator list`** needs no project and no config, so it cannot go through the seam. Its handler lives in the Prisma Cloud domain next to the emulator client, and `@prisma/composer-cli` (in `9-public`, which may import `prisma-cloud`) adds it to the command family. No dependency-cruiser exception is needed.
- The emulator client stays the only module that speaks the emulators' HTTP API, so a later move out of Composer replaces one dependency.

## Ports (Will, 2026-10-13: agents in many worktrees start and stop environments)

An instance keeps its port from creation until it is deleted, running or stopped. A deployment carries its port inside the service's environment (`COMPOSER_<ADDRESS>_PORT`) and in its dependents' URLs, and Alchemy's no-op reconcile on a warm start never redeploys, so a port that could change between sessions would leave services built for the old port. Releasing ports on stop was considered and dropped for that reason (implementer finding, S1a dispatch 1). The cost: instances left behind by deleted worktrees keep their ports until the later remove command deletes them.

Composer remembers each node's port in the directory's mapping and requests it only when it has to create the instance again, for example after the emulator lost its state. A requested port is a preference: if another instance or process holds it, the emulator gives the lowest free port from 3000 and `prisma dev` prints one line saying the port changed. Failing instead would break an agent's `prisma dev` whenever another worktree happened to take the port. On a first start, ports still go in dependency order (prisma/composer#350).

## Labels Composer writes

`composer.directory` (absolute path), `composer.app` (app name), `composer.address` (node address). `emulator list` shows them; nothing reads them back as identity.

## Output shapes

- `dev url`, human: the URL alone on stdout's data line, so `--format human` also works in `$(…)`. JSON `result`: `{ address, kind, url, state }`, where `kind` is `service | database | bucket` and `state` is the service status, or `running` for a database or bucket whose emulator is up.
- `emulator list`, JSON `result`: `{ emulators: [{ kind, running, url, instances: [{ id, kind, url, state, labels }] }] }`. Human: one block per emulator, instances listed under it with the address and directory from their labels when present. It doesn't fit the list convention's `{ name, id, status }` items, because two levels are nested. That is a deliberate departure, noted in the slice spec.

## Error codes (namespace `DEV` for `dev url`, new `EMULATOR` for `emulator list`)

- `DEV.NOT_STARTED_HERE`: no `prisma dev` has run in this directory (no mapping). Fix: run `prisma dev <entry>` here.
- `DEV.ADDRESS_UNKNOWN`: no node with that address in this directory's app; lists the known addresses.
- `DEV.EMULATOR_UNREACHABLE` (from #353): the node's emulator is not running or not answering.
- `DEV.SERVICE_NOT_RUNNING`: the service exists but is stopped, backing off or held; says which, and points to `prisma dev`.
- `EMULATOR.*`: only if `list` needs one beyond `DEV.EMULATORS_DIR_INVALID` and `DEV.EMULATOR_UNREACHABLE`. Final names are fixed in the slice specs and recorded in ADR-0044.

## Alternatives considered

- **`prisma emulator url <address>`.** Same behaviour, but `url` asks a Composer question about this directory's app, which belongs under `dev`.
- **Rename the run command to `prisma dev start`.** Avoids the engine change, but breaks every `prisma dev module.ts` and reverses ADR-0050's root verb.
- **Name the app on the command line (`url my-app gateway`) or with `--app`.** Addresses are meant relative to the local app, and names collide across directories.
- **Make the local identity "app name + directory hash" and keep app-aware emulators.** Fixes collisions but keeps Composer concepts inside the emulators, which is the opposite of the model.
- **`emulator list` through the core seam.** Requires a project and config for a machine-level command.
- **Print a bare URL even when piped.** An engine output change Will deferred.

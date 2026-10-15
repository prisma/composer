# ADR-0053: `prisma dev url`, `prisma dev stop`, `prisma dev --detach` and `prisma emulator list`

## Decision

Composer's command family ships three more commands and a `--detach` flag on `prisma dev`, and `@prisma/composer/control` two more operations and a `detach` option behind them:

```bash
$ prisma dev module.ts        # terminal 1: runs the app
$ prisma dev url gateway      # terminal 2: where a node of that app answers
http://localhost:3001
$ url=$(prisma dev url gateway | jq -er 'select(.kind=="result").envelope.result.url') && curl "$url"
$ prisma dev stop             # stops this directory's app: services and database servers; data stays
$ prisma emulator list        # every local emulator on this machine and every instance on it
$ prisma dev module.ts --detach   # returns once every service answers; the app keeps running
$ prisma dev stop                 # the only thing that stops a detached app
```

- **`dev url <address>`** prints where a node of the app `prisma dev` runs from the current directory answers: a service's `http://localhost:<port>`, a database's connection string, or a bucket's S3 endpoint plus `/<bucket>`. Its JSON result is `{ address, kind, url, state }`. In human format the URL alone goes to stdout, so `$(prisma dev url gateway --format human)` is the URL. It is the `devUrl` operation.
- **`dev stop`** stops that app's service processes and database servers, as ending `prisma dev` does, for a `prisma dev` that was killed without the chance. Data and ports stay. It is the `devStop` operation, and returns `{ app, stopped }`.
- **`emulator list`** lists the local emulators — the programs `prisma dev` starts to run services, databases and buckets on this machine — whether each runs, its admin URL, and its instances with id, kind, URL, state and labels. It needs no project. Its JSON result is `{ emulators: [{ kind, running, url, instances: [{ id, kind, url, state, labels }], error }] }`. `url` is `null` for an emulator that is not running. `error` is `null` unless the emulator runs but could not be listed; then it is `{ code, message }`, with `DEV.EMULATOR_UNREACHABLE` when the emulator did not answer and `DEV.EMULATOR_FAILED` when it answered with an error, and the other emulators are still listed. The command uses the emulator client bundled into `@prisma/composer-cli`, because it must work without a project.
- **`dev --detach`** runs `prisma dev` up to `ready`: it converges, waits until every service accepts connections, prints the front door and exits 0. It starts no watch loop and installs no stop on exit, so the app keeps running until `prisma dev stop` or the next `prisma dev` in the directory, which reconverges as usual. A failure before ready stops what the run started and exits non-zero, as the foreground run does; a Ctrl-C before ready stops the app. It combines with `--fresh` and `--name`. It is the `dev` operation's `detach` option, whose session is already closed and whose `stop()` stops nothing. A foreground `prisma dev` started while the app runs detached takes it over: it converges, which changes nothing, watches, and its Ctrl-C stops the app.

The family keys each command by the path it is meant to mount at (`dev url`, `dev stop`, `emulator list`); the `prisma` CLI decides where it mounts them. This amends [ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md), under which the family was exactly `deploy` and `dev`, and [ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md), whose `control` subpath had four operations.

## Reasoning

Docs, scripts and agents need to reach a locally running node without assuming its port. Ports are assigned in dependency order from 3000 and kept per directory ([ADR-0052](ADR-0052-composer-maps-its-nodes-to-emulator-instances-per-directory.md)), so `localhost:3001` is right for one app in one directory and wrong for the next. The directory's record already says which instance runs each node; these commands read it.

`dev url` and `dev stop` act on the app `prisma dev` *last ran from the directory*, without an entry or a build. The configuration does not name the app ([ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md)), so the record is the only source. They still go through the core local-target seam, so core stays target-agnostic: `LocalTargetDescriptor` gains an optional `current({ devDir })`, which returns the recorded app's name, its addresses, `locate(address)` and `stop()`. The Prisma Cloud target implements it from `emulator-instances.json`; core never reads the record. Core turns what a target returns into the failures a user can act on:

| Situation | Code |
| --- | --- |
| No extension recorded an app in the directory | `DEV.NOT_STARTED_HERE` |
| The app has no node at the address (the known ones are listed) | `DEV.ADDRESS_UNKNOWN` |
| The emulator the node runs on is not running | `DEV.EMULATOR_UNREACHABLE` |
| The node exists but is not running (its state is named; the reason and fix depend on it: a stopped node needs `prisma dev`, a crash-looping service needs its log read, a node its emulator lost is created again by `prisma dev`) | `DEV.NOT_RUNNING` |
| The target fails without a code of its own | `DEV.EMULATOR_FAILED` |

`dev url` reports a node only when it is running, so every URL it prints answers. That relies on a service being `running` only once its port accepts connections.

`emulator list` is a question about the machine, not a project: it needs no `prisma.config.ts`, so it cannot go through the seam, which starts from the configuration, and it cannot load the project's `@prisma/composer-prisma-cloud`, because there may be no project. Its operation lives in the Prisma Cloud domain beside the emulator clients, and `@prisma/composer-cli`, a public package that may import both domains, adds the command to the family and bundles that client. Nothing running is a valid answer: every emulator is listed with `running: false`.

`prisma dev` stays in the foreground by default, watching, with Ctrl-C stopping the app, because a developer at a terminal wants rebuilds picked up and one key to end the session. Agents, scripts and CI want the opposite: no long-running process to manage, and an app that answers once the command returns. `--detach` gives them that, and `dev url` and `dev stop` already give them the rest. The tools developers already use have the same split: Docker Compose (`up` and `up -d --wait`), .NET Aspire (`run` and `run --detach`), Laravel Sail (`up` and `up -d`) and Prisma ORM's own `prisma dev` (`--detach`) all default to the foreground with detach as an opt-in.

## Consequences

- `@prisma/composer/control` has six operations: `deploy`, `destroy`, `dev`, `devUrl`, `devStop`, `log`.
- `prisma dev` is both a command and a group. The CLI engine supports that from `@prisma/cli-engine` 0.8.0; the family itself is built against 0.7.0, because it only exports commands and does not mount paths. The `dev` command's description defines the terms its children rely on: an emulator, a node's address, and that the app is recorded in the directory.
- `emulator list`'s JSON departs from the list convention (`{ context, items, count }` with `{ name, id, status }` items): it nests two levels, emulators and their instances, because an instance is meaningless without the emulator that holds it.
- The emulators are started by the project's `@prisma/composer-prisma-cloud`, but `emulator list` reads them with the client bundled into the `prisma` CLI's `@prisma/composer-cli`, which can be a different Composer version. The emulators' registry files (`<emulators directory>/<name>.json`) and their instance-list routes (`GET /instances` on the Compute and Postgres emulators, `GET /_pcdev/instances` on the bucket emulator) are therefore a contract across Composer versions: a change to them must stay backward compatible.
- Database URLs are connection strings with local credentials, printed on purpose; a bucket's access keys are never printed.
- `prisma emulator start` and `prisma emulator stop`, and removing instances left by deleted directories, are planned and not part of this decision.

## Alternatives considered

- **`prisma emulator url <address>`.** The same behaviour, but `url` asks a question about this directory's app, which belongs under `dev`; `emulator` commands act on the machine.
- **A top-level `prisma url`.** Ambiguous between a local node and a deployed one.
- **Renaming the run command to `prisma dev start`.** Avoids a command that is also a group, but breaks every `prisma dev module.ts` and reverses ADR-0050's root verb.
- **Naming the app on the command line (`url my-app gateway`) or with `--app`.** Addresses are relative to the directory's app, and app names collide across directories.
- **`emulator list` through the core seam.** Would require a project and a configuration for a question about the machine.
- **Printing a bare URL even when stdout is piped.** Would change the CLI's rule that a piped stdout carries JSON frames; scripts use `jq` or `--format human` instead.

- **Detached by default, with a `--watch` or `--attach` flag for the foreground.** Matches what agents need, but differs from every tool above and from what `prisma dev` does today, and leaves an app running after a developer closes the terminal.
- **A run-then-stop mode (`--exec "<cmd>"`, like Firebase `emulators:exec`).** Useful for CI, and compatible with `--detach`; not part of this decision.

## Related

- [ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md) — the commands Composer ships; amended here.
- [ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md) — the programmatic operations; amended here.
- [ADR-0052](ADR-0052-composer-maps-its-nodes-to-emulator-instances-per-directory.md) — the per-directory record these commands read.
- [ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md) — the codes above are registered there.
- [local-dev.md](../10-domains/local-dev.md) — the mechanics.

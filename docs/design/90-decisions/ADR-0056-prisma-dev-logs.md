# ADR-0056: `prisma dev logs` reads the local app's service logs

## Decision

Composer's command family ships `dev logs [address]`, and `@prisma/composer/control` a `devLogs` operation behind it:

```bash
$ prisma dev module.ts                    # terminal 1: runs the app
$ prisma dev logs                         # terminal 2: every service's last 100 lines, then exit
[catalog.service] listening on 3000
[storefront] GET / 200 in 41ms
$ prisma dev logs storefront --tail 20    # one service, unlabelled
GET / 200 in 41ms
$ prisma dev logs --follow                # keep printing new lines until Ctrl-C
```

- **What it reads.** The services of the app `prisma dev` last ran from the current directory, as `dev url` and `dev stop` do ([ADR-0053](ADR-0053-dev-url-dev-stop-and-emulator-list.md)): no entry, no build, nothing started or stopped. With an address, that one service; without, every service.
- **How much.** By default it prints each service's last 100 lines and exits, as `prisma service logs` does for a deployed service. `--tail <n>` sets the count. `--follow` keeps printing new lines, including from services a later converge adds, until Ctrl-C, which settles 130 like every interrupted `prisma` command.
- **Output.** Log lines are the command's data, on stdout; everything else is on stderr. Without an address, each line is prefixed `[address] `; with one, lines are bare. Without `--follow`, every line of one service comes before the next service's, in address order, because the per-service logs carry no timestamps to interleave by; with it, lines print as they arrive. `--json` writes each line as an engine `output` frame whose `data` is `{ service, line }`, then the result frame.
- **Failures.** `DEV.NOT_STARTED_HERE`, `DEV.ADDRESS_UNKNOWN` and `DEV.EMULATOR_UNREACHABLE` as for `dev url`. `DEV.NOT_RUNNING` for a service its emulator lost. New: `DEV.NO_LOGS` for an address that names a database or a bucket, and `DEV.LOGS_UNSUPPORTED` when the app's local target cannot read without following (below). A service that is stopped or crash-looping is read, not refused: its log holds the run that failed, which is what the user came for.
- **The front door.** `prisma dev` prints `logs: prisma dev logs` after the service URLs, and reports it as a `run-command` remediation for agents. `dev` itself still does not stream service output.
- **The seam.** `devLogs` resolves the directory's record through `current()`, then attaches to each recorded app through the existing `attach()` with a container from `container.ensure({ appName })`, so core still never reads a target's record or an emulator's API. `LocalTargetAttachment` gains an optional `readLogs({ tail, signal })`: each service's last `tail` lines without following. The Prisma Cloud target answers it from the compute emulator's existing non-follow `GET /instances/<id>/logs`. `--follow` uses the attachment's `logs()`, as the `log` operation does.

This amends [ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md), which left logs as an operation because their place in the command tree was undecided, and [ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md), whose `control` subpath gains a seventh operation. The `log` operation stays, unchanged.

## Reasoning

ADR-0050 counted script-only logs as the decision's main cost and accepted it "until teardown and logs get a place in the `prisma` command tree". The cost was real: a user's `console.log` in a route handler went nowhere they could find, `dev` deliberately prints none of it (it buried the front door when it did), and the only way to read it was a script or `tail -f` on a file under `~/.prisma-composer`. Agents, which Composer is built for first ([guiding principles](../01-principles/guiding-principles.md)), had to write that script before they could see why a request failed.

ADR-0050 rejected mounting `log` because the CLI already has `prisma service logs` for deployed services and a Composer logs command "would probably need renaming once that is decided". `dev logs` settles that for local logs: it sits under `dev` beside `dev url` and `dev stop`, which already mean "the app `prisma dev` runs from here", so it cannot be read as a deployed service's logs, and `service logs` keeps that meaning. Where a combined local-and-deployed `prisma logs` would go is left open; `dev logs` does not preclude it.

The flags and defaults copy `prisma service logs` (`--tail`, default 100, `--follow`, no follow by default) so the two log commands read the same. A command that exits by default also suits agents and scripts, which then need no signal to stop it.

`readLogs` is optional on the seam because the `prisma` CLI's Composer and the app's `@prisma/composer-prisma-cloud` can be different versions. A target without it would otherwise be asked to follow, and the command would never end. Core refuses instead, with a code that says to upgrade or follow.

## Consequences

- `@prisma/composer/control` has seven operations: `deploy`, `destroy`, `dev`, `devUrl`, `devStop`, `devLogs`, `log`. The `prisma` CLI renders all but `destroy` and `log`. The operations double in `@prisma/composer-cli/testing` gains `devLogs`.
- The `prisma` CLI must mount `dev logs` and cover it with a real end-to-end test, so the release is the usual Composer publish, then a `prisma` release that mounts the new command.
- The compute emulator's non-follow logs route is now read across Composer versions, through the app's target. It must stay backward compatible, as the instance-list routes already must.
- ADR-0050's lint against the retired binary name is unaffected; `prisma dev logs` names the `prisma` binary.
- Not decided here: streaming logs inline with an explicit `prisma dev --logs`. It would interleave with the deploy engine's output, which the engine buffers while the converge child owns the terminal, so it needs its own design.

## Alternatives considered

- **Mount the existing `log` operation as `prisma logs <entry>`.** Needs an entry the user has already given to `prisma dev`, follows by default, and a top-level `logs` is ambiguous between local and deployed.
- **A top-level `prisma logs` with local and remote modes.** Possibly where the CLI ends up, but it would decide the deployed-logs grammar too, which is not Composer's to decide.
- **Follow by default, like `log` and `docker compose logs -f`.** Differs from `prisma service logs`, and a command that never ends by default is the wrong default for agents.
- **Interleave the non-follow read across services.** The per-service logs have no timestamps, so any interleaving would be invented. Grouping is honest.
- **Read the log file directly from core through `LocalNodeLocation.logPath`.** Avoids a seam change, but makes core read a target's files, and two mechanisms for one command.
- **Stream logs inline in `prisma dev` again.** Reverts 9cb12882, which removed it because it drowned the front door and the rebuild notices.

## Related

- [ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md) — left logs as an operation; amended here.
- [ADR-0053](ADR-0053-dev-url-dev-stop-and-emulator-list.md) — `dev url` and `dev stop`, whose `current()` seam and codes this reuses.
- [ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md) — the programmatic operations; amended here.
- [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md) — the attachment this extends.
- [local-dev.md](../10-domains/local-dev.md) — the mechanics.

# S6 — `prisma dev --detach`

Repo: prisma/composer. Branch `feat/dev-detach`, stacked on `feat/emulator-commands` (prisma/composer#357).

## At a glance

```bash
$ prisma dev module.ts --detach       # returns once every service answers
dev: ready
gateway: http://localhost:3001
quotes: http://localhost:3000
$ curl "$(prisma dev url gateway)"    # same terminal
$ prisma dev stop                     # the only thing that stops a detached app
```

Will ruled on 2026-10-15 that `prisma dev` stays in the foreground, watching, and Ctrl-C stops the app, as today. `--detach` is opt-in.

This follows prior art: Docker Compose `up -d --wait`, .NET Aspire `run --detach`, and Prisma ORM's own `prisma dev --detach`. Agents and scripts use `--detach` so they don't have to manage a long-running foreground process.

## Chosen design

- `--detach` runs the same pipeline as `prisma dev` up to "ready": converge, wait for every service to accept connections (prisma/composer#353), and print the front door. Then it exits 0.
- A detached run starts no watch loop and installs no stop-on-exit.
- The app keeps running on the emulators until `prisma dev stop`, or until the next `prisma dev` in the directory, which reconverges as today.
- A failure before ready stops what this run started, exactly as the foreground path does, and exits non-zero with the same error.
- Ctrl-C before ready stops the app and exits, as today.
- `--detach` combines with `--fresh` and `--name`.
- The `dev` operation in `@prisma/composer/control` gains an equivalent option. The command renders it, per the rule that the CLI's commands are thin renderers over the operations. The session handle's `stop()`, `closed` and events behave sensibly for a detached session: it is already closed and owns nothing.
- Running `prisma dev` in the foreground while the app is already running detached just takes over. It converges, which is a no-op when nothing changed, watches, and Ctrl-C stops the app. No special case.

## Docs

- Update the ADR that records `dev url`, `dev stop` and `emulator list` in place, since it is unreleased: `--detach` and why foreground stays the default, with the prior-art comparison as the alternative.
- `local-dev.md`: the session lifetimes section.
- The running-locally guide and the core-concepts skill: a "run it in the background" subsection. Agents and CI use `--detach` then `prisma dev stop`.
- The `dev` command's help: a `--detach` flag brief that meets prisma-cli's help standard.

## Slice-specific done conditions

- [ ] Against real emulators in a temporary directory, `prisma dev --detach` exits 0 once every service answers, and the services keep answering after it exits.
- [ ] `prisma dev stop` then stops them.
- [ ] A detached run that fails before ready leaves nothing of the app running.

## Out of scope

A run-then-stop mode (`--exec "<cmd>"`, like Firebase `emulators:exec`). Record it in `deferred.md` as a likely next step for CI.

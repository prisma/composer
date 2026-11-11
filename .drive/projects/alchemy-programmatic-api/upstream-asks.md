# Upstream asks (drafts for Will to send)

## Alchemy: let `Alchemist.plan` take config values

Superseded by slice 4: deploy no longer passes a token to Alchemy. The Prisma providers take a `PrismaEnvironment` without a token and an `HttpClient` that sends requests through the engine's client (alchemy-run/alchemy#3101, alchemy-run/distilled#1076). Do not send.

We call `Alchemist.plan` / `apply` inside the `prisma` CLI. Your Prisma provider reads `PRISMA_SERVICE_TOKEN` through Effect `Config`, and `Alchemist.layer()` builds config only from `process.env` and `.env`. When a user signs in with `prisma login`, the token lives in our credential store, not the environment, so today we would have to write it into `process.env` for the run.

Ask: let callers pass config, for example `Alchemist.layer({ config: ConfigProvider.fromMap(...) })` or a `config` record on `plan`, layered over the environment.

## `@prisma/cli-engine`: an in-process credentials need

Withdrawn by slice 4: handing the token to a command would break the engine's credential rules (no token in command code, `ctx.api` the only client, no change to `process.env`). Deploy uses `ctx.api` instead. Do not send.

`needs: { credentials: 'child' }` writes `PRISMA_SERVICE_TOKEN` and `PRISMA_WORKSPACE_ID` into a spawned child's environment, and a handler never sees the credential. Composer is moving Alchemy from a child process into the `prisma` process, so there is no child to receive it.

Ask: a credentials need for in-process use, for example `needs: { credentials: 'process' }`, that gives the handler the active access token (refreshed if needed) and the workspace id.

## Alchemy: export what an embedding host needs from `alchemy/Alchemist`

Composer imports two modules through Alchemy's `./*` wildcard export, which is not a stable surface:

- `alchemy/Util/LogRecord` (`recordOf`), to turn Alchemy's log lines into our own events. Ask: expose log lines as typed `Alchemist` events.
- `alchemy/Interaction` (`layerNonInteractive({ stdout })`), so Alchemy's own messages go to stderr and `--json` stdout stays clean. Ask: let `Alchemist.layer()` take an output stream.

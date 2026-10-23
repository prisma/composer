# A3 QA: the entry lives in the config

Run on 2026-10-23 on branch `drive/deploy-entry-in-config` at `1bdd405f`, after `pnpm install` and `pnpm build`. Commands used the workspace's `prisma` (`bun ../../node_modules/.bin/prisma`, as the example's scripts do), with credentials from `~/.config/prisma-compose/deploy.env` and `PRISMA_REGION=us-east-1`. Logs are in `wip/qa-a3/` of this worktree, which git ignores. No secret values are recorded here.

**Verdict:** every check passed.

The app is `examples/storage`, used in place. Its `prisma.config.ts` has `entry: './module.ts'`, and its root module is `storage-example`.

## Step 1. Deploy from the config's entry

| Check | Result | Evidence |
|---|---|---|
| `prisma deploy --name qa-a3-4ca9r0` from `examples/storage`, with no entry argument | PASS | "Deployed qa-a3-4ca9r0 to production". It created Project `proj_vs7kdo4y09kzwcuztkn3shh1` with `qa-a3-4ca9r0.storage.db` (`db_g3armpvzim0y20jddcdabw7a`), `qa-a3-4ca9r0.storage.service` and `qa-a3-4ca9r0.blobs` (`cps_hdhuig86otxi183urfnrhppf`). |
| The service answers | PASS | `/health` returns the blob store banner. `PUT /blobs/qa-a3.txt` returns `size: 8`, and `GET` returns `hello-a3`. |
| The same deploy from `examples/storage/src/blobs` | PASS | It found `prisma.config.ts` and its `entry` from the subdirectory. It planned 13 updates and 2 replaces (the two Deployments) on the same resource ids, and created nothing new. The blob written before is still served. |

## Step 2. `--entry` overrides the config

| Check | Result | Evidence |
|---|---|---|
| `prisma deploy --entry qa-a3-other.ts` deploys that module | PASS | `qa-a3-other.ts`, a temporary file in `examples/storage`, exports the root module `qa-a3-other-grpzno`. The deploy created Project `qa-a3-other-grpzno` (`proj_are8u63veea3aylj69u608bl`) with `qa-a3-other-grpzno.storage.db`, `qa-a3-other-grpzno.storage.service` and `qa-a3-other-grpzno.blobs`. Its service answers. No `storage-example` Project was created, so the config's module was not used. |
| Cleanup | PASS | I deleted that Project with `prisma project delete`, and the API now returns `resource-not-found` for it. I removed the temporary file, and `git status` shows no change under `examples/storage`. |

## Step 3. Errors

These ran in `wip/qa-a3/noentry`, a copy of the example whose `node_modules` links to the example's.

| Check | Result | Evidence |
|---|---|---|
| No `entry` in the config and no `--entry` | PASS | The command exits with code 2, and the output is `✘ [CONFIG.ENTRY_MISSING] No entry module is set, so there is no app to load.` The fix line names both ways to set it: `entry: './module.ts'` in the `composer` section of prisma.config.ts, or `--entry <path>`. It fails in "load config and app" after 2 ms, before any "connect to project and branch" step. The same error appears with the platform credentials unset. No Project was created. |
| `prisma deploy module.ts` (a leftover positional) | PASS | The output is `✘ [CLI.INVALID_ARGUMENTS] Too many arguments, expected 0 but encountered "module.ts"`, from the CLI engine. |
| `entry` set to a missing file | PASS | The output is `✘ [COMPOSE.ENTRY_UNLOADABLE] Failed to import entry module ".../noentry/does-not-exist.ts"`. The fix line says ``Check `entry: "./does-not-exist.ts"` in .../noentry/prisma.config.ts. It is relative to that file's directory.`` |

I made one mistake along the way. My first attempt to remove `entry` from the copy did not remove it. That run loaded the entry and got as far as contacting the platform, where it stopped with `DEPLOY.CONTAINER_FAILED` because no region was set. It created nothing, and the API lists no `qa-a3-noentry` Project. That run is not evidence for any check above.

## Step 4. Local dev

| Check | Result | Evidence |
|---|---|---|
| `prisma dev --detach` from `examples/storage` with no entry | PASS | "dev: ready". It started `storage-example.blobs` on `http://localhost:3084` and `storage-example.storage.service` on `:3083`. The root name `storage-example` comes from the config's `module.ts`. |
| `prisma dev url storage-example.blobs` | PASS | It printed `http://localhost:3084`. A blob was written and read back. The short address `blobs` fails with `DEV.ADDRESS_UNKNOWN` and lists the full addresses. |
| `prisma dev stop` leaves nothing running | PASS | "Stopped storage-example". Ports 3083 and 3084 and the local database port 51963 no longer listen, and the service processes 51703 and 51742 are gone. The shared compute and postgres emulators on 4316 and 4302 started at 15:11, before this QA run, so I left them alone. |

## Step 5. Teardown

| Check | Result | Evidence |
|---|---|---|
| Every Project deleted | PASS | I deleted `qa-a3-4ca9r0` (`proj_vs7kdo4y09kzwcuztkn3shh1`) and `qa-a3-other-grpzno` (`proj_are8u63veea3aylj69u608bl`) with `prisma project delete <id> --confirm <id>`. `prisma project list` shows no `qa-a3` Project. `GET /v1/projects/<id>` returns `resource-not-found` for both. |

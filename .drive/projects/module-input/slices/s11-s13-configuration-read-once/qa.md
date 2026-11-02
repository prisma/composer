# S11 to S13 manual QA

Run on 2026-11-02 against a local build of `@prisma/cli-engine` 0.10.0 from prisma/prisma-cli#383 at `44526435`, placed at `node_modules/@prisma/cli-engine` by a symlink that is not committed. The `prisma` host is the published 8.0.0-rc.26.

## Not run here

Steps 1, 2, 3, 4 and 6 deploy to Prisma Cloud. They are a separate step after review and were not run.

## Step 5, `prisma dev`, run locally

Setup: `pnpm build`, `pnpm turbo run build --filter @prisma/example-email...`, then `examples/email/.env.dev` with `EMAIL_DELIVERY_MODE=none` and `EMAIL_FROM=dev-qa@example.com`, and `.env.dev.local` with `EMAIL_DELIVERY_CREDENTIAL` set to a generated `s13qa-…` value. Run as `node ../../node_modules/.bin/prisma dev --detach`, because under Bun the 0.10.0 engine fails (see below).

Result: `prisma dev` did not start. The emulators came up, then the CLI exited with status 137. In `--format json` the result is `CLI.CHILD_PROCESS_FAILED`, "The delegated process was terminated by SIGKILL", about six seconds after the start.

Cause: the 0.10.0 engine asks the host's spawn adapter for `output: "engine"`. The published `prisma` 8.0.0-rc.26 bin injects the 0.9.0 adapter, which does not pipe the child's output, so the engine kills the child at once (`refuseUnpipedChild` in the engine's `execution/spawn.ts`). #383 changes that adapter in `packages/cli/src/spawn.ts`, so the step needs a `prisma` host release that ships it.

What still held:

- `.prisma-composer/dev/dev/configuration.json` did not exist after the run.
- `grep -r` for the secret value over `.prisma-composer` and `.alchemy` found nothing.
- Nothing printed the secret: the child was killed before it wrote any output.

Clean-up: `prisma dev stop` reported nothing running, `.env.dev`, `.env.dev.local` and `examples/email/.prisma-composer` were deleted, and `git status` shows only this PR's changes. No emulator was stopped, because the daemons are shared with other worktrees.

## Bun and the 0.10.0 engine

At `44526435` the engine's spawn path called `ReadableStream.from`, which Bun 1.3.13 does not have, so under Bun every converge through the engine failed with `CLI.INTERNAL_ERROR`, and 19 CLI unit tests failed. #383 fixed it in `d71da9ba`. With the engine rebuilt from that commit, all 445 CLI tests pass under Bun with no preload.

## Before step 5 and the hosted steps can run

They need a `prisma` host release that ships #383's spawn adapter. The spec's release-order note says so.

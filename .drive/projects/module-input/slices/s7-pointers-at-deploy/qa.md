# S7 manual QA

Run 2026-10-30 against Prisma Cloud (`PRISMA_REGION=us-east-1`), with the repo's deploy credentials, after `pnpm build`. Every deploy ran as `pnpm run deploy`, because `pnpm deploy` is pnpm's own command.

## 1. Nothing to collide with

The Project list, before the run:

```text
false
env-param-example
composer-docs
bucket-example
storage-qa-bunbuild
asks
prisma-composer-state
```

`hasMore` is `false`, and no Project is named `auth-example`. None of these was touched.

## 2. The auth example, deployed

In `examples/auth`, with `EMAIL_DELIVERY_MODE`, `EMAIL_FROM` and `EMAIL_DELIVERY_CREDENTIAL` unset in the shell: `cp .env.example .env`, then `PRISMA_DEPLOY_ENV="$HOME/.config/prisma-compose/deploy.env" PRISMA_REGION=us-east-1 pnpm run deploy` succeeded:

```text
✔ load config and app (36ms)
✔ assemble auth-example.mail.service (37ms)
✔ assemble auth-example.auth.service (18ms)
✔ assemble auth-example.api (18ms)
✔ assemble auth-example.ops (24ms)
✔ assemble services (97ms)
✔ connect to project and branch (6.5s)
✔ check environment variables (677ms)
✔ plan and apply (1m 4s)
✔ record result (308ms)
✔ Deployed auth-example to production in 1m 12s.
```

## 3. It serves

`pnpm run smoke:deployed` passed every check:

```text
ok   - health: api and ops answer
ok   - signup through the proxied /api/auth/sign-up/email
ok   - login is rejected until the outbox link is followed (requireEmailVerification)
ok   - ops’s find-sent-email route reads the verification email back through the outbox port
ok   - following the outbox link verifies the address
ok   - login returns a bearer token and a session token
ok   - /api/auth/token mints a JWT for the bearer session
ok   - /me verifies the JWT statelessly
ok   - the session port answers through the api service
ok   - the ops service finds the user through the admin port
ok   - revokeUserSessions through the ops service revokes the session
ok   - getSession is now null — instant logout through the port
ok   - /me STILL verifies — stateless JWTs outlive revocation until expiry
ok   - a signed-in user deletes their own account through the proxy
ok   - removeUser through the ops service is idempotent on a deleted account
15 passed, 0 failed
```

The verification link the smoke test follows starts with the api service's deployed origin, so `serviceOrigin('auth-example.api')` reached the auth service through `auth()`'s wrapped `baseUrl`. The auth service's instance secret, a redacted `generatedParam()`, was read at boot through its `secretString()` field, which the deploy's second check passed.

## 4. `prisma dev` of the auth example: not run to completion

`.env` was removed and `.env.dev` held `EMAIL_DELIVERY_MODE=none`, `EMAIL_FROM=s7-qa-auth-dev@example.com` and `EMAIL_DELIVERY_CREDENTIAL=local-dev-unused`. `prisma dev --detach` failed before any service started:

```text
✘ [DEV.EMULATOR_FAILED] ensuring the local instance for database "auth-example.database" failed: request to the local dev emulator failed (500): postgres emulator failed to start database "pcdev-db_cc2ac92745e67f28" on port 52493: ENOENT: no such file or directory, copyfile '…/wip/s7/wip/proto/node_modules/@prisma/dev/dist/runtime-assets/initdb.wasm' -> '…'
```

The machine-wide postgres emulator recorded in `~/.prisma-composer/emulators/postgres.json` was started at 12:59 from a scratch copy under this worktree's git-ignored `wip/proto`, which has since been deleted, so it cannot create a database. Stopping it was not permitted in this run. `pnpm test`'s `@prisma/integration-tests` local-dev scripts fail on the same error. The step needs a rerun once that emulator is stopped. `prisma dev stop` confirmed nothing had started, and `.env.dev` was removed.

## 5. Tear down

`cp .env.example .env`, then `PRISMA_DEPLOY_ENV="$HOME/.config/prisma-compose/deploy.env" PRISMA_REGION=us-east-1 pnpm run destroy`:

```text
Removed the Project (proj_zjkbszojsn3p4dbl2z5o9152) — nothing was left in it.
Destroyed.
```

`.env` was removed. The Project list afterwards is the one step 1 recorded, line for line. `git status` showed no changes outside this slice's commits.

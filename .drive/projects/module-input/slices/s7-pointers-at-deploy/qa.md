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

## 4, rerun: `prisma dev` of the auth example

Rerun 2026-10-30 after Will stopped the stale postgres and buckets emulators. `pnpm build` was fully cached, so `dist` was current. The compute emulator recorded in `~/.prisma-composer/emulators/compute.json` was still running, started by another session from its own scratch folder, which still exists; it was left alone and `prisma dev` reused it. `prisma dev` started a fresh postgres emulator from this worktree's `packages/9-public/composer-prisma-cloud/dist/postgres-main.mjs`.

In `examples/auth`, with no `.env` and the three email variables unset in the shell, `.env.dev` held `EMAIL_DELIVERY_MODE=none`, `EMAIL_FROM=s7-qa-auth-dev@example.com` and `EMAIL_DELIVERY_CREDENTIAL=local-dev-unused`. `prisma dev --detach`:

```text
Done: 46 succeeded (1.9s)
dev: ready
auth-example.api: http://localhost:3222
auth-example.ops: http://localhost:3223
auth-example.auth.service: http://localhost:3221
auth-example.mail.service: http://localhost:3220
```

`prisma dev url auth-example.api` printed `http://localhost:3222`, and `prisma dev url auth-example.ops` printed `http://localhost:3223`. `POST http://localhost:3222/api/auth/sign-up/email` for `s7-qa-dev-user@example.com` returned 200 with the new user. `POST http://localhost:3223/admin/find-sent-email` with `{"to":"s7-qa-dev-user@example.com","templateId":"verification"}` returned 200:

```text
"from":"s7-qa-auth-dev@example.com"
"subject":"Verify your email address"
"text":"http://localhost:3222/api/auth/verify-email?token=…&callbackURL=%2F"
```

The `from` is the `.env.dev` value, and the link starts with the api service's dev URL. `prisma dev stop` printed `Stopped auth-example in the environment dev.` `.env.dev` was removed, and `git status` was clean.

## The integration tests' local-dev scripts, rerun

`pnpm run test` in `test/integration` (`@prisma/integration-tests`) exited 0: `bun test` 5 pass, 0 fail, then `PASS: local dev (S4) integration proof`, `PASS: local dev (S5 proving) — examples/store, criteria 1/2/3/6`, `PASS: local dev (S5 proving) — criteria 4 and 5` and `PASS: local dev --detach`.

`pnpm turbo run test --filter @prisma/integration-tests` first ran its dependencies' tests, and `@internal/dev-emulators` failed 2 of 137 there: `a start during an instance delete leaves no process behind` and `with a 1-second readiness timeout > a service that never listens fails the deployment, is stopped, and its log says why`. Both passed when run alone, and a second full `bun test` of `@internal/dev-emulators` passed 137 of 137. They are timing failures under load, not this slice's.

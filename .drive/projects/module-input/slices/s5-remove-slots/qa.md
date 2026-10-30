# S5 manual QA

Run 2026-10-30 against Prisma Cloud (`PRISMA_REGION=us-east-1`), with the repo's deploy credentials, after `pnpm build`. Every deploy ran as `pnpm run deploy`, because `pnpm deploy` is pnpm's own command. Before the run the workspace held `asks`, `bucket-example`, `composer-docs`, `env-param-example`, `prisma-composer-state` and `storage-qa-bunbuild`; none was touched.

## 1. The email example, deployed, root input from `.env.production`

In `examples/email`, with no `.env` and with `EMAIL_DELIVERY_MODE`, `EMAIL_FROM` and `EMAIL_DELIVERY_CREDENTIAL` unset in the shell: `.env.production` held `EMAIL_DELIVERY_MODE=none` and `EMAIL_FROM=s5-qa-production@example.com`, and `.env.production.local` held `EMAIL_DELIVERY_CREDENTIAL=s5-qa-unused-credential`.

`EMAIL_STACK_NAME=s5qa-email pnpm run deploy` succeeded:

```text
✔ check environment variables (2.5s)
✔ plan and apply (37.4s)
✔ Deployed s5qa-email to production in 45.2s.
```

The command's plain output shows the preflight step without counts, so the fill was checked on the platform, as S4's QA did. The Management API lists one `EMAIL_DELIVERY_CREDENTIAL` row on the new Project, class `production`, created at `2026-10-30T02:13:51Z`, during this deploy. Only metadata was read.

`EMAIL_STACK_NAME=s5qa-email pnpm run smoke:deployed` passed, with the smoke script's fixed `s5qa-email.mailer` lookup:

```text
mailer URL: https://p2juax48h1m5iryagpma46e6.ewr.prisma.build
ok   - POST /signup (the mailer’s own endpoint) sends the verification email
ok   - GET /emails/:id reads the stored verification body back and carries the rendered link
ok   - following the rendered link (GET /verify) marks the user verified and sends the welcome email
ok   - GET /emails/:id reads the welcome email back through the outbox port

4 passed, 0 failed
```

The two `curl` calls against that URL:

```text
{"id":"84eda13f-1965-4971-b9d2-1aa9eb6bae99"}
"from":"s5-qa-production@example.com"
```

The deploy output does not contain `s5-qa-unused-credential`. `.prisma` does not exist; `grep -r s5-qa-unused-credential .prisma-composer .alchemy` finds nothing.

## 2. The root's schema stops a bad value first

With `.env.production` changed to `EMAIL_DELIVERY_MODE=smpt`, `EMAIL_STACK_NAME=s5qa-email pnpm run deploy` failed in its first step, before anything was created:

```text
✘ load config and app (210ms)
✘ [COMPOSE.GRAPH_INVALID] The input of root module "s5qa-email" does not match its input schema: EMAIL_DELIVERY_MODE must be "none", "resend" or "smtp" (was "smpt"). A root's input is the config pool: the values the `config` adapters in prisma.config.ts return for the environment "production".
```

The file was changed back to `none`.

## 3. `prisma dev` of the email example, root input from `.env.dev`

`.env.dev` held `EMAIL_DELIVERY_MODE=none`, `EMAIL_FROM=s5-qa-dev@example.com` and `EMAIL_DELIVERY_CREDENTIAL=local-dev-unused`. `prisma dev --detach` printed `dev: ready`. With `URL=$(prisma dev url email-example.mailer)` (`http://localhost:3191`), the two `curl` calls:

```text
{"id":"0674bd68-97eb-49a5-ba4b-6b9ca19d4a2c"}
"from":"s5-qa-dev@example.com"
```

`prisma dev stop` stopped both services.

## 4. The auth example, deployed

The workspace's project list held no `auth-example`. In `examples/auth`, `cp .env.example .env`; `pnpm run deploy` succeeded (`✔ Deployed auth-example to production in 1m 1s.`), and `pnpm run smoke:deployed` passed every check:

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

## 5. The storefront-auth example, deployed

In `examples/storefront-auth`, `AUTH_SIGNING_SECRET=sk_test_ci_storefront_auth STOREFRONT_STACK_NAME=s5qa-storefront pnpm run deploy` succeeded (`✔ Deployed s5qa-storefront to production in 42.3s.`), and `STACK_NAME=s5qa-storefront bash scripts/e2e-verify.sh` passed:

```text
Round trip OK — storefront rendered auth.verify() -> { ok: true } AND the secret proof (secretCheck -> { ok: true })
```

## 6. Tear down

Each destroy ran with its example's `.env` files still in place:

- `EMAIL_STACK_NAME=s5qa-email pnpm run destroy`: `Removed the Project (proj_rgfhgklu6o2j0mhnzpfkbng9) — nothing was left in it.` `Destroyed.`
- `pnpm run destroy` in `examples/auth`: `Removed the Project (proj_qtcjhrd8jflr8704iypyomz8) — nothing was left in it.` `Destroyed.`
- `STOREFRONT_STACK_NAME=s5qa-storefront pnpm run destroy`: `Removed the Project (proj_f9ghu1f3ig2hw9m99qr0g0dt) — nothing was left in it.` `Destroyed.`

Then `examples/email/.env.production`, `.env.production.local` and `.env.dev`, and `examples/auth/.env`, were removed. The workspace's project list is the same six projects as before the run, with no `s5qa-email`, `auth-example` or `s5qa-storefront`, and `git status` was clean.

# S6 manual QA

Run 2026-10-30 on a local machine, after `pnpm build`. Nothing was deployed.

## 1. The published package, outside the workspace

`pnpm pack` of `packages/9-public/composer` into a fresh directory gave `prisma-composer-0.36.0.tgz`. In that directory, after `npm init -y` and `npm install ./prisma-composer-*.tgz arktype@2.2.7 zod@4.4.3`, `npm ls zod` printed:

```text
+-- @prisma/composer@0.36.0
| `-- zod@4.4.3 deduped
`-- zod@4.4.3
```

`node check.mjs`, with the file the spec gives, printed exactly the four expected lines:

```text
from must be a string (was a number)
Invalid input: expected string, received undefined
must be a SecretString box — bind this field to a secret (was a string)
false false
```

## 2. Sources still reach a running service

In `examples/email`, with `EMAIL_DELIVERY_MODE`, `EMAIL_FROM` and `EMAIL_DELIVERY_CREDENTIAL` unset in the shell, `.env.dev` held `EMAIL_DELIVERY_MODE=none`, `EMAIL_FROM=s6-qa-dev@example.com` and `EMAIL_DELIVERY_CREDENTIAL=local-dev-unused`.

`prisma dev --detach` ended with `Done: 20 succeeded` and `dev: ready`. `prisma dev url email-example.mailer` gave `http://localhost:3204`. The signup returned an id, and reading the email back showed the configured sender:

```text
{"id":"06e1e6e6-438b-4763-91b0-9197b019b150"}
"from":"s6-qa-dev@example.com"
```

`prisma dev stop` stopped the app, `.env.dev` was removed, and `git status` showed no change outside this slice's commits.

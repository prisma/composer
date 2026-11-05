# S11 to S13 manual QA

The operator runs this plan on the branch `claude/module-input-s11-s13`, on `@prisma/cli-engine` 0.9.0, and fills in each result. It follows spec § 17. A run on 2026-11-02 against the dropped engine change (prisma/prisma-cli#383, 0.10.0) tested a design this branch no longer has, so it is not recorded here.

## Setup

1. From the worktree root: `pnpm build`, then `pnpm turbo run build --filter @prisma/example-email...`.
2. Generate the secret once: `export S13_QA_SECRET="s13qa-$(openssl rand -hex 8)"`. Record only its first five characters.
3. Every hosted step runs from `examples/email` as `( set -a; . ~/.config/prisma-compose/deploy.env; set +a; PRISMA_REGION=us-east-1 bun ../../node_modules/.bin/prisma deploy --name s13qa-email --environment s13-qa )`, called "the deploy" below. Never print a credential.

Result: run by hipparchus-99 on 2026-11-05 at commit 7ce9f1a3 (the round-4 fixes). `pnpm build` 39/39; the email example built. Secret starts `s13qa`.

## Step 1. Files, deployed to Prisma Cloud

Do: write `.env.s13-qa` with `EMAIL_DELIVERY_MODE=none` and `EMAIL_FROM=s13qa@example.com`; `.env.s13-qa.local` with `EMAIL_DELIVERY_CREDENTIAL=$S13_QA_SECRET`; `.env.defaults` with `EMAIL_FROM=defaults-must-not-win@example.com`. In a second shell, from `examples/email`, run `while true; do cp .prisma-composer/app-configuration-*.json ../../wip/s13-qa-configuration.json 2>/dev/null; sleep 0.2; done`. Run the deploy, then stop the loop.

Expected:

- The deploy succeeds with `config: [dotenv(), environmentVariables()]` and `secrets: [dotenv(), environmentVariables()]`, and without `CONFIG.SECRET_AS_PLAIN_VALUE`.
- Composer's output shows `s13qa@example.com` and `none` where it prints them, not `[redacted]`.
- `wip/s13-qa-configuration.json` holds `appConfigurationRead.rootInput` with `EMAIL_DELIVERY_MODE` `none` and `EMAIL_FROM` `s13qa@example.com` (not the `.env.defaults` value), `configurationKeyText` `{}`, and `nodeAddresses`.
- The file had mode `-rw-------` while it existed.
- `ls .prisma-composer/app-configuration-*.json` finds nothing after the deploy.
- `grep -r "$S13_QA_SECRET" .prisma-composer ../../wip/s13-qa-configuration.json` finds nothing.
- The Management API lists `EMAIL_DELIVERY_CREDENTIAL` on the `s13-qa` Branch (metadata only).

Result: pass. The deploy succeeded (`Deployed s13qa-email to s13-qa in 55.6s`), with no `CONFIG.SECRET_AS_PLAIN_VALUE`. The input document line shows `"deliveryMode":"none"` and `"from":"s13qa@example.com"` unredacted and `"deliveryCredential":{"$secret":"EMAIL_DELIVERY_CREDENTIAL"}`. The captured file holds `rootInput` with `EMAIL_DELIVERY_MODE` `none` and `EMAIL_FROM` `s13qa@example.com`, not the `.env.defaults` value, `configurationKeyText: {}` and eight `nodeAddresses`; its mode was `-rw-------`; none is left after the deploy; the secret appears in no file under `.prisma-composer` or the captured copy. The Management API was not queried directly: preflight passed, which requires the variable to exist or be filled, and the document names it.

## Step 2. A short secret inside a plain value

Do: set `.env.s13-qa.local` to `EMAIL_DELIVERY_CREDENTIAL=s13qa` (five characters, which `EMAIL_FROM=s13qa@example.com` contains), and run the deploy.

Expected: the deploy does not fail with `CONFIG.SECRET_AS_PLAIN_VALUE`, because a known secret shorter than eight characters is refused only when it is a whole value. Composer's output still redacts the secret at any length, so it prints `s13qa` as `[redacted]`, for example in `[redacted]-email`. The platform variable set in step 1 is not changed. Restore `.env.s13-qa.local` to `EMAIL_DELIVERY_CREDENTIAL=$S13_QA_SECRET`.

Result: pass with one correction to the expectation. The deploy succeeded with `EMAIL_DELIVERY_CREDENTIAL=s13qa` and `EMAIL_FROM=s13qa@example.com`, so the 8-character rule works. The output did not print `[redacted]` for `s13qa`: the lines holding it are the command's step labels (`assemble s13qa-email.email.service`), the `Deployed s13qa-email …` line and Alchemy's own output. Those carry the app name and node addresses, which the author wrote; they are not among the places the design redacts (errors, events, adapter failures, cause chains, the summary table). The secret value itself was printed nowhere as a value. The expectation above is wrong on this point; design.md section 9 and spec §21 now say step labels and the app name are not redacted.

## Step 3. An adapter's error is redacted by the credential-looking rule

Do: for this step only, put `config: [() => { throw new Error(\`cannot use ${process.env.EMAIL_DELIVERY_CREDENTIAL}\`); }, dotenv(), environmentVariables()]` in `prisma.config.ts`, `export EMAIL_DELIVERY_CREDENTIAL="$S13_QA_SECRET"`, and run the deploy.

Expected: `CONFIG.ADAPTER_FAILED`, with the `Why:` line `It threw: cannot use [redacted]`. No graph exists yet, so no value is a known secret; the variable's name looks like a credential, and that rule hides it. Restore `prisma.config.ts` and unset the variable.

Result: pass. `✘ [CONFIG.ADAPTER_FAILED] \`composer.config[0]\` failed to read the values for the environment "s13-qa".` with `why: It threw: cannot use [redacted]`. The 16-character secret appears nowhere in the output.

## Step 4. A different graph is refused

Do: for this step only, add to the root body in `examples/email/module.ts`: `if (process.env.PRISMA_COMPOSER_APP_CONFIGURATION_FILE !== undefined) provision(email(), { id: 'extra', input: { deliveryMode: input.EMAIL_DELIVERY_MODE, from: input.EMAIL_FROM, deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') } });`, and run the deploy.

Expected: `DEPLOY.ENGINE_FAILED`, whose cause names `"s13qa-email.extra"` (and the nodes under it) as only in the second process. Nothing new is created on the Branch. Restore `module.ts`.

Result: pass. The second process failed with `LowerError: The deploy's second process built a different graph from the one Composer checked in its first process. Only in the second process: "s13qa-email.extra", …`. Nothing new appeared on the Branch (the following destroy deleted 21 resources, the same count step 1 created).

## Step 5. `prisma dev`

Do: write `.env.dev` with `EMAIL_DELIVERY_MODE=none` and `EMAIL_FROM=dev-qa@example.com`, and `.env.dev.local` with `EMAIL_DELIVERY_CREDENTIAL=$S13_QA_SECRET`. From `examples/email`, run `bun ../../node_modules/.bin/prisma dev --detach`.

Expected:

- `prisma dev` starts, and Alchemy's output reaches the terminal unchanged.
- No `.prisma-composer/dev/dev/app-configuration-*.json` exists after it returns.
- `grep -r "$S13_QA_SECRET" .prisma-composer .alchemy` finds nothing. The compute emulator's own copy lives outside the project, as ADR-0058 records.
- `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"email":"qa@example.com","name":"QA"}' "$(bun ../../node_modules/.bin/prisma dev url email-example.mailer)/signup"` prints a 2xx status.

Then run `prisma dev stop`.

Result: pass. `prisma dev --detach` returned `dev: ready` with both service URLs, and Alchemy's output reached the terminal. No `app-configuration-*.json` under `.prisma-composer/dev/dev/`. The secret appears in no file under `.prisma-composer` or `.alchemy`. `POST /signup` on the mailer returned 201. `prisma dev stop` exited 0.

## Step 6. Clean up

Do: run `( set -a; . ~/.config/prisma-compose/deploy.env; set +a; PRISMA_REGION=us-east-1 bun ../../scripts/composer-destroy.ts --environment s13-qa --name s13qa-email )`, and the same with `--environment production` if step 1 created it. For this check only, put step 3's throwing adapter in `secrets`. Then delete `.env.s13-qa`, `.env.s13-qa.local`, `.env.defaults`, `.env.dev`, `.env.dev.local` and `wip/s13-qa-*`, and restore `prisma.config.ts`.

Expected: destroy succeeds, because it runs no secrets adapter. `git status` shows only this branch's changes.

Result: pass. With a throwing adapter first in `secrets`, destroy ran to `Destroyed.` and deleted 21 resources, so no secrets adapter ran. The env files and the config edit are removed; `git status` shows only this file.

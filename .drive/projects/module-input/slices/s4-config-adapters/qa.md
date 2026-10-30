# S4 manual QA

Run 2026-10-30 in `examples/env-param`, against Prisma Cloud (`PRISMA_REGION=us-east-1`), with the repo's deploy credentials.

Two changes from the spec's commands:

- `pnpm deploy` is pnpm's own `deploy` command, so every deploy ran as `pnpm run deploy`.
- The workspace already holds a project named `env-param-example`, created by an earlier session. To leave it alone, every hosted step ran with `ENV_PARAM_STACK_NAME=s4qa-env-param`, so the app deployed as `s4qa-env-param`. `prisma dev` is local, so it kept the name `env-param-example`.

## 1. Unchanged

`ENV_PARAM_GREETING=hi pnpm run deploy` deployed to `production`. `EXPECTED_GREETING=hi pnpm run smoke:deployed` passed:

```text
ok - s4qa-env-param.site is a public-url entity at echo's URL https://bizslw4ti7agbw5hc35dy4ef.ewr.prisma.build
ok - production serves greeting "hi"
ok - production serves environment "deployed to production"
ok - https://bizslw4ti7agbw5hc35dy4ef.ewr.prisma.build/logo.svg serves the entry's sibling asset — the whole tree arrived
```

`ENV_PARAM_GREETING=hi prisma dev --detach`, then `curl "$(prisma dev url env-param-example.echo)"`:

```text
{"greeting":"hi","environment":"deployed to dev"}
```

`prisma dev stop` stopped it.

## 2. The edit

`module.ts`: the root declares `input: type({ GREETING: 'string' })` and binds `greeting: input.GREETING`; it provisions a module `greeter` declaring `input: type({ 'key?': secretString() })` that provisions nothing, bound `{ key: envSecret('S4_QA_SECRET') }`. `prisma.config.ts`: `config: [dotenv()]` and `secrets: [dotenv()]`. Files: `.env.s4-qa` (`GREETING=from-env-s4-qa`), `.env.s4-qa.local` (`S4_QA_SECRET=s4-qa-value`), `.env.dev` (`GREETING=from-env-dev`). The example typechecked.

## 3. Root input from `.env.<environment>`, deployed

With `ENV_PARAM_GREETING` and `GREETING` unset, `ENV_PARAM_ENVIRONMENT=s4-qa pnpm run deploy` succeeded, and `ENV_PARAM_ENVIRONMENT=s4-qa EXPECTED_GREETING=from-env-s4-qa pnpm run smoke:deployed` passed:

```text
ok - s4-qa serves greeting "from-env-s4-qa"
ok - s4-qa serves environment "deployed to s4-qa"
```

The command's plain (non-terminal) output shows the step `✔ check environment variables` without counts, so the fill was checked on the platform instead. The Management API lists `S4_QA_SECRET` on the `s4-qa` Branch, written during this deploy (`updatedAt 2026-10-30T00:33:41Z`), and the Branch did not exist before the deploy. Only metadata was read; the API returns no value.

`s4-qa-value` appears nowhere: `grep -r s4-qa-value .prisma-composer .prisma .alchemy` finds nothing, and the deploy output does not contain it. The generated `.prisma-composer/alchemy.run.ts` holds `readConfigPool(config, { environment: "s4-qa", configFile: "…/prisma.config.ts" })` and no value.

## 4. The shell is no longer read

With `.env.s4-qa` moved aside and `GREETING=from-shell` exported, `ENV_PARAM_ENVIRONMENT=s4-qa pnpm run deploy` failed at the first step, before anything was created:

```text
✘ load config and app (5ms)
✘ [COMPOSE.GRAPH_INVALID] The input of root module "s4qa-env-param" does not match its input schema: GREETING must be a string (was missing). A root's input is the config pool: the values the `config` adapters in prisma.config.ts return for the environment "s4-qa".
```

The file was moved back.

## 5. `prisma dev` with `.env.dev`

`prisma dev --detach`, then `curl "$(prisma dev url env-param-example.echo)"`:

```text
{"greeting":"from-env-dev","environment":"deployed to dev"}
```

`prisma dev stop` stopped it.

## 6. A changed value pauses dev

`prisma dev` in the foreground converged once. `.env.dev` was changed to `GREETING=changed`, `src/server.ts` touched and `pnpm run build` run. The session printed, and did not converge again:

```text
The values the config or secrets adapters return changed since dev started. Restart dev to apply them; rebuilds are paused until then.
```

A second touch and build printed nothing and converged nothing. The session was stopped; it stopped the app's services, and `prisma dev stop` then found nothing running.

## 7. Clean up

`ENV_PARAM_ENVIRONMENT=s4-qa pnpm run destroy:environment` succeeded with the edit still in place (`Destroyed.`). Then `git checkout examples/env-param` and the three `.env.*` files were removed.

The `production` deploy from step 1 was destroyed too, with the example back to its original code. `ENV_PARAM_GREETING=hi pnpm run destroy` printed `Removed the Project (proj_iliwugmbe1ib1qhgx5wslppr) — nothing was left in it.` Without `ENV_PARAM_GREETING`, the destroy of the unchanged example fails in the compute descriptor's serialize (`greeting must be a string (was missing)`), as it did before this slice. The project list then held no `s4qa-env-param` project.

## 8. Review fix: step 3 rerun with the report file checked

Run 2026-10-30 after the review fixes, against Prisma Cloud (`PRISMA_REGION=us-east-1`), under the throwaway name `ENV_PARAM_STACK_NAME=s4qa-report-7k2`.

The edit was step 2's, with the same three files minus `.env.dev`. The root binds `greeting: input.GREETING`, a field, so Load's new refusal of the root's whole input does not apply. With `GREETING`, `ENV_PARAM_GREETING` and `S4_QA_SECRET` unset in the shell, `ENV_PARAM_ENVIRONMENT=s4-qa pnpm run deploy` ran with `ENV_PARAM_REPORT` pointing at a file in the scratchpad, so the deploy wrote its report there through `--report`. It succeeded (`✔ Deployed s4qa-report-7k2 to s4-qa in 33.5s.`), and the smoke test passed against that report:

```text
ok - s4qa-report-7k2.site is a public-url entity at echo's URL https://jqepkl8hpmygeywgx1uiryti.ewr.prisma.build
ok - s4-qa serves greeting "from-env-s4-qa"
ok - s4-qa serves environment "deployed to s4-qa"
ok - https://jqepkl8hpmygeywgx1uiryti.ewr.prisma.build/logo.svg serves the entry's sibling asset — the whole tree arrived
```

The report file (798 bytes, `outcome: "succeeded"`) holds the input document `{"greeting":"from-env-s4-qa",…}`, and `grep -c s4-qa-value` on it gives 0. It does not name `S4_QA_SECRET` either. The deploy output and `.prisma-composer`, `.prisma` and `.alchemy` do not contain `s4-qa-value`.

Teardown: `ENV_PARAM_ENVIRONMENT=s4-qa pnpm run destroy:environment` printed `Destroyed.` The Project was still listed, empty. With the example restored (`git checkout` of `module.ts` and `prisma.config.ts`, the `.env.*` files removed), `ENV_PARAM_GREETING=hi pnpm run destroy` printed `Removed the Project (proj_kk9da08jyp7566n8uc0tcyn0) — nothing was left in it.` The workspace's project list then held no `s4qa` project, and a GET of that project returned 404.

# C1 — manual QA, 2026-10-29

`examples/env-param` from this branch, built with this branch's packages, with `ENV_PARAM_GREETING=hi-from-c1` and `PRISMA_REGION=us-east-1` in the deploying shell. The module binds the service's `environment` input to `resolve([environment.name], ([name]) => \`deployed to ${name}\`)`.

| Step | Result |
| --- | --- |
| `prisma dev --detach`, `curl "$(prisma dev url env-param-example.echo)"` (run by the D3 implementer) | `{"greeting":"hi","environment":"deployed to dev"}` |
| The same with `--environment test` on dev, dev url and dev stop | `{"greeting":"hi","environment":"deployed to test"}` |
| `pnpm run deploy` (production); the deploy report's input document | `{"greeting":"hi-from-c1","environment":"deployed to production"}`; `https://closyb9exrmj4tv9v5zkoidb.ewr.prisma.build` |
| `pnpm smoke:deployed` against production | `ok - production serves greeting "hi-from-c1"`, `ok - production serves environment "deployed to production"`, asset ok |
| `pnpm run deploy` with `ENV_PARAM_ENVIRONMENT=c1-qa` | Deployed to `c1-qa` in 45.5s; `https://vnzn0g2aehbi4m6m91aork2r.ewr.prisma.build` |
| `pnpm smoke:deployed` against `c1-qa` | `ok - c1-qa serves environment "deployed to c1-qa"`, greeting and asset ok |
| `provision()` inside `fn`, then `pnpm run deploy` | Fails at "load config and app", before "connect to project and branch": `[COMPOSE.GRAPH_INVALID] provision() was called after module "env-param-example" was loaded, from inside a resolve() function. resolve() computes values, never structure: …` |
| `fn` returning `undefined` for production, then `pnpm run deploy` | Fails at the same step: `[COMPOSE.GRAPH_INVALID] The resolve() function for input key "environment" of service "env-param-example.echo" returned undefined. Return a result for every environment; Composer never picks a default.` |
| `pnpm run destroy:environment` for `c1-qa` | Torn down after QA; production left deployed. |

Found during QA and fixed on the branch (commit 42bc0185): the smoke script looked for the app under its old short name `echo`; every platform name is the node's address, so the app is `env-param-example.echo`. The script found nothing on main before this change.

Observed, not fixed: the `prisma` host prints "Prisma agent skills are out of date" after every command; unrelated to this slice. `pnpm deploy` invokes pnpm's own `deploy` command, not the example's script; the script needs `pnpm run deploy`.

# P1 — manual QA, 2026-10-29

`examples/env-param` from this branch, built with this branch's packages, deployed with the QA credentials and `PRISMA_REGION=us-east-1`. The example provisions `publicUrl({ name: 'site', url: publicUrl.prismaBuild(), target: echo.http })`.

| Step | Result |
| --- | --- |
| `pnpm run deploy` (production) | Deployed in 31.1s. The summary lists `env-param-example.site  public-url cps_closyb9exrmj4tv9v5zkoidb  https://closyb9exrmj4tv9v5zkoidb.ewr.prisma.build`, the echo service's URL. |
| `pnpm smoke:deployed` against production | `ok - env-param-example.site is a public-url entity at echo's URL …`, greeting, environment and asset ok. |
| `pnpm run deploy` with `ENV_PARAM_ENVIRONMENT=p1-qa` | Deployed in 23.4s; `site` reports the preview service's own `prisma.build` URL. Smoke test ok. |
| The application topology read back from both Branches (`GET …/application-topology`) | Nodes `env-param-example` (module), `.echo` (service, compute), `.site` (resource, public-url); one edge `echo.http → site.target`. No other public URL. AC 9. |
| Production `url` changed to `resolve(…)` returning `'composer-p1-qa.example.com'` for production, then `pnpm run deploy` | Fails at "plan and apply": `PrismaApiError: Prisma Management API request failed (domain-ownership-required)`. Production still answers `{"greeting":"hi-from-p1","environment":"deployed to production"}` afterwards. AC 11; the error names the record once alchemy-run/alchemy#2698 is released. |
| `url: 'shop.example.com'`, then `prisma dev --detach`, `curl` the local URL, `prisma dev stop` | Prints `env-param-example.site names the hostname shop.example.com. prisma dev ignores it and serves the service on its local URL.` once; the service answers `{"greeting":"hi-dev","environment":"deployed to dev"}`; stops cleanly. AC 8. |

Both temporary edits to `module.ts` were reverted with `git checkout`.

Not checked live: a named hostname that has its records, and a hostname change on production. The QA workspace controls no domain whose DNS it can publish. The change case is proved under Alchemy's real apply engine in `public-url-apply.test.ts` (AC 10).

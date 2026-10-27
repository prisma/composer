# QA — A2 `deploy list` against the real platform

Run 2026-10-27 on `drive/deploy-list` at `5464a84d`, after `pnpm build`, under bun, from `examples/storefront-auth`.

Environment: `~/.config/prisma-compose/deploy.env` (service token, workspace, Alchemy password), plus `PRISMA_REGION=us-east-1` and `AUTH_SIGNING_SECRET=sk_test_ci_storefront_auth`, as CI sets them.

The installed `prisma` does not mount `deploy list` yet (D3). The human tables below come from a scratch copy of `scripts/e2e-verify-deploy-list.ts` that mounts the same Composer family with the same `createCli` options, passes its arguments through, and prints stdout and stderr as they are. The human table goes to stderr; the tab-separated lines go to stdout.

App name `a2-qa-99d5e9`, named stage `qa-99d5e9`.

## Results

| Check | Result |
| --- | --- |
| Deploy to production | PASS |
| `e2e-verify-deploy-list.ts` on production | PASS |
| Human table on production | PASS |
| Deploy to the named stage | PASS |
| `e2e-verify-deploy-list.ts` on the named stage (`STAGE=qa-99d5e9`) | PASS |
| Human table on the named stage | PASS |
| `deploy list --stage does-not-exist` fails with `DEPLOY.TARGET_NOT_FOUND` | PASS |
| Project deleted and gone | PASS |

The named stage's listing shows its own rows (`db_paj9…`, `cps_eju3…`, `cps_c0q5…`), not production's, though the Project holds rows for both Branches with the same `logicalId`s.

## Production

```
$ bun ../../node_modules/.bin/prisma deploy --name a2-qa-99d5e9
...
✔ Deployed a2-qa-99d5e9 to production in 46.7s.
```

```
$ STACK_NAME=a2-qa-99d5e9 bun ../../scripts/e2e-verify-deploy-list.ts
deploy list --name a2-qa-99d5e9 --json exited 0:
{"kind":"result","envelope":{"ok":true,"commandId":"deploy.list","result":[{"address":"a2-qa-99d5e9","kind":"project","platformId":"proj_x46eyjv91k1femz0acf82vdt","url":null},{"address":"a2-qa-99d5e9.auth","kind":"module","platformId":null,"url":null},{"address":"a2-qa-99d5e9.auth.database","kind":"postgres","platformId":"db_wi2h43um3td2e828a689xw08","url":null},{"address":"a2-qa-99d5e9.auth.service","kind":"service","platformId":"cps_v4lvdnj8la6pqcugsglxv1b5","url":"https://v4lvdnj8la6pqcugsglxv1b5.ewr.prisma.build"},{"address":"a2-qa-99d5e9.storefront","kind":"service","platformId":"cps_cnd2dlaije0vyimghp7qfdp6","url":"https://cnd2dlaije0vyimghp7qfdp6.ewr.prisma.build"}],...}}

Topology on branch br_k0h9v9o7cfz9sz1y2ueuayri:
  module a2-qa-99d5e9
  module a2-qa-99d5e9.auth
  resource a2-qa-99d5e9.auth.database
  service a2-qa-99d5e9.auth.service
  service a2-qa-99d5e9.storefront
Rows in project proj_x46eyjv91k1femz0acf82vdt:
  app cps_cnd2dlaije0vyimghp7qfdp6 branch=br_k0h9v9o7cfz9sz1y2ueuayri logicalId=a2-qa-99d5e9.storefront
  app cps_v4lvdnj8la6pqcugsglxv1b5 branch=br_k0h9v9o7cfz9sz1y2ueuayri logicalId=a2-qa-99d5e9.auth.service
  database db_wi2h43um3td2e828a689xw08 branch=br_k0h9v9o7cfz9sz1y2ueuayri logicalId=a2-qa-99d5e9.auth.database
deploy list shows every topology node with its platform ID and URL.
```

```
$ deploy list --name a2-qa-99d5e9 --format human
Address                     Kind      Platform ID                    URL
a2-qa-99d5e9                project   proj_x46eyjv91k1femz0acf82vdt  —
a2-qa-99d5e9.auth           module    —                              —
a2-qa-99d5e9.auth.database  postgres  db_wi2h43um3td2e828a689xw08    —
a2-qa-99d5e9.auth.service   service   cps_v4lvdnj8la6pqcugsglxv1b5   https://v4lvdnj8la6pqcugsglxv1b5.ewr.prisma.build
a2-qa-99d5e9.storefront     service   cps_cnd2dlaije0vyimghp7qfdp6   https://cnd2dlaije0vyimghp7qfdp6.ewr.prisma.build
```

## Named stage

```
$ bun ../../node_modules/.bin/prisma deploy --name a2-qa-99d5e9 --stage qa-99d5e9
...
✔ Deployed a2-qa-99d5e9 to qa-99d5e9 in 45.3s.
```

```
$ STACK_NAME=a2-qa-99d5e9 STAGE=qa-99d5e9 bun ../../scripts/e2e-verify-deploy-list.ts
deploy list --name a2-qa-99d5e9 --stage qa-99d5e9 --json exited 0:
{"kind":"result","envelope":{"ok":true,"commandId":"deploy.list","result":[{"address":"a2-qa-99d5e9","kind":"project","platformId":"proj_x46eyjv91k1femz0acf82vdt","url":null},{"address":"a2-qa-99d5e9.auth","kind":"module","platformId":null,"url":null},{"address":"a2-qa-99d5e9.auth.database","kind":"postgres","platformId":"db_paj9wnn6izpx5ma5p9hv1pyo","url":null},{"address":"a2-qa-99d5e9.auth.service","kind":"service","platformId":"cps_eju3icljkbwes2op4hoivjkd","url":"https://eju3icljkbwes2op4hoivjkd.ewr.prisma.build"},{"address":"a2-qa-99d5e9.storefront","kind":"service","platformId":"cps_c0q52ww83ng7uzn387pjtyvb","url":"https://c0q52ww83ng7uzn387pjtyvb.ewr.prisma.build"}],...}}

Topology on branch br_yf243sg4fu64rgxcu1inhfvv:
  module a2-qa-99d5e9
  module a2-qa-99d5e9.auth
  resource a2-qa-99d5e9.auth.database
  service a2-qa-99d5e9.auth.service
  service a2-qa-99d5e9.storefront
Rows in project proj_x46eyjv91k1femz0acf82vdt:
  app cps_cnd2dlaije0vyimghp7qfdp6 branch=br_k0h9v9o7cfz9sz1y2ueuayri logicalId=a2-qa-99d5e9.storefront
  app cps_v4lvdnj8la6pqcugsglxv1b5 branch=br_k0h9v9o7cfz9sz1y2ueuayri logicalId=a2-qa-99d5e9.auth.service
  app cps_eju3icljkbwes2op4hoivjkd branch=br_yf243sg4fu64rgxcu1inhfvv logicalId=a2-qa-99d5e9.auth.service
  app cps_c0q52ww83ng7uzn387pjtyvb branch=br_yf243sg4fu64rgxcu1inhfvv logicalId=a2-qa-99d5e9.storefront
  database db_wi2h43um3td2e828a689xw08 branch=br_k0h9v9o7cfz9sz1y2ueuayri logicalId=a2-qa-99d5e9.auth.database
  database db_paj9wnn6izpx5ma5p9hv1pyo branch=br_yf243sg4fu64rgxcu1inhfvv logicalId=a2-qa-99d5e9.auth.database
deploy list shows every topology node with its platform ID and URL.
```

```
$ deploy list --name a2-qa-99d5e9 --stage qa-99d5e9 --format human
Address                     Kind      Platform ID                    URL
a2-qa-99d5e9                project   proj_x46eyjv91k1femz0acf82vdt  —
a2-qa-99d5e9.auth           module    —                              —
a2-qa-99d5e9.auth.database  postgres  db_paj9wnn6izpx5ma5p9hv1pyo    —
a2-qa-99d5e9.auth.service   service   cps_eju3icljkbwes2op4hoivjkd   https://eju3icljkbwes2op4hoivjkd.ewr.prisma.build
a2-qa-99d5e9.storefront     service   cps_c0q52ww83ng7uzn387pjtyvb   https://c0q52ww83ng7uzn387pjtyvb.ewr.prisma.build
```

## A stage that does not exist

```
$ deploy list --name a2-qa-99d5e9 --stage does-not-exist --json
{"kind":"result","envelope":{"ok":false,"commandId":"deploy.list","error":{"code":"DEPLOY.TARGET_NOT_FOUND","severity":"error","summary":"Nothing deployed for a2-qa-99d5e9/does-not-exist.","nextActions":[{"kind":"user-choice","label":"Deploy it first."}],...}}
exit 2
```

## Teardown

```
$ bun ../../scripts/composer-destroy.ts --name a2-qa-99d5e9 --stage qa-99d5e9
Done: 18 succeeded (27.5s)
Destroyed.

$ bun ../../scripts/composer-destroy.ts --name a2-qa-99d5e9 --production
Done: 18 succeeded (28.7s)
Removed the Project (proj_x46eyjv91k1femz0acf82vdt) — nothing was left in it.
Destroyed.

$ curl -H "Authorization: Bearer $PRISMA_SERVICE_TOKEN" https://api.prisma.io/v1/projects/proj_x46eyjv91k1femz0acf82vdt
404

$ deploy list --name a2-qa-99d5e9 --json
... "code":"DEPLOY.TARGET_NOT_FOUND","summary":"Nothing deployed for a2-qa-99d5e9." ...
exit 2
```

No Project named `a2-qa-99d5e9` remains in the workspace's project list.

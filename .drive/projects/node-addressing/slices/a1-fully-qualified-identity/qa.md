# A1 QA: upgrading from v0.34.0 on the real platform

Run on 2026-10-23 against `https://api.prisma.io/v1`, branch `a1-full-platform-names` at `6274ac6e`. Evidence (logs, snapshots, scripts) is in `wip/qa-a1/` of this worktree, which git ignores. No secret values are recorded here.

**Verdict:** the upgrade from v0.34.0 lost no data and touched nothing outside the Composer graph. Every upgrade check passed. One requested step, deploying to a new stage, fails on v0.34.0 and on this branch alike, because the platform now creates a bucket on every new Branch. It passed after I deleted that bucket. Details are in step 8.

## Step 0. Delete the earlier attempt's Project

| Check | Result | Evidence |
|---|---|---|
| `qa-a1-qsgn6n` deleted | PASS | `prisma project delete proj_lbs6tif5hbmz29ge7btc3wax --confirm …` printed "The project, its databases, and its apps were deleted". `GET /v1/projects/proj_lbs6tif5hbmz29ge7btc3wax` returns `resource-not-found`. |

## Step 1. The fabricated app

The app is `qa-a1-190492`. It has a rawPostgres `catalog`, a bucket `files`, an RPC service `quotes`, and a service `api`. `api` depends on all three, and has a `generatedParam()` input `token` and a `serviceOrigin` input `origin`. `api` exposes `/write` and `/put` to add a row and an object, and `/rows`, `/objects` and `/health` to read them with its current credentials. `/hashes` returns sha256 prefixes of the generated token and of every `COMPOSER_` variable. `quotes` exposes `/env-hash`.

Packages from npm: `@prisma/composer`, `@prisma/composer-cli` and `@prisma/composer-prisma-cloud` at `0.34.0`, `prisma@8.0.0-rc.27`, `alchemy@2.0.0-beta.83`. `npm ls` shows one `@prisma/composer-cli@0.34.0`, which the `prisma` host shares.

I first used `prisma@8.0.0-rc.26`. It carries its own `@prisma/composer-cli@0.33.0`, so that deploy was not purely v0.34.0. I deleted that Project (`qa-a1-mzg279`, `proj_d8adm2yjsu72ag2fr5uhlzis`) and started again with rc.27, which depends on `composer-cli@0.34.0`.

## Step 2. Deploy with v0.34.0 and write data

| Check | Result | Evidence |
|---|---|---|
| Deploy to production | PASS | "Deployed qa-a1-190492 to production", 27 resources created. Project `proj_bksk92tih782r3rv71zj9x3h`. |
| Rows and objects written | PASS | 3 rows in table `qa`, 3 objects of 99, 56 and 89 bytes. `/health` returns `{"rows":3,"objects":3}`. |

A second v0.34.0 deploy, with a one-line code change, gave the services a Deployment that has the hand-set variable from step 3.

## Step 3. State planted outside the graph

| Item | Result | Evidence |
|---|---|---|
| Custom domain on `api` | PASS | The API refuses a hostname whose DNS does not point at the platform. `qa-a1-190492.66-135-7-198.sslip.io` resolves to the switchboard's address, so the platform accepted it: `dom_01M5MJ74K2KF6781NB1D1ESAZ4`, status `active`. It served `api`'s `/health`. |
| Hand-set variable | PASS | `QA_HAND_SET=hand-set-qa-a1-190492`, production class, `envvar_q7crwo5b4kljm885egy2dh7z`. The API never returns values, so `api` reports it from its own environment. |
| Hand-made Connection | PASS | `con_s1cunpoutq0p1xvcoeucrrwf` (`qa-a1-190492-handmade`). It read all 3 rows directly. |
| Hand-made access key | PASS | `bkey_k3y6j4rb996thu0xtw6avu38` (`qa-a1-190492-handmade`, role `read`). It listed all 3 objects and read one. The API requires a `role`. |

The platform also made state of its own that is not in the graph: the default connection `con_tx0l18de1k2hxvazlnxufefv` ("Prisma Postgres API Key"), and `DATABASE_URL` and `DATABASE_URL_POOLED` variables. I checked them too.

## Step 4. Snapshot before

`wip/qa-a1/before.txt`. It has ids, names and `logicalId`s, connections and keys, endpoint domains, custom domains, every variable's key, id and `updatedAt`, the topology, the deploy state's resource IDs, the hashes, the rows and objects, and hashes of the default connection's credentials from the deploy state. It also records that those credentials connect.

## Step 5. Upgrade

I built the repo (`pnpm build`), packed the three `packages/9-public/*` packages with `pnpm pack`, and installed the tarballs. The lockfile shows each package resolved from `file:../tarballs/…`. I changed `serviceOrigin('api')` to `serviceOrigin('qa-a1-190492.api')`, as the upgrade guide says. Then I deployed to production. Full log: `wip/qa-a1/deploy-upgrade.log`.

```
Plan: 7 to update, 19 to replace, 1 tasks
[qa-a1-190492.catalog] update (renamed from catalog-db)
[qa-a1-190492.catalog.connection] replace (renamed from catalog-conn)
[qa-a1-190492.files] update (renamed from files-bucket)
[qa-a1-190492.files.accesskey] replace (renamed from files-key)
[qa-a1-190492.api] update (renamed from api-svc)
[qa-a1-190492.api.generated.token] update (renamed from COMPOSER_API_INPUT:token-generated)
[qa-a1-190492.api.servicekey.quotes] update (renamed from servicekey-api.quotes)
…
Done: 27 succeeded (41.5s)
```

The 7 updates are the Database, Bucket, two Apps, warm-up, generated value and service key. The 19 replaces are the Connection, the access key, the two Deployments, and 15 `COMPOSER_` variables. Nothing else was replaced or deleted.

## Step 6. Snapshot after and compare

`wip/qa-a1/after.txt`. Run `diff before.txt after.txt` to see every difference.

| Check | Result | Evidence |
|---|---|---|
| Database, Bucket and App ids unchanged | PASS | `db_dhmp6sefsgr3qirf4awbq11c`, `bkt_gvwwghnfu99x8im06tpknuqu`, `cps_efn6g905qra9txjwssu4hwex`, `cps_nqklgifjhfkdjk46a1qxcd82`. Project and Branch ids are also unchanged. |
| Rows and objects unchanged | PASS | The same 3 rows (ids and notes) and the same 3 objects (keys and sizes), read through `api`, the hand-made Connection and the hand-made key. |
| Generated value unchanged | PASS | Token hash `567caf9babb8eb4c` before and after. |
| RPC key unchanged | PASS | `api`'s service key hash `2454e742d7a4558f` and `quotes`' accepted keys hash `7c8d34971f2305f5` before and after. `/quote` over the RPC edge returns `{"quote":"ok"}`. |
| Endpoint domains unchanged | PASS | `https://efn6g905qra9txjwssu4hwex.ewr.prisma.build` and `https://nqklgifjhfkdjk46a1qxcd82.ewr.prisma.build`. |
| Custom domain unchanged | PASS | Same id, hostname and `active` status. It still serves `/health`. |
| Hand-set variable unchanged | PASS | Same id and `updatedAt`. The new Deployment's environment has `QA_HAND_SET=hand-set-qa-a1-190492`. |
| Hand-made Connection unchanged and working | PASS | `con_s1cunpoutq0p1xvcoeucrrwf` is still listed, and its credentials from before the upgrade read all 3 rows. |
| Hand-made access key unchanged and working | PASS | `bkey_k3y6j4rb996thu0xtw6avu38` is still listed, and its credentials from before the upgrade list and read the objects. |
| Default connection unchanged | PASS | `defaultConnectionId` is still `con_tx0l18de1k2hxvazlnxufefv`, with the same `createdAt`. The stored connection-string hashes are unchanged (direct `cd39904006c344f4`, pooled `65b4f2ec252d5006`, accelerate `68ba9ed9feb0eb1b`). The connection string from before the upgrade still connects and counts 3 rows. The platform's `DATABASE_URL` and `DATABASE_URL_POOLED` variables keep their ids and `updatedAt`. Nothing was rotated. |
| Composer's Connection and key recreated under full-address names | PASS | `con_szd4f2llo0afreayqas8ipgm` (`catalog-99d500d6c983`) is gone, and `con_q8e8pmhcezwspl35gdmczmw8` (`qa-a1-190492.catalog-256e3bd08ebe`) replaces it. `bkey_bbtiq63iqnqz3dpulfztj9l1` (`files-a2c1b420a232`) is gone, and `bkey_oyo38878a1yhtcirjeusiary` (`qa-a1-190492.files-1ee547ad648e`) replaces it. The upstream token suffix is expected. |
| Services read through the new credentials | PASS | `api`'s database URL and access key hashes changed to the new ones (`95ace3a7…`, `2a86cbad…`). `/health` returns `{"rows":3,"objects":3}`. |
| App, Bucket and access key names are the full address | PASS | Apps `qa-a1-190492.api` and `qa-a1-190492.quotes`, Bucket `qa-a1-190492.files`, key `qa-a1-190492.files-<token>`. |
| Every `logicalId` is the full address | PASS | Database `qa-a1-190492.catalog`, Bucket `qa-a1-190492.files`, Apps `qa-a1-190492.api` and `qa-a1-190492.quotes`. Project `qa-a1-190492`. Every topology node and parent uses the full address. |
| Deploy state holds only dotted IDs | PASS | 26 IDs, all starting with `qa-a1-190492.`. No `-db`, `-conn`, `-svc`, `-var`, `servicekey-` or `-generated` remains. The 27th entry, `composer-deployment-report`, is the per-deploy report task. It is not a node's resource, and both releases name it the same. |
| No old `COMPOSER_` variables remain | PASS | All 15 rows now start with `COMPOSER_QA_A1_190492_`. None of the old `COMPOSER_API_…` or `COMPOSER_QUOTES_…` rows remain. |

Observations, none of which loses data:

- The Deployment created during the upgrade still has the old `COMPOSER_API_…` keys in its process environment, with the old values. The platform copies variables into a Deployment when it creates it. The new Deployment is created before the old rows are deleted at cleanup. The app reads only the new keys. The old values point at the deleted Connection and key, so they no longer work. Later Deployments are created after the old rows are gone. I did not check that they lack the old keys.
- The Database's generated platform name changed from `qa-a1-190492-catalog-db-br-…` to `qa-a1-190492-qa-a1-190492-catalog-br-…`, which contains the app name twice. Upstream builds it from the stack name and the resource ID. It is only a label, as `upgrade-effects.md` says.

## Step 7. Redeploy unchanged

| Check | Result | Evidence |
|---|---|---|
| Unchanged redeploy plans only expected churn | PASS | `Plan: 16 to update, 1 to replace`. The replace is `qa-a1-190492.api.deployment`. The updates are the 15 `COMPOSER_` rows and `qa-a1-190492.quotes.deployment`. Nothing else changes. |

Why this churn happens, and why it is not new:

- Upstream `EnvironmentVariable` plans `update` whenever it has a resolved value. The API never returns values, so upstream rewrites each one to repair drift (`alchemy/src/Prisma/EnvironmentVariable.ts`, `diff`).
- `api`'s Deployment is replaced because upstream `Deployment` replaces when it cannot prove that its triggers are unchanged. I did not trace which of `api`'s trigger values is unresolved at plan time.
- I deployed a control app, `qa-a1-190492-ctl`, with v0.34.0 and redeployed it unchanged. It planned exactly the same: 16 updates and 1 replace of `api-deploy`. This slice does not add the churn.

## Step 8. Deploy from scratch to a new stage

| Check | Result | Evidence |
|---|---|---|
| `--stage qa-fresh` deploys from scratch | FAIL on the first try; the same failure happens on v0.34.0 | Before the deploy started, the platform made bucket `bkt_93fa9a7733ea111ed30cda2cd7b47285` (name `qa-a1-190492.files`, `logicalId` null, its own S3 bucket) on the new Branch, 4 seconds after creating the Branch. Composer's check for an empty deploy state then stopped the deploy: "has no deploy state, but its branch … already holds 1 resource(s): bucket "qa-a1-190492.files"". Composer creates the Branch with only `{ gitName }`. The v0.34.0 control app failed the same way (`bucket "files"`). |
| After deleting that bucket | PASS | Deleted `bkt_93fa…`, then deployed again: `Plan: 26 to create`, "Deployed qa-a1-190492 to qa-fresh". It holds full-address names, `logicalId`s, state IDs and env keys (`wip/qa-a1/fresh.txt`). A row and an object were written and read back. `/quote` works. |
| Second deploy to the stage | PASS, with the same churn as step 7 | `Plan: 16 to update, 1 to replace`. These are the same resources as in step 7. |

**Needs a decision outside this slice:** a first deploy to a new stage fails for any app with a bucket, on v0.34.0 and on this branch. The platform appears to create a bucket on every new Branch, copying the default Branch's bucket name. I did not check whether it copies objects.

## Step 9. Local dev

I used a fresh copy of the app named `qa-a1-190492-dev`, in `wip/qa-a1/app-dev`.

| Check | Result | Evidence |
|---|---|---|
| `prisma dev --detach` with v0.34.0 | PASS | 26 resources created. Wrote 3 rows and 3 objects. Token hash `11b58395fe92cc00`. The record has no `formatVersion` and uses keys `catalog`, `files`, `quotes`, `api`. |
| `prisma dev --detach` with the branch's packages | PASS | 26 updated, each "renamed from" its old ID. Nothing was created or deleted. |
| Rows and objects survived | PASS | The same 3 rows and 3 object keys. |
| Generated value survived | PASS | Token hash `11b58395fe92cc00`. |
| Record rewritten | PASS | `formatVersion: 2`. Keys are `qa-a1-190492-dev.catalog` and so on. Instance ids and ports are unchanged (database `db_1465a41667e4dfa1` on port 51941, api 3075, quotes 3074). `prisma dev url qa-a1-190492-dev.catalog` works. |
| Nothing left running | PASS | `prisma dev stop` after each run. Port 3075 refuses connections afterwards. I stopped no other process. |

## Step 10. Teardown

| Check | Result | Evidence |
|---|---|---|
| Delete while services run | PASS | `api` answered `/health` right before. `prisma project delete <id> --confirm <id>` deleted `proj_bksk92tih782r3rv71zj9x3h` (`qa-a1-190492`, both Branches) and `proj_d9ds5b8fyflqi1qwtf8pcn39` (`qa-a1-190492-ctl`). |
| Every QA Project is gone | PASS | `prisma project list` shows no `qa-a1` Project. `GET /v1/projects/<id>` returns `resource-not-found` for `qa-a1-qsgn6n`, `qa-a1-mzg279`, `qa-a1-190492` and `qa-a1-190492-ctl`. |

## Not tested

- Whether later Deployments drop the old `COMPOSER_` keys that the upgrade Deployment still carries (step 6).
- Which trigger makes `api`'s Deployment replace on every deploy (step 7). Both releases behave the same.

# Platform check 4: a compute process that exits at boot

Run on 2026-11-06, region us-east-1, with `prisma` 8.0.0-rc.26 and `alchemy` 2.0.0-beta.84 from this worktree. App `pv-check-4`, project `proj_z8tjt2g1vvlwwjob7ywgw7zc`. Two services: `pv-check-4.crash` logs two lines and calls `process.exit(1)`; `pv-check-4.ok` answers HTTP 200 `ok`.

Short answer: Prisma Cloud does not notice that the process died. The deployment reports `running`, `prisma deploy` reports success, and the crashing deployment is promoted. Only the logs and a 502 on the URL show the problem.

## 1. Does `prisma deploy` fail?

No. It exits 0 and prints success for both services (`wip/pv-review/platform-check-4-deploy.log`, fourth attempt). The bracketed times are local time, UTC+1; everything else in this file is UTC.

```
[14:15:44.734] INFO (#720): [pv-check-4.ok.deployment] created (5.8s)
[14:15:44.736] INFO (#721): [pv-check-4.crash.deployment] created (5.4s)
Done: 11 succeeded (10.0s)
✔ Deployed pv-check-4 to production in 28.8s.
pv-check-4.crash  compute-service cps_s35k7apd3pyc2ccdaexawmq0
exit=0
```

Why: the `Prisma.Deployment` resource (`node_modules/@alchemy.run/prisma/src/Deployment.ts`) starts the deployment and then calls `waitForDeploymentStatus(id, "running")` (`ComputeLifecycle.ts`, 1 s poll, 120 s timeout). It fails only on status `failed` or on timeout. The platform reported `running` for the crashing deployment, so the wait returned at once and `promoteAppObserved` ran next. The deploy never sends a request to the service, so nothing tries to reach the process.

Side note from the code: if the wait had seen `failed` or timed out, `cleanupCreatedDeploymentOnFailure` deletes the deployment it just created. The failed deployment and its logs would then be gone from the API. This check did not reach that path.

## 2. Status afterwards, promotion, and change over time

`GET /v1/deployments/cpv_fous92yxzj0y866ou827r9fj` (the crashing one) returned `"status":"running"` at every poll: 13:16:07, 13:17:21, 13:18:26, 13:19:31, 13:20:42, 13:21:51 and 13:24:48 UTC. The healthy deployment `cpv_a8y2lel1grnajotgbylc5soo` was also `running` throughout. Raw output is in `wip/pv-review/platform-check-4-poll.log`.

`GET /v1/services/{serviceId}/deployments` list items carry no `status` field at all (only `id`, `type`, `url`, `serviceId`, `foundryVersionId`, `createdAt`). The status is only in `GET /v1/deployments/{id}`.

Promotion: `GET /v1/services/{id}` has no active or promoted deployment field (fields: `id, type, url, name, region, projectId, branchId, latestDeploymentId, appEndpointDomain, createdAt, logicalId`). The CLI shows it is promoted:

```
$ prisma service show pv-check-4.crash --project proj_z8tjt2g1vvlwwjob7ywgw7zc
live version:     cpv_fous92yxzj0y866ou827r9fj
recent versions:  cpv_fous92yxzj0y866ou827r9fj (running, live)
$ prisma service version list pv-check-4.crash --project proj_z8tjt2g1vvlwwjob7ywgw7zc
cpv_fous92yxzj0y866ou827r9fj  running  2026-11-06T13:15:38.594Z  yes
```

The service's stable URL `https://s35k7apd3pyc2ccdaexawmq0.ewr.prisma.build` answered `502 Bad Gateway` (openresty) at every poll.

Restarts: the platform does not restart the process on its own. Each HTTP request to the URL boots the VM once; it crashes again within about a second. Boot times in the log line up with my requests, 2 to 4 seconds after each:

| Request to the URL | Boot logged |
|---|---|
| (deploy start) | 13:15:43.186 |
| 13:16:07 | 13:16:09.554 |
| 13:17:21 | 13:17:24.280 |
| 13:18:26 | 13:18:28.511 |
| 13:19:31 | 13:19:39.174 |
| 13:20:42 | 13:20:46.453 |
| 13:21:51 | 13:21:57.295 |

From 13:22:15 to 13:24:17 I sent no requests and read only the logs. The log cursor stayed at byte 2289 and no new boot appeared. The status stayed `running` the whole time, through 7 crashes.

## 3. Where the operator can see the boot error

- `prisma deploy` output: nowhere. It says success.
- `prisma log`: there is no such command in this CLI. The command is `prisma service logs`. It shows the error:

```
$ prisma service logs pv-check-4.crash --project proj_z8tjt2g1vvlwwjob7ywgw7zc
pv-check-4 crash service booting at 2026-11-06T13:15:43.186Z
pv-check-4 crash service: exiting with code 1 on purpose
Application exited with 0x100 (exit code: 1)
[    1.054899] reboot: Restarting system
```

- Management API: `GET /v1/deployments/{id}/logs?from_start=true` returns the same lines as NDJSON, including `Application exited with 0x100 (exit code: 1)` and `reboot: Restarting system`, then a terminal record with a cursor.
- `prisma service show` and `prisma service version list`: no sign of the error; both say `running` and live.
- Console: not checked. I had no logged-in browser session for it.

## 4. Does the healthy service in the same app get promoted?

Yes. `pv-check-4.ok` was promoted (`prisma service show pv-check-4.ok`: `live version: cpv_a8y2lel1grnajotgbylc5soo`, `running, live`) and its URL answered `200 ok` at every poll. Both services were deployed and promoted in parallel; the crash of one had no effect on the other, and the deploy reported both as successful.

## Exact sequence

All from `wip/pv-check-4-app/` unless noted, after `set -a; . ~/.config/prisma-compose/deploy.env; set +a`.

1. Built the app in `wip/pv-check-4-app/` (`module.ts`, `src/crash/*`, `src/ok/*`, `package.json`, a copy of `examples/env-param/prisma.config.ts`). `node_modules/@prisma/{composer,composer-cli,composer-prisma-cloud}` are symlinks to `packages/9-public/*`. Ran `bun run build`.
2. 13:12:09 `bun ../../node_modules/.bin/prisma deploy` failed, exit 2: `[DEPLOY.CONTAINER_FAILED] ... project "pv-check-4" does not exist yet and no deploy region is configured.`
3. 13:12:38 `PRISMA_REGION=us-east-1 bun ../../node_modules/.bin/prisma deploy` was killed with exit 137 just after `Computing plan`, with no error message. I do not know what killed it. It created the project but no services (`GET /v1/services?projectId=...` returned `[]` at 13:15:13), and it left the deploy lease held.
4. 13:13:55 the same command failed, exit 1: `HostedStateBootstrapError: ... acquiring the deploy lease — Lease is held by wmadden@Mac since 2026-11-06T13:13:35.416Z`.
5. 13:14:58 after waiting out the 60 s lease, the same command succeeded, exit 0, at 13:15:45.
6. `bun run wip/pv-review/platform-check-4-poll.ts` and `bun run wip/pv-review/platform-check-4-poll2.ts` (from the worktree root) at 13:15:54, 13:16:07, then every ~65 s to 13:21:51. Each run read the service, the deployment list, each deployment, its logs, and requested the service URL.
7. `prisma service show`, `prisma service logs`, `prisma service version list` (output in `wip/pv-review/platform-check-4-cli.log`).
8. 13:22:15 and 13:24:17: logs only, no requests to the URL.
9. 13:24:40 `bun ../../scripts/composer-destroy.ts --environment production` (with `PRISMA_REGION=us-east-1`), exit 0.
10. 13:25:11 `DELETE /v1/projects/proj_jq33n0c1iy3opp69hj2hqtd3` returned 204.

## Cleanup

- `prisma destroy` (through `scripts/composer-destroy.ts`) deleted both deployments, both services, the six environment variables, and the project itself: `Removed the Project (proj_z8tjt2g1vvlwwjob7ywgw7zc) — nothing was left in it.` `GET /v1/projects/proj_z8tjt2g1vvlwwjob7ywgw7zc` then returned 404, so no separate project delete was needed.
- `proj_jq33n0c1iy3opp69hj2hqtd3` (`pv-check-1793970605187`): deleted, 204, then 404 on GET.
- A project list after cleanup showed no project named `pv-check*`.
- Nothing remote is left. Local files are only under `wip/` (the app, the scripts, the logs). No tracked file was changed.

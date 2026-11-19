# Compute versions stay in `stopping` after a stop, sometimes for hours

Region: us-east-1. Preview domains were under `ewr.prisma.build`. All calls went through the Management API at `https://api.prisma.io` with a service token. All times are UTC, from 2026-11-16 to 2026-11-18.

## Summary

After `POST /v1/deployments/{id}/stop`, a version (a deployment) sometimes stays in status `stopping` and never reaches `stopped`. One version stayed `stopping` for more than an hour. It happened to healthy versions as well as to a version whose health path was failing.

While a version is `stopping`:
- `DELETE /v1/deployments/{id}` answers `409 Conflict` with "The deployment did not reach a delete-safe state after stop".
- `DELETE /v1/services/{id}` fails with the same Conflict for the version's service, after about 15 seconds. This also happens when no stop was sent beforehand (case 4). It can leave the service serving nothing.

`DELETE /v1/projects/{id}` still works. It answered `204` every time and removed the service and all its versions.

## Expected

After the stop call, the version reaches `stopped` within seconds and can then be deleted. Many versions in the same runs did exactly that.

## Case 1: a plain stop, no other tooling

Three versions were created on one service, each with:
- `POST /v1/services/{serviceId}/deployments` with `portMapping: { http: 8080 }`;
- an archive upload to the returned `uploadUrl`;
- `POST /v1/deployments/{id}/start`.

The app answers 500 on `/health`. Each version was polled with `GET /v1/deployments/{id}` until `running`. Its preview URL was then requested once a second for 60 seconds. After that, each version got `POST /v1/deployments/{id}/stop`, and its status was read every 10 seconds.

| Version | Stop requested | Result |
| --- | --- | --- |
| `cpv_b80lcytliv1jl9k1gapldqv7` | right after the requests ended | `stopped` at the first read, 22:40:06 |
| `cpv_dmvylga5db2378lk2udl27pc` | 30 s after the requests ended | `stopped` at the first read, 22:40:34 |
| `cpv_gh0e8fx5qi0efl0pszrdlmw7` | right after the requests ended (these used `Connection: close`) | `stopping` at every read from 22:40:04 to 22:41:39 |

The project was then deleted with `DELETE /v1/projects/{id}`, which answered `204` at 22:43:13. So one stop in three did not finish within the 95 seconds observed.

## Case 2: a version whose health check failed

- Project `proj_q5bpstuchfev8357b3bjq2x6`, service `cps_xxrv9cruywx1a0qjmuykwp07`.
- Version `cpv_kpqljsao1xpc9i1s2rka1yvd` was created at 22:55:12 and started. Its `/health` answered 500 for 60 seconds.
- `POST /v1/deployments/cpv_kpqljsao1xpc9i1s2rka1yvd/stop` was sent at about 22:56:24.
- `GET` showed `stopping` once a minute from 23:01:53 to 23:31:21, and again at 00:00:38: more than 64 minutes after the stop.
- No delete of this version or its service was sent while it was `stopping`, because each attempt first read its status and found it `stopping`.
- In an earlier reproduction of this case the same day, `DELETE /v1/deployments/{id}` on such a version, and `DELETE /v1/services/{id}` on its service, both answered `409 Conflict` with "The deployment did not reach a delete-safe state after stop". The service delete had already removed the service's served version, and the service URL then answered 404.
- The service's other version, `cpv_xp6pssiwpk2elwpu22gw4mzr`, kept serving throughout.
- `DELETE /v1/projects/proj_q5bpstuchfev8357b3bjq2x6` answered `204` at about 00:05.

The same thing happened in an earlier test session: a version left `stopping` by a failing health check was still `stopping` more than 20 minutes later.

## Case 3: healthy versions, stopped to tear down a test

Each of these versions was running and healthy, and served traffic. Each got `POST /v1/deployments/{id}/stop` at about the time shown, then status reads for 60 seconds.

| Project | Service | Version | Stop requested | Still `stopping` at |
| --- | --- | --- | --- | --- |
| `proj_kl7587vj5pgdg409iyq9bn3k` | `cps_j0soxfecluyy2hlng2vtly21` | `cpv_vo7ge2phwo6nap5rjtt70eiv` | ~23:39:45 | 23:40:47 and 00:00:41 |
| `proj_u867iftnunffyyuzu8op4zdw` | `cps_ksu48eiqwc4cglalbhf8lbho` | `cpv_ajyq2iq4jlbzmq5ss3vloeoz` | ~23:42:30 | 23:43:30 and 00:00:39 |
| `proj_knus7ctr80f4mi5768bzhu02` | `cps_t0lnu67fmkxcqs8q2z9zb8ve` | `cpv_cyjdzekc5keusppihae2ey0n` | ~23:55:00 | 23:56:00 and 00:00:40 |

All three projects were then deleted with `DELETE /v1/projects/{id}`, which answered `204` at about 00:05.

An earlier run, between 22:50 and 23:25, also stopped healthy versions during teardown. In three test stacks, `DELETE /v1/services/{id}` failed with "The deployment did not reach a delete-safe state after stop". The version IDs were not recorded.

## Case 4: the platform's own service delete, and other sequences (2026-11-18)

This case checks whether the stuck versions come from calling stop ourselves.

- **Setup.** One project, `proj_uxqqz0q555tjohb7jawyxjq0`, created at 01:06:10, with throwaway services.
- **Each version** was created, started and polled with `GET /v1/deployments/{id}` until `running`. The served one was promoted with `POST /v1/services/{id}/promote`.
- **Each result** was then read every 5 seconds for 90 seconds.
- **Cleanup.** `DELETE /v1/projects/proj_uxqqz0q555tjohb7jawyxjq0` answered `204` in 1.8 s at 01:15:58.

| Sequence | Tries | Calls and results | State 90 s later |
| --- | --- | --- | --- |
| `DELETE /v1/services/{id}` on a service with one running, promoted version, with no stop beforehand | 5 | 5 of 5 answered `409 Conflict` "did not reach a delete-safe state after stop", each after 15.5 to 15.9 s | service present; the version `stopping` in all 5 |
| `POST …/stop` on that version, then `DELETE /v1/deployments/{id}`, then `DELETE /v1/services/{id}` | 5 | 1 of 5: the version was `stopped` 1.5 s after the stop, and both deletes answered OK. 4 of 5: still `stopping` 2 minutes after the stop, and both deletes answered `409` after about 15.6 s | 4 of 5: service present, serving nothing, version `stopping` |
| `DELETE /v1/services/{id}` with two running versions, one promoted | 2 | 2 of 2 answered `409` after about 15.6 s | try 1: the served version `stopping`, the other `running`. Try 2: both `running` |
| One version already stopped or stopping, then `DELETE /v1/services/{id}` | 2 | 2 of 2 answered `409` after about 15.6 s | the promoted version `stopping` in both |
| `DELETE /v1/deployments/{id}` on a running version that is not promoted, with no stop beforehand | 3 | 1 of 3 deleted it in 1.1 s. 2 of 3 answered `409` after about 15.5 s and left it `stopping` | |
| `DELETE /v1/deployments/{id}` on a version just started | 2 | It was already `running` when deleted. 2 of 2 answered `409` after about 15.6 s | `stopping` |

**The IDs for each try**, with the time of the main delete call:

| Row | Try | Service | Version(s) | Main call at |
| --- | --- | --- | --- | --- |
| 1 | 1 | `cps_ztqt73qw5juekw18rut1u1wm` | `cpv_thsfgbcxumgwicqphudaca3b` | 01:06:17 |
| 1 | 2 | `cps_r8z8nv494d89c40kujtkqro6` | `cpv_y4ldqfsffl7boy071pb61ta3` | 01:06:19 |
| 1 | 3 | `cps_vjipg0fy2b944r8rptfibb7u` | `cpv_crx48civufkl1yc1q6hfkgok` | 01:06:17 |
| 1 | 4 | `cps_a6f80855lxyd6alqpyjve84e` | `cpv_ppj5465vth44f9tph9gvlg4s` | 01:06:16 |
| 1 | 5 | `cps_de7dkq9vibr6ziegg26mcwqw` | `cpv_rp74q6vnbqvu4dc2li7kxkd2` | 01:06:19 |
| 2 | 1 | `cps_wqih0zcldicxkkoe0loxj2ok` | `cpv_uu9hpt8bwcovqfxmo4uhcjgv` | stop 01:06:15 |
| 2 | 2 | `cps_ydnpx9sp7iootfjqt7te42ny` | `cpv_bdu5nvitff8ow060g0me0vzj` | stop 01:08:28 |
| 2 | 3 | `cps_w2ewwt7gdmf3hgujjmtgvn5a` | `cpv_a6nzsgoh3h5afd9kq7zn4qjd` | stop 01:08:28 |
| 2 | 4 (stopped) | `cps_zhu1auztu2ymxssd8cblfzf1` | `cpv_v9xqngm3xkungiv9cdlubbng` | stop 01:08:35 |
| 2 | 5 | `cps_mcjsxm08385khud815upr1hh` | `cpv_jp5d12853pdlrx321hvm2nwj` | stop 01:08:31 |
| 3 | 1 | `cps_kexduhtadjd8y208zhng2xyj` | `cpv_ujsthde6thxfkzyv6atrcvo7` (not served), `cpv_gnt4v095l96nlogzssqsd911` (served) | 01:08:42 |
| 3 | 2 | `cps_ah88149wkt1v8dkc6l5f71rk` | `cpv_h85e65tp9l60tnm1mp6j5qp5` (not served), `cpv_hsmelw7fziq0shpj1irnxpov` (served) | 01:08:55 |
| 4 | 1 | `cps_j9vwinufw2xhrcj8qqm8u97a` | `cpv_y15dee1kp14obg2rqqrmy6yx` (stopped first), `cpv_g6bc8zlcfo8efchp5sx0g635` (served) | 01:11:00 |
| 4 | 2 | `cps_ul1ltdkbx1x9kpjbhyzj3ea4` | `cpv_h6y9uicx5xw6piugd6qko4y3` (stopped first), `cpv_k83lqmfwlp3y4q39r55wv8v9` (served) | 01:11:10 |
| 5 | 1 (deleted) | `cps_i5ef4pp4p2l1g76ufkko4p5a` | `cpv_hrej70ntdd1pv2uh0t3hlj7k` (deleted), `cpv_iufbiw11faj1bj6p7alq7dxq` (served) | 01:11:28 |
| 5 | 2 | `cps_hu33v9s8a9qgdjv3jqwn2wph` | `cpv_f1999z3v6b4g47pm5fqw22kj` | 01:13:10 |
| 5 | 3 | `cps_kqzgb0rxih1vbpwbo234mkfx` | `cpv_eictuoupl243cer31uu4zd67` | 01:13:10 |
| 6 | 1 | `cps_jhnsz5sh634j25npvbajo3vo` | `cpv_z1f4xl2ectvvcamdagt8yrwy`, `cpv_xfn4n7ujnx7d2kybscnmujod` (served) | 01:13:17 |
| 6 | 2 | `cps_jvqwehsosgg00gd2rto0lsp8` | `cpv_vegp067ywews0bson2py8ljk`, `cpv_kmxmsp0d4zll6axpyerqasa2` (served) | 01:13:27 |

The "main call at" times are the moment the call was sent. Each one is the time of the call's result minus how long the call took, both of which were recorded.

**What this shows:**
- On 2026-11-18, the platform's own service delete, called with no stop beforehand, failed every time, and it left its versions in `stopping`.
- After a `DELETE /v1/services/{id}` or `DELETE /v1/deployments/{id}` with no stop sent beforehand, the call answered `409` after about 15 seconds. A `GET` within a second of that `409` showed the version in `stopping`; it had been `running` just before the call. One exception: the one version delete that succeeded (row 5) returned in 1.1 s, and the version was gone.
- When a version does not stop, the service is left in place, sometimes after the served version has been stopped.

**Earlier, around 22:45 UTC on 2026-11-16**, the same test suites deleted their services and versions without errors. They used a similar sequence: stop each version, delete it, then delete the service. In case 4, a stop finished within seconds in 3 of the 19 tries.

## What still works

- `DELETE /v1/projects/{id}` removes the project, its services and their stuck versions at once.
- The other versions of an affected service keep running and serving.

## What this blocks

- **Deleting a single version or a single service.** Neither can be done while one of its versions is `stopping`, so a tool that removes a service without its project cannot finish until the stop does.
- **Tearing down a failed version.** A tool that stops and deletes a version which failed its health check cannot remove it, and has to leave it behind.
- **Automated test suites.** Suites that deploy and then tear down a service fail at teardown. In one run, six tests failed only for this reason.

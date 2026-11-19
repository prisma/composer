# Composer on the unreleased Alchemy Prisma provider: change and proof

Status: done. Nothing pushed; the branch cannot pass CI while it depends on local tarballs.

## Where the work is

- Worktree: /Users/will/Projects/prisma/composer/.claude/worktrees/compute-keep-versions, branch `feat/compute-keeps-previous-versions`, from origin/main 62a32612. Not pushed.
- Baseline for the upgrade scenario: an untouched detached worktree of origin/main 62a32612 at /Users/will/Projects/prisma/composer/.claude/worktrees/compute-keep-versions-baseline (removed at the end).

## Commits (branch `feat/compute-keeps-previous-versions`, not pushed)

- 4218cf2c build: build against an unreleased Alchemy Prisma provider, and adapt to what the upgrade forced
- 802566e3 feat(prisma-cloud): a compute service keeps the version a deploy replaces, so Prisma Cloud's rollback has one to return to
- b9326402 feat(prisma-cloud): rewrite saved Prisma.App and Prisma.Deployment rows to the new names before Alchemy plans
- 72915ee3 fix: report versions to the build, and rewrite the provider's new variable adoption advice
- dde80b76 fix(prisma-cloud): read a service's url output from its stable domain, so an unchanged consumer keeps its version
- 0b436701 docs: a compute service keeps the versions a deploy replaces

## How the unreleased provider is wired in, and how to remove it

`alchemy`, `@alchemy.run/prisma` and `@alchemy.run/node-utils` were built (`node scripts/build.ts`) and packed (`pnpm pack`) from the Alchemy checkout at commit c36563220 on `feat/prisma-compute-composition`, with a clean tree at the time. The tarballs are in the worktree's untracked, git-ignored `wip/alchemy-tarballs/`. The root `package.json` has three `pnpm.overrides` pointing at them with `file:` paths. `node-utils` is needed because the branch's `alchemy` imports `@alchemy.run/node-utils/ignore-rules`, which the published 2.0.0-beta.87 does not export. `@distilled.cloud/*` come from the registry at 1.0.0-rc.20, whose source is identical to the branch's submodule. To remove: delete the three override lines, set the catalog to the release that carries the change, `pnpm install`. Note: after the tarballs were built, another session started editing the Alchemy checkout (uncommitted changes to `Compute.ts`, `ComputeService.ts`, `ComputeVersion.ts`); the tarballs do not contain those.

## What the Alchemy upgrade forced (beta.85 to the beta.87-based branch), apart from the rename

- The catalog moves to alchemy 2.0.0-beta.87, `@distilled.cloud/prisma` 1.0.0-rc.20 and effect plus the `@effect/platform-*` packages 4.1.4 (the provider's peer range is `^4.1.4`).
- `Prisma.PrismaEnvironment` now holds an Effect that upstream runs per request; Composer's layer wraps its environment in `Effect.succeed`.
- A provider's lifecycle operations must fail with a tagged error (`ProviderError`). New `providerError` in `@internal/lowering` passes a tagged failure through and wraps any other in `ProviderFailed` with the same message; used by the local providers, `PgWarm` and `OrmMigration`. `OrmMigrationError` gains `_tag`, so it passes through unchanged. Behaviour is unchanged except that an untagged failure now reaches Alchemy wrapped; its message is the same.
- `Prisma.EnvironmentVariable`'s value may be `undefined` (no variable); the local provider then removes the key. Composer never passes `undefined`.
- Distilled's `Credentials.apiToken` is optional (test only).
- `Prisma.ComputeService` reads its Branch's role (`getBranch`) on read and reconcile (test fakes gained that route).
- The upgraded `EnvironmentVariable` has a new adoption message ("rerun with adoption enabled ..., or remove it first"); `withComposerAdvice` rewrites it.
- Not run: `check:npm-effect-resolution`, because the published packages would resolve alchemy from the registry, not the tarballs, so the check would test the wrong build.

## Repository checks (final state, 0b436701)

- `pnpm build`: pass. `pnpm typecheck` (all 82 tasks plus scripts): pass. `pnpm lint`: pass (warnings only, as on main). `pnpm lint:casts`: delta 0. `pnpm lint:deps`, `pnpm lint:rules:symlinks`: pass.
- `pnpm test`: first full run found 3 failures caused by this change (build-report mapping test, the new adoption message), both fixed in 72915ee3. Second full run: 2834 pass, 1 fail, in `@internal/dev-emulators` ("a session-resume start just after a crash loop is held starts the service again"). Rerunning that package alone gave a different single timing failure ("a deployment returns only once a slow-booting service accepts connections"), and the whole package passed in the first full run. The branch does not touch that package; these are timing flakes.
- Upgrade skill: no `pnpm.patchedDependencies` entry exists; a bare import of `alchemy` and `@alchemy.run/prisma` registers 0 signal listeners.

## Decisions made without asking

- The version's and the service's URL checks (upstream defaults) are kept for every service except one declared `listens: false`, which never answers; for it both get `verifyUrl: false`. No health-check path is passed; no Composer test or document asks for one.
- Deploy's `url` output is the service's stable domain (dde80b76); `serviceId` resolves only once the service serves the new version, because the custom domain that reads it is bound to the live version.
- The state rewrite sets a retired version row's removal policy to `retain` (the engine had recorded `destroy`), and leaves `activeVersionId` null, as upstream does.
- `prisma dev`'s state is rewritten by dev preflight in the Prisma Cloud local target, not by core, which stays target-agnostic.
- The version keeps the resource ID role `deployment` (`shop.web.deployment`), so no rename declaration is needed; `compute/deployment-edge.ts` keeps its name.
- The Write and Edit tools refused files in the new worktree (a hook allows only this session's worktree), so files there were written through the shell.

## Proof runs

### A. New application on the changed Composer (`qa-keep-versions-a1`, example `storefront-auth`)

The example has two compute services, `auth.service` (Node, with its own Postgres) and `storefront` (Next.js), and the storefront calls auth through an RPC connection whose URL is auth's domain. It reads one platform variable, `AUTH_SIGNING_SECRET`; the first `prisma deploy` stopped at the variable check, as designed, and the variable was then set through the Management API with a generated test value.

1. First deploy: created both services, the database and every variable; both URLs served (`Auth /verify says: true`). One version per service.
2. Code change (a `<p>Release: two</p>` line on the storefront page, never committed): the plan was `14 to update, 2 to replace`; both versions were replaced and the log says `Retaining replaced resource (removal policy: retain)` for each. Polling the storefront URL every second during the deploy: 40 responses `200` serving the old page, then 7 serving `Release: two`, no failure. Afterwards each service had two versions, the second live. Auth was replaced too although its code did not change: this first redeploy after a create also updates the database and connection, so auth's database URL trigger was unresolved while planning. Today's Composer does the same on its first redeploy (recorded under B).
3. No-change redeploy: the storefront got a third version. Cause: deploy's `url` output waited for the service's promotion, which runs on every deploy, so the storefront's trigger on auth's URL was unresolved every time. Today's Composer has the same fault (B's baseline third deploy replaced the storefront's deployment with nothing changed). Fixed in dde80b76: the `url` output is the service's stable domain. After the fix, the next deploy replaced the storefront once more (the trigger recorded under the old shape), and every later no-change deploy planned `13 to update`, with both versions updated and none replaced; the version counts stayed at 2 and 4.
4. Rollback: `POST /v1/services/cps_hdcjig008glx7ja4t76e0889/rollback` with the first version `cpv_sv7ccyhrbu39d1uozatczrmf`. The platform answered at once, the storefront URL served the first page (no `Release` line) within 2 seconds, and the service reported the first version live.
5. `prisma deploy` with no change after the rollback: plan `13 to update`, no replacement; the service was promoted back to the declared version `cpv_epe6mf47v1upzhf8v1ctwq6g` and served `Release: two`. No new version for either service. One more no-change deploy: same, still 2 and 4 versions.
6. Destroy: plan `15 to delete, 2 to orphaned`: the two versions were forgotten (`orphaned`), the services deleted, which removes their versions. The project `qa-keep-versions-a1` no longer exists.

### B. Upgrade of an existing application (`qa-keep-versions-b1`)

Deployed first with today's Composer, from the untouched origin/main worktree (Composer at 62a32612, alchemy 2.0.0-beta.85):

- Deploy 1 created everything: storefront `cps_ayknti5e3m8roeploevu8tuc` at `https://ayknti5e3m8roeploevu8tuc.ewr.prisma.build`, auth `cps_s6vyej00jryztcutvczxkkj9` at `https://s6vyej00jryztcutvczxkkj9.ewr.prisma.build`, database `db_ysjae4zurdl5gpe6b6rcwhu0`, and 14 variables. It served.
- For comparison, two no-change redeploys with today's Composer: the first replaced both deployments (`14 to update, 2 to replace`, the post-create database update, as in A), the second replaced the storefront's deployment again (`10 to update, 1 to replace`): today's Composer gives a service that reads another's URL a new deployment on every deploy. Each replacement deleted the old one: before the upgrade each service had exactly one version (storefront `cpv_r0ul9ymtielth63zca404wpt`, auth `cpv_bjsi7hi0hn9ysljas38gms8e`).

Then, without destroying, deployed with the changed Composer:

1. No code change. One deploy, exit 0. Plan `12 to update, 1 to replace, 2 binding changes`: the database, connection and warm-up `noop`; both services `update`; each service's active-version binding `create`; auth's version `update` (kept as it was); the storefront's version `replace`, and the log says `Retaining replaced resource (removal policy: retain)`. No `ComputeServiceIdUnavailable`, nothing created except the new storefront version. A comparison of service IDs, URLs, the database and every variable ID before and after printed no difference. The storefront answered 200 with `Auth /verify says: true` on all 30 polls during the deploy. Afterwards the storefront had two versions, `cpv_r0ul9ymtielth63zca404wpt` (made by today's Composer, kept) and `cpv_n1v48umrzthwa2r3kj3byh5m` (live). The storefront replacement is the one-time settling of its URL trigger, as in A after the fix; it is not the state rewrite (auth, whose triggers read no other service, kept its version).
2. A second no-change deploy: plan `13 to update`, no replacement, no new version.
3. Code change (`Release: two` on the storefront page). Plan `12 to update, 1 to replace`: only the storefront's version replaced and retained; auth kept its version. Polls: 24 responses of the old page, then 6 of `Release: two`, all 200 with auth answering. Three storefront versions afterwards.
4. Rollback to the version live before the code change (`cpv_n1v48umrzthwa2r3kj3byh5m`): served the old page within a second. A rollback further back, to `cpv_r0ul9ymtielth63zca404wpt`, the version today's Composer made before the upgrade, also served (200, `Auth /verify says: true`), and the service reported it live.

### D. Going back to the old Composer after the upgrade (run, on the throwaway B app)

After B's upgrade, rollbacks and code change, `qa-keep-versions-b1` was deployed again from the untouched origin/main worktree. Result: exit 1, `Plan: 11 to update, 2 to replace`, then every service failed with `Prisma App logical ID 'qa-keep-versions-b1.storefront' is already used by another App on branch ...` (and the same for `auth.service`). The six variable updates ran first and rewrote the same values. Nothing was deleted: both services, all four storefront versions and the auth version, the database and the 14 variables were still there, and the storefront kept serving (`Auth /verify says: true`).

Why, from the code: the old Composer's own state rewrite maps the type id `Prisma.ComputeService` (once Composer's own type id) to `Prisma.App`, but its rewrite of the attributes only handles the oldest shape, so the row reaches beta.85's `Prisma.App` provider with `serviceId` and no `appId`. That provider takes the service as missing and tries to create one under the same logical ID, which the platform refuses. The version replacements depend on the service, so they never start, and the old version rows were never reached for deletion. A `Prisma.ComputeVersion` row is unknown to the old engine, but it is only read as the old state of the declared `Prisma.Deployment` and was never deleted.

Recovery: the next deploy with the changed Composer succeeded (exit 0) with the same service IDs and URLs; it replaced each version once (both retained), because the old engine had left the version rows mid-replacement.

Destroy with the changed Composer: `Plan: 15 to delete, 2 to orphaned`, exit 0, `Removed the Project (proj_dg1tx4dnk4bzshgh9jupgv9p)`.

### C. `prisma dev` on the same example with the changed Composer

To prove the local state rewrite, `prisma dev --detach` was run first with today's Composer in the baseline worktree's example directory. It served (`Auth /verify says: true` on `http://localhost:3393`) and wrote Alchemy local state with two `Prisma.App` rows and one `Prisma.Deployment` row (the storefront runs `next dev`, so it has no version). After `prisma dev stop`, that directory's `.alchemy/state` and `.prisma-composer/dev` were copied into the branch worktree's example directory, which is what the same directory looks like after an upgrade.

`prisma dev` (foreground) with the changed Composer then:

- started: plan `4 to update, 1 binding changes`, the database, connection, warm-up and every unchanged variable `noop`, auth's active-version binding `create`, `dev: ready`, same ports as before (storefront 3393, auth 3392);
- had rewritten the rows before Alchemy read them: two `Prisma.ComputeService` rows (`serviceId`, `serviceEndpointDomain`, `url`, and `activeVersionId` set from the attached version) and one `Prisma.ComputeVersion` row with props `service, artifactPath, artifactContentType, triggers, portMapping, start` (no `promote`) and removal policy `retain`;
- served the storefront with auth behind it;
- picked up a storefront page edit through `next dev` within a second, and an auth source change plus `pnpm run build` within 3 seconds (plan `4 to update`, auth's version `updated`, the storefront showing the new keyCheck value);
- stopped cleanly on Ctrl-C (`Stopping the app's services — emulators and data stay up`); both ports then refused connections.

The local emulator instances this made (services `svc_401f82be13445217`, `svc_cd1e49e1d306c332`, database `db_fe6b48a322ca5f38`) are stopped with their data, as `prisma dev` leaves them; `prisma dev --fresh` from the example directory removes them.

After all runs, the Management API listed no project whose name starts with `qa-keep-versions`, and the baseline worktree was removed.

## Rerun on Alchemy 9969884b8 (2026-11-18): stopped by an upstream defect

### Setup
- The Alchemy checkout was clean, at 9969884b8. `alchemy`, `@alchemy.run/prisma` and `@alchemy.run/node-utils` were rebuilt and repacked from it into `wip/alchemy-tarballs/`. After a forced reinstall the installed provider contains `ComputeVersionNotRemoved` and the new service delete. Commit 2deed318 records the new lockfile integrity.
- No Composer code needed to change.
  - The advice-rewriting test, which reads every adoption message in the installed provider, passes.
  - The new `DeleteInProgress` message says "Run the command again", which a Composer user can follow.
  - The local target has its own service delete, so the new upstream delete does not apply there.
  - Composer's artifacts already have `compute.manifest.json` at the archive root.
- Checks:
  - `pnpm build` and `pnpm typecheck` pass.
  - `pnpm test`: 2834 pass, 1 fail. The failure is `@internal/dev-emulators` "a deployment returns only once a slow-booting service accepts connections". It fails the same way on untouched 62a32612, so it is not this branch.

### Baseline
- The upgrade app's baseline is Composer 62a32612, the branch's base, as in the first run.
- origin/main is now 67ffc2b5. It adds the input document in the artifact (#432) and Alchemy running in the prisma process (#405). Upgrading from it with this branch would also undo those two changes, so it would not test the upgrade alone. The branch needs a rebase onto main before a pull request.

### The defect
- **Symptom.** Scenario A's first deploy of `qa-keep-versions-a2` hung for about 2.5 minutes at `[qa-keep-versions-a2.auth.service.deployment] creating`. Then the deploy process died with:
  `Error: A FileHandle object was closed during garbage collection. ... (/private/var/folders/.../qa-keep-versions-a2.auth.service.tar.gz) code: 'ERR_INVALID_STATE'` (Node 26.8.1).
  The user saw `✘ plan and apply (2m 50s)`. No version was created.
- **Reproduction.** Calling the provider's `findArchiveManifest` directly on that 164 KB artifact never returns; it was still waiting after 20 seconds.
- **Cause, from `packages/prisma/src/internal/ArtifactFile.ts`:**
  1. `findArchiveManifestPromise` feeds file chunks into a gunzip stream, and the feeding loop waits for `drain` when gunzip's buffer is full.
  2. Composer's archives have `compute.manifest.json` early (entry 5). Once it is read, the function destroys gunzip and then awaits the feeding loop.
  3. A destroyed stream never emits `drain`, so that await never finishes. The chunk generator is never closed, so its `FileHandle` is never closed.
  4. Node 26 treats a FileHandle closed by garbage collection as a fatal error, which is what killed the process.
  - Upstream's test fixtures are a few hundred bytes, fit in one chunk, and never reach the `drain` wait.
- **Consequence.** Every Composer deploy that creates a version hangs and crashes on 9969884b8. So scenario A could not get past its first deploy, and scenario B's upgrade deploys (which make a new storefront version) could not be run. Neither was worked around.

### Destroy on 9969884b8
| App | State it had | Command | Result | Time | Plan | Left on the platform |
| --- | --- | --- | --- | --- | --- | --- |
| `qa-keep-versions-a2`, `proj_tooazrbgueipe5xpfyf8h7e2` | half-created by the crashed deploy: two services with no versions | `composer-destroy.ts --environment production --name qa-keep-versions-a2`, changed Composer | exit 0, `Removed the Project (proj_tooazrbgueipe5xpfyf8h7e2)` | 45 s | `15 to delete, 2 to orphaned` | nothing |
| `qa-keep-versions-b2`, `proj_vx81pvxqtbyvb9jh1vkbvnjs` | deployed three times by today's Composer: one live version per service, old-shaped state | the same command, changed Composer | exit 0, `Removed the Project (proj_vx81pvxqtbyvb9jh1vkbvnjs)` | 47 s | `15 to delete, 2 to orphaned` | nothing |

- In the b2 destroy, the state rewrite and the new service delete worked together: each version was orphaned in under a second, then each service's delete (which now stops and deletes its versions first) took 6 to 9 seconds. No `DeleteInProgress` appeared, so a rerun was not needed.
- Not exercised: a destroy of a service with several kept versions, where a version can stay in `stopping`. That needs a deploy that creates versions, which the defect blocks.

### Cleanup, by ID
- `GET /v1/projects/proj_tooazrbgueipe5xpfyf8h7e2` → 404.
- `GET /v1/projects/proj_vx81pvxqtbyvb9jh1vkbvnjs` → 404.
- No project named `qa-keep-versions*` exists.
- No Management API deletion was needed; both projects were removed by destroy.
- The baseline worktree was removed again.

## Rerun on Alchemy 91602bc38 (2026-11-18): proof complete

### Setup
- The Alchemy checkout was clean, at 91602bc38. The three tarballs were rebuilt and repacked from it, the stale installed copies removed, and the install forced. The installed `ArtifactFile.js` is byte-identical to the tarball's.
- The manifest check now returns on the real auth artifact in 4 ms; on 9969884b8 it never returned.
- Commit 3116de5c records the lockfile. No Composer code changed.
- Checks:
  - `pnpm build` and `pnpm typecheck` pass.
  - `pnpm test`: 2834 pass, 1 fail, the same `@internal/dev-emulators` timing test that also fails on untouched 62a32612.
- The upgrade app's baseline is Composer 62a32612, the branch's base.

### A. New application on the changed Composer (`qa-keep-versions-a3`, `proj_y19be7sevppx7jkun0osxjee`)
1. **First deploy:** stopped at the variable check, as designed; I set `AUTH_SIGNING_SECRET` through the Management API.
   - The next deploy succeeded in 80 s, with plan `17 to create, 2 binding changes`.
   - It created storefront `cps_ic3nhft6vhcydkyu4s0p5xdo` (`https://ic3nhft6vhcydkyu4s0p5xdo.ewr.prisma.build`), auth `cps_rendtinfcpm38u5jjk9b7m3a`, database `db_xe6htb986rzaxlb23r406be8` and 14 variables.
   - It served `Auth /verify says: true`.
2. **Code change** (`Release: two` on the storefront page):
   - Plan `12 to update, 1 to replace`. Only the storefront's version was replaced, and the log said `Replaced resource retained`. Auth's version was updated in place.
   - Polls during the deploy: 26 of the old page, then 6 of the new, all 200 with auth answering.
   - Afterwards the storefront had 2 versions.
3. **Unchanged redeploy:** plan `13 to update`, no replacement, no new version.
4. **Rollback** of the storefront to its first version `cpv_g4xz9imbv5ra4qwaogjy089h`: the old page was served within a second, with auth answering, and the service reported that version live.
5. **Unchanged redeploy after the rollback:** plan `13 to update`, no new version. The declared version `cpv_ppy85wsmfl4o9azwr8lsor19` was live again, serving `Release: two`.
6. **Destroy, first attempt:**
   - Exit 0 in 41 s. Plan `15 to delete, 2 to orphaned`.
   - The service deletes took 6.6 s and 9.4 s. No `DeleteInProgress`.
   - `Removed the Project (proj_y19be7sevppx7jkun0osxjee)`.

### B. Upgrade of an existing application (`qa-keep-versions-b3`, `proj_kyi8bc1tnoh4nl7e1jpqxu73`)
**Before the upgrade**, with Composer 62a32612: two deploys. The second, with nothing changed, replaced the storefront's deployment and deleted the old one, which is today's fault. Each service had exactly one version:
- storefront `cps_fk4f6c7iylsydqnfyiuodwre` at `https://fk4f6c7iylsydqnfyiuodwre.ewr.prisma.build`, version `cpv_oodp62wpb7j2800rxnsty7pv`;
- auth `cps_z70yfv2nkrx2dgo1wdn5bvjy`, version `cpv_lw8zvauru7n4gvbxu75jee90`;
- database `db_zx2eihvqsdsu4r68hicbwdng`, 14 variables.

**Upgrade deploys with the changed Composer:**
1. **No code change:**
   - One deploy, exit 0, 61 s, no `ComputeServiceIdUnavailable`.
   - Plan `14 to update, 2 to replace, 2 binding changes`.
   - The database, connection and warm-up planned an in-place update this time (the new provider re-reconciles them once). That left auth's database URL trigger unresolved, so both versions were replaced, and both old versions were retained.
   - A comparison of service IDs, URLs, the database and every variable ID before and after printed no difference.
   - All 35 polls returned 200 with auth answering.
2. **Second no-change deploy:** plan `13 to update`, no replacement, no new version.
3. **Code change, first try: failed, on the platform.**
   - The new storefront version `cpv_wldottvgbxsykdaamjyqz0ix` was created and checked, but when the service came to promote it the platform reported it `stopping`.
   - The deploy failed with `ComputeServiceVersionNotRunning: … the version is 'stopping', not running. Leave start at its default, true, …`. That advice does not fit Composer, which always passes `start: true`.
   - The site kept serving the old version on all 32 polls.
4. **Code change, second try** (nothing changed in between):
   - Exit 0, 38 s. Plan `13 to update`. The same version was started and promoted; no third version was made.
   - Polls: 14 of the old page, then 8 of `Release: two`, all 200.
   - The storefront then had 3 versions: the one today's Composer made, and two made after the upgrade.
5. **Rollbacks:**
   - to the version live before the code change (`cpv_ghxrs2ksaih5vc3wir0qh2wa`): served at once with auth answering;
   - to the version today's Composer made before the upgrade (`cpv_oodp62wpb7j2800rxnsty7pv`): also served, and the service reported it live.
6. **Destroy, first attempt:**
   - Exit 0 in 42 s. Plan `15 to delete, 2 to orphaned`.
   - The service deletes, which now stop and delete each service's versions first, took 9.0 s and 11.5 s. No `DeleteInProgress`.
   - `Removed the Project (proj_kyi8bc1tnoh4nl7e1jpqxu73)`.

### Destroy summary
Both destroys finished on the first attempt, so no second attempt was needed and nothing was left. The degraded `stopping` state was seen once, in the deploy at B step 3, not in a destroy.

### Cleanup, by ID
- `GET /v1/projects/proj_y19be7sevppx7jkun0osxjee` → 404.
- `GET /v1/projects/proj_kyi8bc1tnoh4nl7e1jpqxu73` → 404.
- No project named `qa-keep-versions*` exists.
- No Management API deletion was used.
- The baseline worktree is removed, and the example's temporary page edit is reverted.

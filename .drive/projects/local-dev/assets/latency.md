# Restart latency measurement (S6 Part B)

Acceptance criterion 8: "Restart-latency measurement for `examples/store`
recorded in the close-out notes (target: single-digit seconds; a miss is a
recorded follow-up, not a DoD failure)."

## Method

Mirrors `test/integration/test/local-dev-store.integration.ts`'s
`rebuildCatalogAndReconverge` technique (S5 store proving script), timed:

1. Start a real `prisma-composer dev module.ts` session against
   `examples/store` (fresh state, credential-free) and wait for
   `[dev] ready:`.
2. For each of 5 runs, against the **still-running** session (no CLI
   restart, no SIGINT — `Bundle.watch` isn't populated on this branch, so
   the file-watch loop can't fire; the manual re-assemble + re-converge
   below is the documented stand-in the S5 script also uses):
   - `t0 = performance.now()`.
   - Append a real source edit to `modules/catalog/src/server.ts` — a
     `console.log("latency-probe-run-N-<ts>")` statement (a plain comment
     doesn't survive `bun build --production`'s minifier, so the artifact
     hash wouldn't move; a side-effecting statement can't be dead-code
     eliminated).
   - Rebuild via the module's own build script: `bun run build` in
     `modules/catalog` (its `package.json`'s `build:
     "rm -rf dist && bun build src/server.ts --target=bun --outfile dist/server.mjs"`).
   - Re-run the `node()` build adapter's own `assemble()` for
     `catalog.service` (copies the freshly built `dist/server.mjs` into the
     dev bundle dir the stack file already points at).
   - Re-converge the same dev stack file directly with the real `alchemy`
     binary (`alchemy deploy .prisma-composer/dev/alchemy.run.ts --yes
     --stage dev`) — this re-hashes catalog's now-different artifact and
     PUTs a fresh deployment; the emulator's own hash diff decides which
     service(s) actually restart (only `catalog.service`, per criterion 2).
   - Poll the compute emulator's `GET /apps/store/services` (the same
     wire protocol the S5 script polls) until `catalog.service`'s `pid`
     changes from its pre-edit value — the new process is actually up and
     the emulator has recorded it.
   - `t1 = performance.now()`; record `t1 - t0`.
3. Report each run and the median.

Script: `.drive/projects/local-dev/assets/latency-probe.ts` (not part of the
shipped test suite — run once by hand, from `examples/store` as cwd so
workspace module resolution finds `@prisma/composer`/`@prisma/composer-prisma-cloud`).

## Machine

Apple M3 Max, macOS (Darwin 25.5.0), arm64.

## Results

| Run | Latency (edit → new pid observed) |
| --- | --- |
| 1 | 3.16s |
| 2 | 3.35s |
| 3 | 3.26s |
| 4 | 3.24s |
| 5 | 3.09s |

**Median: 3.24s.**

Meets the single-digit-seconds target comfortably. The bulk of the time is
`bun run build` (a real production bundle of the whole catalog service, ~20ms
per its own reported bundle time — negligible) plus Alchemy's converge pass
over all 51 resources in the graph (only 10 actually update; the rest are
diffed as no-ops) plus the emulator's own child-restart (SIGTERM the old
process, spawn the new one, wait for it to report ready). No component of
this path is watch-loop-dependent — it's the same re-assemble + re-converge
`watch.ts` would trigger automatically once `Bundle.watch` lands (tracked
separately; not on this branch — see FRICTION-S6.md and plan.md's "Known
items blocking close-out").

## Update (S6 close-out, after the merge to main)

The numbers above were measured on the pre-merge S5 branch. Two things
changed on main since and do not invalidate them:

- **`Bundle.watch` is now populated by every build adapter** (node:
  `watch: [runnable.source]`; Next.js: `watch: [standaloneRoot]`), so the
  file-watch loop fires on its own — the manual re-assemble + re-converge
  this method used is exactly what the loop now triggers automatically.
- **The seam was renamed** (`ExtensionDescriptor.dev` →
  `ExtensionDescriptor.localTarget`, now a lazy thunk). `latency-probe.ts`
  is updated to the renamed API; the rename touches no part of the measured
  path.

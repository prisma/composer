# Project plan: local dev (`prisma-composer dev`)

**Spec:** `.drive/projects/local-dev/spec.md` (exhaustive — the contract).
Design: ADR-0041 + `docs/design/10-domains/local-dev.md` (committed).

Six slices, one PR each. S1 and S2 are independent and can run in parallel;
S3 needs S1; S4 needs S3; S5 needs S4; S6 needs S2 + S5.

## Validation gates

Per slice unless stated: `pnpm typecheck`, `pnpm test`, `pnpm lint`,
`pnpm lint:deps` at the workspace root, plus the touched packages' own
scripts. Implementer dispatches use Sonnet-4.6-mid, reviewers Opus-4.8-mid
(operator's standing rule). No PR opens with a failing or skipped check.

## Slices

### S1 — `@internal/s3-protocol` extraction + disk store

- **Outcome:** new lowering-layer package holding `store.ts`, `sigv4.ts`
  (incl. `mintKeyPair`), `handler.ts`, `memory-store.ts` (moved) plus new
  `fs-store.ts` (resolver-based, sidecar metadata, dropped-file adoption).
  Pure protocol — no server/daemon. Storage module consumes it; public
  surface byte-compatible; its tests pass unmodified.
  `architecture.config.json` declares the package (spec § 1 — including the
  plane check that both import directions pass `lint:deps` **first**; a
  rejection is a stop condition).
- **Proves:** fs-store contract tests (sidecar lazily written for dropped
  files, path-escape rejection, list pagination, temp-then-rename), handler
  round-trip over fs-store via a real S3 client (`@aws-sdk/client-s3`
  devDependency in tests only) incl. presigned GET/PUT.
- **Spec sections:** § 1, behavior contracts.

### S2 — `dir()` build adapter

- **Outcome:** `@prisma/composer/dir` authoring + assemble per spec § 7:
  verbatim tree copy, named entry, symlink hard error, wrapper bundling
  identical to `node()`'s. Also lands the `Bundle.watch` contract (spec
  § 3): the optional core field plus `watch` population in `node()`,
  `nextjs()`, and `dir()`. Guide/docs entry.
- **Proves:** assemble tests (missing dir/entry errors verbatim, symlink
  error, tree fidelity); a fixture app with a multi-file runnable deploys
  through the full assemble path (no cloud needed — assemble-level test).
- **Spec sections:** § 7.

### S3 — `@internal/dev-emulators`: daemon layer + Compute & bucket emulators

- **Outcome:** the new package per spec § 2: `daemon.ts` (registry, stable
  ports ≥ 4300, readiness, version-skew restart, ensure/stop),
  `compute-main.ts` (service registry, per-(app,service) stable ports ≥
  3000, deployment PUT with hash/env diffing, bun spawn, crash
  backoff/held policy, log files + follow streams, app stop/delete),
  `buckets-main.ts` (S3 wire over fs-store with registered per-bucket dirs,
  `<app>--<name>` physical names, `/_pcdev/` admin, 501 multipart),
  `client.ts` typed loopback clients.
- **Proves:** standalone daemon tests driving the APIs directly: ensure →
  health → version-bump restart; deployment lifecycle (spawn, restart on
  hash change only, backoff, held after 5 fast crashes, log follow);
  multi-app isolation (two apps, same service and bucket names, no
  collisions); bucket admin + SigV4 round-trip via the S3 client; daemon
  survives its parent exiting.
- **Depends on:** S1.
- **Spec sections:** § 2.

### S4 — the dev target: core seam + local providers + extension `dev` field

- **Outcome:** `DevDescriptor` (+ `DevEmulatorsInput` / `DevAttachInput` /
  `DevAttachment`, `DEV_DIR`) in core; `LowerOptions.dev` +
  `mergedDevProviders`; `serviceAddress` threading
  (`ComputeSerialized.address` → `DeploymentProps.serviceAddress`);
  `@internal/lowering/dev` (dev-store, compute/postgres/bucket providers as
  emulator clients, `devProviders()`, `artifact-extract.ts`,
  `resolve-bin.ts`); target extension `src/dev/*` (container, preflight +
  shared `preflight-names.ts`, emulators, attach, teardown) and
  `prismaCloud()`'s `dev` field; the lazy `resolveOptions` restructure
  (factory constructs with no env).
- **Proves:** integration test (no CLI): a fixture topology (compute +
  postgres + bucket) lowered with `dev: true` and driven through
  `alchemy deploy --stage dev` programmatically leaves the app SERVING —
  emulator listings correct, env store correct (port override + poison rows
  + secret pointers), `prisma dev` instance running (including the spec's
  pinned stop→start port-stability verification, run FIRST — its outcome
  selects the pinned primary or fallback path), HTTP round-trip against
  the deployed fixture service; a second converge with an unchanged build is
  a full no-op (no restarts); a changed artifact restarts exactly one
  service. Plus: scrubbed-env test (`prismaCloud()` with no `PRISMA_*`);
  ustar extract round-trips `packageComputeArtifact`'s output; placeholder
  minting stable across two preflight runs; env-param missing → listing
  error.
- **Depends on:** S3.
- **Spec sections:** § 3, § 4, § 5, value-sourcing + determinism contracts.

### S5 — the `dev` command: pipeline, attach view, watch, error surface

- **Outcome:** `DevCommand` + `run-dev.ts` + shared `pipeline.ts` refactor of
  `run()`; `generate-dev-stack.ts`; the attach rendering (front door,
  merged prefixed logs); `watch.ts` (debounced rebuild → re-assemble →
  re-converge; converge failure leaves the running app untouched);
  `--fresh`; Ctrl-C = `stopServices()` + exit; every error string from the
  spec verbatim. Plus publish-safe daemon-entry resolution (spec § 2's
  publish note): `ensureDaemon` takes the entry path; public daemon-entry
  subpaths on `@prisma/composer-prisma-cloud`; the published dist resolves
  its own daemons.
- **Proves:** the spec's acceptance criteria 1–6 on `examples/store`,
  scripted as an integration test where feasible (bring-up, single-service
  restart on rebuild, warm restart after Ctrl-C with stable ports/URLs,
  `--fresh` wipe, placeholder warning) plus manual verification of log/TTY
  output; unit tests for watch debounce and endpoint ordering.
- **Depends on:** S4.
- **Spec sections:** § 6, § 8 (gitignore check), error surface.

### S6 — proof on the open-chat port + measurement + close-out docs

- **Outcome:** the open-chat port (separate repo) switched to `dir()` +
  `prisma-composer dev`, replacing `scripts/dev.ts`; sign-in/history/
  live-tail verified; friction found lands here as fixes (re-triaged if
  large); restart latency for `examples/store` measured and recorded;
  `deploy-cli.md` scope updated; `local-dev.md` + ADR-0041 reconciled with
  what shipped; port-repo changes committed there.
- **Depends on:** S2 + S5.
- **Spec sections:** acceptance criteria 7–10.

## Close-out (required)

- [ ] Verify all acceptance criteria in `.drive/projects/local-dev/spec.md`
- [ ] Final retro
- [ ] Migrate long-lived docs into `docs/` (local-dev.md/deploy-cli.md/ADR
      already live there — reconcile, don't duplicate)
- [ ] Strip repo-wide references to `.drive/projects/local-dev/**`
- [ ] Delete `.drive/projects/local-dev/`

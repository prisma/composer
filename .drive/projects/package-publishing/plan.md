# Project Plan — package publishing

## Summary

Adopt prisma-next's npm publishing setup for the `@prisma/app*` / `@prisma/alchemy`
packages, in four sequenced slices. Each slice is one PR and leaves the tree
green. Chain is strictly ordered A → B → C → D; A–C need no external access, D
depends on npm-org + repo-visibility decisions owned outside the team.

**Spec:** `.drive/projects/package-publishing/spec.md`
**Design notes:** `.drive/projects/package-publishing/design-notes.md`
**Base branch:** `main` @ `a88097d`. **#24 (rename) merged; #23 (hex composition)
was closed, not merged** — so no live export-surface collision today. Worktree
re-baselined onto merged main; stale pre-rename `makerkit-*` dirs removed.
Watch-out: if a hex-composition successor reopens and rewrites `packages/app/src/index.ts`,
coordinate — it collides with Slice A's export entries.

**Slice A detail:** `.drive/projects/package-publishing/specs/slice-a-build-pipeline.md`
(grounded inventory, build decisions, TS6×tsdown risk, task decomposition).

## Progress

- **Slice A — COMPLETE.** A1 `2f1e861`, A2 `16a02c0`, A3 `1971782`, A4 `7b0a572`.
  All 9 packages build to dist under the build-first loop.
- **OSS community files — COMPLETE** (`eed19ae`). LICENSE/CoC/CONTRIBUTING/SECURITY +
  .github/ templates, adapted from prisma-next. Repo is now public (provenance unblocked).
- **Slice B — COMPLETE.** B1 `18fa630` (version + publish-deps scripts, node --test,
  set-based internal-pin check), B2 `0433b87` (un-private the 9, license/repository/
  engines/publishConfig, lockstep at 0.1.0). Plus `2ffaaab` (lint:casts fix).
  Deviation from prisma-next: **no `sideEffects: false`** — it tree-shakes real code
  the packages' bundle-invariant tests assert on. `provenance` lives in the workflow
  env, not the manifests, to keep local `pnpm publish` from failing outside OIDC.
- **Slice C — NEXT.** publish + preview workflows.
- **Slice D — after C.** npm enablement (trusted publishing for the 9 names + unscoped
  `prisma-app`), first release, `docs/oss/versioning.md`.

## Slice sequencing

```
A  Build pipeline (tsdown → dist)          ── makes valid artifacts exist
        │
B  Publish-shaped manifests + version       ── lockstep, publishConfig, gate
        │
C  Publish + preview workflows              ── CI pipeline, dry-run green
        │
D  npm enablement + first release + docs    ── external deps; first `latest`
```

---

### Slice A — Build pipeline (tsdown → dist), exact prisma-next model

**Contract:** every publishable package emits `dist/` (`.mjs` + `.d.mts`) via
tsdown and its `exports`/`types` point at `dist` in every context (build-always,
no source/publish split — design-notes Decision 1). Dev/test become build-first,
as in prisma-next.

**Tasks:**

- [ ] Add a private shared config package `@prisma/app-tsdown` (mirror
      `@prisma-next/tsdown`): base tsdown config, `dts: true`, ESM out to `dist`.
- [ ] Add `tsdown` + a `tsdown.config.ts` and `build` / `clean` scripts to each of
      the 8 scoped publishable packages. Multi-entry packages (`@prisma/app` has
      `./deploy`, `./casts`, `./assertions`; `alchemy` has `./postgres`, `./compute`,
      `./state`; etc.) emit one dist entry per export.
- [ ] Flip each package's `exports`/`types` from `./src/*.ts` to `./dist/*.mjs` /
      `./dist/*.d.mts` (verbatim prisma-next shape). `files: ["dist","src"]`.
- [ ] `@prisma/app-cli`: tsdown `bin` entry builds `bin.ts` → `dist/bin.mjs` with a
      shebang; set `bin: { "prisma-app": "./dist/bin.mjs" }` (design-notes Decision 7).
- [ ] Add the unscoped **`prisma-app`** launcher package (bin-only, `files: ["dist"]`,
      no library exports; mirrors prisma-next's unscoped `prisma-next`). Same bin
      entry as `@prisma/app-cli`; builds its own `dist/bin.mjs`. This is the
      `bunx prisma-app` target. (9 publishable packages total.)
- [ ] Add `tsdown` to the catalog / root devDeps; align turbo `build` outputs
      (`dist/**` already declared) and add `^build` deps so consumers get built
      siblings before typecheck/test.
- [ ] Adopt prisma-next's build-first loop: a `dev` = `turbo watch build` script,
      and make `test` build package deps before running (cross-package imports now
      resolve to `dist`; within-package tests still import `./src`). Runner stays
      `bun test`.
- [ ] Update examples that import framework packages so they resolve against
      `dist` (build-first), matching how prisma-next examples consume packages.

**DoD:** `pnpm build` emits correct `dist/` for all 9; `pnpm test` / `typecheck` /
`lint` green under the build-first loop; `prisma-app --help` runs from the built
CLI (and from the unscoped launcher's dist).

---

### Slice B — Publish-shaped manifests + version source of truth

**Contract:** manifests are publish-ready and the whole workspace versions in
lockstep from root `package.json`, guarded by a pre-publish gate.

**Tasks:**

- [ ] Port `scripts/determine-version.ts` (+`determine-version-utils.ts`),
      `set-version.ts` (+`set-version-utils.ts`), `bump-minor.ts`. Apply
      design-notes Decision 2 (rewrite any `workspace:` spec; drop the
      `@prisma-next/` prefix filter) and Decision 3 (`PACKAGE_NAME` default
      `@prisma/app`). Add `pathe`/`tsx` devDeps as needed.
- [ ] Port `scripts/check-publish-deps.mjs` (+utils); make the exact-pin rule use
      the dynamic workspace-package set, not a scope prefix (Decision 2).
- [ ] Port the script unit tests; wire `test:scripts` (`node --test`) into root
      `package.json` and into CI (`ci.yml`).
- [ ] Set root `package.json` `version` to the starting base (e.g. `0.1.0`) and run
      `set-version` so every workspace `package.json` matches.
- [ ] For each publishable package: remove `private: true`; add `license`
      (Apache-2.0, matching prisma-next — confirm), `repository` with `directory`,
      `engines.node`, `files: ["dist","src"]`, `sideEffects`, and a `publishConfig`
      with `access: public` and `provenance` per Slice D. (`exports` already point
      at `dist` from Slice A — no publishConfig exports override.) Convert internal
      deps to `workspace:<version>`.
- [ ] Keep the tsdown-config package and all test/example/fixture packages
      `private: true` (still lockstep-versioned).
- [ ] `pnpm check:publish-deps` green; `pnpm pack` on each publishable package shows
      dist exports and no leaks.

**DoD:** `check:publish-deps` + `test:scripts` pass; `pnpm bump-minor` advances all
manifests in lockstep; every publishable tarball is registry-valid; tree green.

---

### Slice C — Publish + preview workflows

**Contract:** the CI publish pipeline exists and passes a dry-run without touching
the registry; per-PR previews publish to pkg.pr.new.

**Tasks:**

- [ ] Port `scripts/publish-packages.mjs` (+utils+tests) and
      `list-publishable-packages.mjs` (point its `walk('packages')` root correctly;
      makerkit publishables all live under `packages/`).
- [ ] Add `.github/workflows/publish.yml` — trim prisma-next's version to drop the
      `check:release-notes` and `check:upgrade-coverage` steps (non-goals). Keep:
      determine-version → set-version → build → `check:publish-deps` →
      publish (OIDC, provenance-gated on repo visibility) → git tag for dev → GitHub
      Release for `latest`.
- [ ] Add `.github/workflows/preview-publish.yml` + `.github/actions/detect-inert-diff/`;
      add `pkg-pr-new` devDep (pinned). Adjust the inert allow-list to makerkit's
      docs/rules paths.
- [ ] Use `jdx/mise-action` in both workflows (reads `.tool-versions`; design-notes
      Decision 6).
- [ ] Validate: `workflow_dispatch` dry-run of `publish.yml` on a branch runs green
      (build + pack + gate + `publish --dry-run`, zero registry writes). Preview
      workflow posts a pkg.pr.new comment on a test PR.

**DoD:** publish dry-run green from a branch; preview publish green on a PR; no
real registry writes yet.

---

### Slice D — npm enablement, first release, docs

**Contract:** the external prerequisites are satisfied and the first real `latest`
release ships; the contract is documented.

**Tasks (external / operator-owned first):**

- [ ] **[external]** Prisma npm admin enables OIDC trusted publishing for the 8
      scoped names under `@prisma` **and** the unscoped `prisma-app`, targeting
      `prisma/makerkit` + the `Publish to npm` workflow. Claim the unscoped
      `prisma-app` name (currently unpublished/available).
- [ ] **[external decision]** Repo visibility: make `prisma/makerkit` public
      (enables provenance) or ship first release with provenance disabled.
- [ ] Write `docs/oss/versioning.md` (adapt prisma-next's: pre-1.0 contract,
      lockstep, dist-tags, who-can-publish, mechanism, cut-the-next-minor
      procedure via `pnpm bump-minor`).
- [ ] First release: maintainer runs `pnpm bump-minor`, opens the release PR;
      merge to `main` triggers `publish.yml` → `latest` + GitHub Release.
- [ ] Confirm `npm install @prisma/app` resolves and its `dist` exports import
      cleanly from a scratch project.

**DoD:** `@prisma/app` + siblings installable from npm at the released version;
`versioning.md` published; provenance state matches the visibility decision.

---

## Close-out (required)

- [ ] Verify all acceptance criteria in `spec.md` (§ Project-DoD).
- [ ] Migrate long-lived docs: `versioning.md` already lands in `docs/`; add an ADR
      if the build-model divergence (design-notes Decision 1) warrants a durable
      record.
- [ ] Strip repo-wide references to `.drive/projects/package-publishing/**`.
- [ ] Delete `.drive/projects/package-publishing/`.

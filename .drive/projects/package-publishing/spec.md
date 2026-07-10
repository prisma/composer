# Summary

Adopt prisma-next's npm publishing setup for the Prisma App Framework packages
(`@prisma/app`, `@prisma/app-*`, `@prisma/alchemy`), so releases ship to npm
from CI with the same version-source-of-truth model, dist-tag convention,
provenance, and preview releases that prisma-next uses.

# Purpose

Today none of the framework packages are publishable: all eight are
`private: true`, carry `version: 0.0.0`, have no build step, and export raw
`.ts` source. Consumers outside this monorepo cannot install the framework.

The purpose is to make the framework installable from npm and keep it
installable on every release, using a publishing pipeline the team already
trusts (prisma-next's), so we inherit its guarantees — one-file version source
of truth, OIDC trusted publishing (no long-lived npm token), provenance
attestations, idempotent parallel publish, and per-PR previews — rather than
inventing our own.

# At a glance

- **Base branch:** `prisma/makerkit#24` (`claude/makerkit-naming-discussion-a9f953`),
  which renames the packages to the `@prisma/app*` / `@prisma/alchemy` scope.
  All work here layers on top of that rename.
- **Reference implementation:** `github.com/prisma/prisma-next` — the
  `publish.yml` / `preview-publish.yml` workflows and the `scripts/*version*`,
  `scripts/publish-*`, `scripts/check-publish-deps.mjs`,
  `scripts/list-publishable-packages.mjs` scripts.
- **Publishable packages (9):** `@prisma/app`, `@prisma/app-nextjs`,
  `@prisma/app-node`, `@prisma/app-cloud`, `@prisma/app-rpc`,
  `@prisma/app-assemble`, `@prisma/app-cli`, `@prisma/alchemy`, and the unscoped
  `prisma-app` CLI launcher (bin-only; enables `bunx prisma-app`).
- **CLI:** command `prisma-app`; invoked `bunx prisma-app` / `npx prisma-app`, or
  `bun add -g prisma-app`. Two-package split (scoped `@prisma/app-cli` +
  unscoped `prisma-app`) mirrors prisma-next's `@prisma-next/cli` + `prisma-next`.
- **Version model:** root `package.json` `version` is the single source of
  truth; every workspace package versions in lockstep; a push to `main` that
  changes the root version ships `latest`, otherwise ships `<base>-dev.N`.

# Non-goals

- **Not adopting prisma-next's release-notes gate** (`check:release-notes` +
  `docs/releases/v<version>.md`) in this project. Adoptable later; out of scope
  for first-cut publishing.
- **Not adopting the upgrade-coverage gate** (`check:upgrade-coverage`). It is
  tied to prisma-next's extension-upgrade-skill machinery, which does not exist
  in makerkit. Genuinely N/A.
- **Not building the `publish-npm-version` / `draft-release-notes` maintainer
  skills.** A maintainer runs `pnpm bump-minor` by hand for the first releases.
- **Not swapping the test runner to vitest.** Packaging/bundling follows
  prisma-next exactly (tsdown, `exports`→`dist`, build-always), which does make the
  loop build-first — but the runner stays `bun test`; adopting vitest is a
  separate follow-on decision (see design-notes Decision 1).
- **Not making the repo public or configuring the npm `@prisma` org.** Those are
  external prerequisites this project surfaces and depends on, not work it does.

# Place in the larger world

- The rename in PR #24 is a hard predecessor: package names, directories, and
  cross-package specifiers all become `@prisma/app*` there.
- The `@prisma` npm scope is owned by Prisma. Publishing requires the npm org to
  grant this repo trusted-publisher access per package — an external dependency
  owned by a Prisma npm admin, not by this project.
- npm **provenance requires a public source repo**; `prisma/makerkit` is
  currently **private**. Provenance (and arguably any public release) is blocked
  until the repo is made public — an external decision this project surfaces.
- Versioning policy mirrors prisma-next's pre-1.0 contract: breaking changes in
  minor bumps, no patch releases of old minors, lockstep across the workspace.

# Cross-cutting requirements

- **Lockstep version.** Every workspace `package.json` — publishable, private,
  and root — carries the identical `version`. One read of root answers "what
  version is this code?"
- **Internal deps pinned exactly.** Every cross-package dependency uses the
  `workspace:<version>` literal form so published tarballs carry exact `X.Y.Z`
  pins on siblings, and a CI gate (`check:publish-deps`) fails the publish if any
  `workspace:` / `catalog:` specifier or non-exact internal pin would reach the
  registry.
- **No long-lived npm token.** Publishing authenticates via npm OIDC trusted
  publishing; `NODE_AUTH_TOKEN` is never set.
- **Green-tree invariant.** Each slice leaves `pnpm build`, `pnpm test`,
  `pnpm typecheck`, and `pnpm lint` passing. The loop becomes build-first (dist is
  built before cross-package imports resolve), but the `bun test` runner stays.
- **Idempotent publish.** Re-running the publish workflow after a partial failure
  treats already-published versions as no-op successes.
- **Dry-run before real writes.** The publish pipeline (build → pack → gate →
  `publish --dry-run`) is runnable from any branch via `workflow_dispatch`
  without touching the registry.

# Project-DoD

- [ ] `pnpm build` emits `dist/` (`.mjs` + `.d.mts`) for all 9 publishable packages.
- [ ] `pnpm pack` on each publishable package produces a tarball whose
      `package.json` exports point at `dist/` and contains no `workspace:` /
      `catalog:` specifiers and no non-exact internal pins.
- [ ] `pnpm check:publish-deps` passes; `pnpm test:scripts` covers the version and
      publish helper scripts.
- [ ] `pnpm bump-minor` advances every workspace `package.json` in lockstep.
- [ ] The `Publish to npm` workflow completes a **dry-run** dispatch green on a
      branch (no registry writes).
- [ ] The `Preview Release` workflow publishes a `pkg.pr.new` preview on a PR.
- [ ] `docs/oss/versioning.md` documents the contract and the maintainer procedure.
- [ ] External prerequisites for the first real `latest` publish are documented
      and their owners named (repo→public, npm `@prisma` trusted publishing).

# Settled decisions

- **Build model:** follow prisma-next exactly — build-always with tsdown,
  `exports`→`dist` in every context. No `publishConfig.exports` divergence. The
  dev/test loop becomes build-first (`turbo watch build` for dev; build-then-test
  in CI). Test runner stays `bun test`. (design-notes Decision 1)
- **CLI command name:** `prisma-app`. (design-notes Decision 7)

# Open questions

1. **Repo visibility & provenance.** Will `prisma/makerkit` go public before first
   release? If it stays private for now, ship the first releases with provenance
   disabled and turn it on when the repo is public.
2. **npm ownership.** Confirm a Prisma npm admin will enable trusted publishing
   for the 8 scoped names under `@prisma` **and** claim + enable the unscoped
   `prisma-app` launcher name.

# References

- prisma-next: `.github/workflows/{publish,preview-publish}.yml`,
  `scripts/{determine-version,set-version,bump-minor}.ts`,
  `scripts/{publish-packages,publish-packages-utils,check-publish-deps,list-publishable-packages}.mjs`,
  `docs/oss/versioning.md`, `.github/actions/detect-inert-diff/`.
- Base branch: https://github.com/prisma/makerkit/pull/24
- Naming: ADR-0003 / memory `naming-decisions-2026-07`.

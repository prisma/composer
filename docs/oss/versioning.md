# Versioning

This page covers the **version contract** the Prisma App Framework offers, and the
**mechanism** that delivers it. The first half is the policy you can rely on; the
second half is the procedure maintainers follow to honour it.

## Pre-1.0: deliberately unstable

The framework is in early access and deliberately pre-`1.0`. Per
[SemVer §4](https://semver.org/#spec-item-4), the `0.x` range carries no
backwards-compatibility promise, and we use that latitude:

- **Breaking changes ship in regular minor bumps.** A `0.1.0` → `0.2.0` upgrade may
  include API removals, semantic changes, or authoring-contract changes.
- **Releases are frequent.** The cadence is "ship a minor whenever the next batch of
  work is cohesive enough to warrant one", not a fixed schedule.
- **There are no patch releases of older minors.** Once `0.2.0` ships, `0.1.x`
  receives no further updates. You are expected to keep up rather than pin and wait.

The promise we make instead: you can always read a single number — the root
[`package.json`](../../package.json) `version` of any commit — and know exactly what
you have.

## Lockstep across the workspace

Every workspace package — publishable, private, and the workspace root — carries the
same `version`. One read of root `package.json` answers "what version is this code?"
for the entire repository.

- The published packages (`@prisma/app`, `@prisma/app-nextjs`, `@prisma/app-node`,
  `@prisma/app-cloud`, `@prisma/app-rpc`, `@prisma/app-assemble`, `@prisma/app-cli`,
  `@prisma/alchemy`, and the unscoped `prisma-app` CLI) all publish at the same
  version, and each pins its workspace siblings to that **exact** version.
- Private packages (build config, examples, tests) are never published but still
  version in lockstep, so a contributor cloning any commit sees one consistent answer.
  `pnpm publish` skips them via `"private": true`.

If lockstep ever broke, the "one read of root tells you everything" invariant would be
silently violated, and the publish-time gate that reads the root version would be
building on a false assumption.

## Dist-tag convention

- **`latest`** — the most recent stable release; the default for `npm install
  @prisma/app`. New `latest` releases happen automatically when a release PR merges
  (see procedure below).
- **`dev`** — every push to `main` that doesn't change the root `version` produces a
  `<base>-dev.N` tarball under this tag. **No stability promise** — may be yanked freely.
- **`beta`** — reserved for hand-cut release candidates via `workflow_dispatch`.

## Who can publish

- Pushing to `main` / merging a release PR is restricted to maintainers.
- The [`Publish to npm`](../../.github/workflows/publish.yml) workflow uses
  [npm OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers) — there is
  **no long-lived `NPM_TOKEN` in repository secrets**, so a leaked secret cannot be
  used to publish out-of-band. Each published tarball carries an
  [npm provenance attestation](https://docs.npmjs.com/generating-provenance-statements)
  tying it to this repository and the workflow run that produced it (provenance requires
  the repo to be public, which it is).
- The workflow only produces a real publish from `main`. Dry-runs are permitted from any
  branch via `workflow_dispatch` (see below); every step that mutates external state is
  independently guarded.

## Mechanism: how we deliver the contract

The version we ship is the **`version` field of the root
[`package.json`](../../package.json)**. The publish workflow reads this value at the
workflow's git ref and refuses to publish anything else. There is no dispatch input to
override the version and no separate release-manifest file.

- [`scripts/set-version.ts`](../../scripts/set-version.ts) enforces lockstep: one
  invocation walks every workspace `package.json`, writes the requested version, and
  rewrites internal `workspace:` deps to `workspace:<version>` (which pnpm turns into an
  exact `X.Y.Z` pin at publish time).
- [`scripts/determine-version.ts`](../../scripts/determine-version.ts) composes the
  version + dist-tag for a run: a push to `main` whose root `version` differs from the
  previous tip is a **release bump** → publish `<base>` under `latest` + a GitHub
  Release; otherwise → `<base>-dev.N` under `dev`.
- [`scripts/check-publish-deps.mjs`](../../scripts/check-publish-deps.mjs) is a
  pre-publish gate: it packs every publishable tarball and fails the publish if any
  resolved `package.json` would carry a `workspace:` / `catalog:` specifier or a
  non-exact internal pin into the registry. Internal packages are identified by
  workspace membership (not the `@prisma/` scope, which is shared with external Prisma
  packages such as `@prisma/management-api-sdk`).
- [`scripts/publish-packages.mjs`](../../scripts/publish-packages.mjs) publishes the
  packages in parallel and is idempotent: a version already on the registry is treated
  as a no-op, so re-running after a partial failure completes cleanly.

Because the trigger is a change to the root `version`, **"merge the release PR" is the
publish trigger** — there is no separate dispatch step for a normal release.

## Procedure: cut the next minor

1. From a clean `main`, run **`pnpm bump-minor`** in a fresh branch. It reads the root
   version at `HEAD`, computes the next minor (`0.1.0` → `0.2.0`), and stamps every
   workspace `package.json`.
2. Open a PR titled `chore(release): v<version>`. CI runs normally.
3. **Merge it.** The push to `main` changes the root version, so the `Publish to npm`
   workflow recognises a release bump, publishes every package at `<version>` under
   `latest`, and cuts a GitHub Release with auto-generated notes.

Between releases, every merge to `main` publishes a `<base>-dev.N` build under `dev` —
useful for `npm install @prisma/app@dev` reproductions.

## Validating publish changes

Before merging anything that touches the publish pipeline, run the workflow's dry-run:
**Actions → Publish to npm → Run workflow**, leave **dry-run** checked. It builds, packs,
runs the dependency gate, and does `pnpm publish --dry-run` — no registry writes, no
GitHub Release. This is safe from any branch.

## One-time setup: trusted publishing (maintainers)

npm's trusted publishing is configured on each package's settings page, and **npm
cannot publish the initial version of a package via OIDC** — the package must already
exist before you can enable a trusted publisher (unlike PyPI). So the first release is a
one-time manual bootstrap; every release after that goes through the workflow:

1. **Create the packages once, with a token.** On a machine logged in to npm as a user
   with publish rights to the `@prisma` scope (and the ability to create the unscoped
   `prisma-app`): `pnpm install && pnpm build`, then
   `node scripts/publish-packages.mjs --tag latest`. This publishes all nine packages at
   the current root version with correct exact-pinned deps.
2. **Configure a trusted publisher on each of the nine packages** at
   `npmjs.com/package/<name>/access` → *Trusted Publisher* → GitHub Actions:
   - Organization or user: `prisma`
   - Repository: `app`
   - Workflow filename: `publish.yml`
   - Environment: leave blank
   - Allowed action: **npm publish**
3. From then on, remove any token you used and let the workflow publish via OIDC.

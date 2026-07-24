---
name: publish-npm-version
description: >-
  Cuts the next minor release of Prisma Composer: bumps the root
  package.json version, propagates it to every workspace package in lockstep,
  and opens a PR titled "chore(release): v<next-version>". When a maintainer
  merges the PR, the `Publish to npm` workflow runs automatically and ships the
  new version to npm under dist-tag `latest`, plus a matching GitHub Release
  with auto-generated notes. Use when a maintainer asks to "cut the next minor",
  "bump to the next version", "open a release PR", or "prepare a publish PR".
---

# Publish next npm version

## Audience

Maintainers who can push branches and open PRs. Invoke this **locally**, not as a
GitHub Action — a PR opened by a workflow's `GITHUB_TOKEN` does not trigger CI,
which defeats the point of a reviewable release.

## Background reading

Read [`docs/oss/versioning.md`](../../docs/oss/versioning.md) first — it is the
policy this skill mechanises: the root-`package.json` source of truth, the
lockstep guarantee, the dist-tag convention, and the full procedure (this skill
is the "open the bump PR" step; **merging the PR is the publish trigger** — there
is no separate dispatch step).

## Pre-flight

Confirm you can fetch from `origin` (`git fetch origin main` succeeds). The skill
works in a fresh worktree off `origin/main`, so your current worktree is left
undisturbed.

## Steps

1. **Fresh worktree off `origin/main`:**
   ```bash
   git fetch origin main
   git worktree add -b chore/release-vNEXT ../release-vNEXT origin/main
   cd ../release-vNEXT
   pnpm install --frozen-lockfile
   ```
2. **Bump.** `pnpm bump-minor` reads the root version at `HEAD`, computes the next
   minor (`0.2.0` → `0.3.0`), stamps every workspace `package.json` in
   lockstep (rewriting internal `workspace:` deps to the new version), and
   regenerates `pnpm-lock.yaml` to match.
3. **Sanity-check** the bump is clean and complete. The diff must include
   `pnpm-lock.yaml` — CI installs with `--frozen-lockfile`, so a bump without the
   lockfile fails every CI job at the install step:
   ```bash
   git diff --stat                      # every workspace package.json + pnpm-lock.yaml
   pnpm check:publish-deps              # no workspace:/catalog: leaks, exact internal pins
   ```
4. **Commit** with the release title and dual DCO sign-off, then push and open the PR:
   ```bash
   git commit -am "chore(release): v<version>"
   git push -u origin chore/release-vNEXT
   gh pr create --base main --title "chore(release): v<version>" \
     --body "Release v<version>. Merging this triggers the Publish to npm workflow."
   ```
5. **Hand off.** Tell the maintainer the PR is open and that **merging it** ships
   `<version>` to npm under `latest` (via OIDC trusted publishing) and cuts a
   GitHub Release with auto-generated notes. Do not merge it yourself unless asked.

## What this skill does NOT do

- **Patches / old minors.** There are no patch releases of older minors
  (versioning.md § pre-1.0). This skill only advances the latest minor.
- **The publish itself.** That is the `Publish to npm` workflow, triggered by the
  merge — never run `pnpm publish` by hand for a normal release.
- **Release notes authoring.** The GitHub Release notes are auto-generated
  (`gh release create --generate-notes`) by the workflow; there is no committed
  release-notes file to write.

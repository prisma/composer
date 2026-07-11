# Contributing to Prisma App Framework

Thanks for your interest in the Prisma App Framework. This document is the entry point for external contributors: you do not need any maintainer-onboarding material to file a bug report or open a PR.

## Status — please read first

The Prisma App Framework is **pre-1.0**. While we are pre-1.0:

- **Expect breaking changes between minor versions.** APIs, authoring contracts, on-disk formats, and CLI flags can shift without a deprecation cycle.
- **Only the latest minor receives security fixes.** Older minors are not backported. See [`SECURITY.md`](./SECURITY.md).
- **Don't build production applications on it yet** unless you are prepared to follow upgrades closely.

## Before you start a substantive change

For typo fixes, doc nits, small bug fixes, and obvious improvements: **just open a PR**.

For anything substantive — a new feature, a refactor, a new capability, or anything you are not confident a maintainer would automatically agree with — **please open an issue first** so we can give you direction-fit feedback before you invest implementation time. This saves both sides effort: a half-day issue conversation can prevent a one-week PR rewrite.

If your change is substantial, expect that landing it may require coordination on follow-up work (docs, examples, related packages). Maintainers will tell you if that's the case when you open the issue.

## Prerequisites

You need:

- **Node.js** matching the version pinned in [`.tool-versions`](./.tool-versions) (currently `24.16.0`). We recommend installing via [`mise`](https://mise.jdx.dev/), which reads `.tool-versions` directly.
- **pnpm** via Corepack: run `corepack enable` and then any `pnpm` command uses the version pinned by `packageManager` in [`package.json`](./package.json). Do not install pnpm globally with another package manager.
- **bun** (currently `1.3.13`, also pinned in `.tool-versions`) — the package test suites run under `bun test`.
- **git** with commit signoff configured (see [DCO](#developer-certificate-of-origin-dco) below).

## Setup

```bash
git clone https://github.com/prisma/app.git
cd app

corepack enable                      # if you haven't already
pnpm install --frozen-lockfile
pnpm build                           # builds every package to dist (required before cross-package tests)
```

If `pnpm install` warns about a Node version mismatch, your shell isn't pointing at the Node version in `.tool-versions`; fix your environment rather than working around it.

## Running checks

The repository uses [Turbo](https://turbo.build/repo/docs) to scope tasks to changed packages, so most commands are fast on warm caches. The `test` and `typecheck` tasks build the packages they depend on first, so you don't need a manual `pnpm build` before them.

| Change scope        | Command             |
| ------------------- | ------------------- |
| Type errors only    | `pnpm typecheck`    |
| Lint / formatting   | `pnpm lint`         |
| Package tests       | `pnpm test`         |
| Repo script tests   | `pnpm test:scripts` |
| Build all packages  | `pnpm build`        |

Other useful commands:

```bash
pnpm lint:fix                        # auto-fix lint issues
pnpm format                          # format with Biome
```

Before opening a PR:

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

## Developer Certificate of Origin (DCO)

Every commit on a PR must be signed off under the [Developer Certificate of Origin 1.1](https://developercertificate.org/). The DCO is a lightweight statement that you have the right to submit the contribution under the project's license (Apache-2.0); it is *not* a Contributor License Agreement and does not transfer copyright.

To sign off a commit, append a `Signed-off-by:` trailer with `git commit -s`:

```bash
git commit -s -m "feat(app): add SomeFeature"
```

This adds:

```text
Signed-off-by: Your Name <your.email@example.com>
```

The trailer name and email must match the commit author. If you forget, you can sign off the most recent commit with:

```bash
git commit --amend --signoff
```

A GitHub status check will fail if any commit on the PR is missing a `Signed-off-by:` trailer that matches the author.

## Pull request expectations

When you open a PR, the [pull request template](./.github/PULL_REQUEST_TEMPLATE.md) will be pre-filled. Please:

1. **Link the issue you opened** (or "n/a — small change" if you skipped step 1 because the change was small).
2. **Summarise the change** in one or two sentences focused on *why*, not file-by-file *what*.
3. **List the testing you ran.** "Ran `pnpm test`" is fine for small changes; bigger changes should run more.
4. **Confirm DCO signoff.** The status check will tell you if anything is missing.

A few conventions that will save review round-trips:

- **One logical change per PR.** If you find an unrelated bug while working, file a separate issue or open a separate PR.
- **Conventional commit titles.** PR titles drive the auto-generated GitHub Release notes, so `feat(app): support inline dependencies` is more useful than `update app`. Common prefixes: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `build`.
- **Update tests in the same PR.** A behavioural change without a test usually triggers a review comment asking for one.
- **No backward-compat shims.** This is a pre-1.0 codebase; if you change an API, update the call sites instead of leaving an alias behind.

## Reporting bugs

Use the [bug report issue template](./.github/ISSUE_TEMPLATE/bug_report.yml). Please include:

- The published package and version (e.g. `@prisma/app@0.1.0`, or the `prisma-app` CLI version).
- A minimal reproduction (the smaller the better — we cannot triage "my whole app is broken" reports without isolation).
- Expected vs actual behaviour.
- Whether you are on the latest minor; if not, please upgrade and re-verify before filing.

## Reporting security issues

**Do not file public issues for security reports.** See [`SECURITY.md`](./SECURITY.md) and follow the GitHub Private Vulnerability Reporting flow.

## Discussion / questions

Open-ended questions, design feedback, or "is this the intended way to do X" go to the **[Prisma Discord server](https://pris.ly/discord)**. For specific bugs or concrete feature requests, please use issues — Discord conversations are easy to lose.

## Code of Conduct

Participation in this project is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md). To report a possible violation, see the reporting section there.

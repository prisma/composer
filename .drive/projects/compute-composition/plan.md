# Compute composition: plan

The design is [design.md](design.md). It is the specification for every piece of work below. This plan only says who does what, in what order, and how each piece is checked.

## Purpose

A person who deploys a Compute service, with Composer or with Alchemy's `Prisma.Compute`, can roll it back in the Prisma Cloud console, because a deploy keeps the previous version. Composer and other Alchemy users run the same code to ship a version.

## Pieces of work

Each piece is one pull request.

| # | Piece | Repository | What a person can do afterwards | Depends on |
| --- | --- | --- | --- | --- |
| A | The Alchemy change | `alchemy-run/alchemy`, built on `wmadden-electric/alchemy` | Declare `Prisma.ComputeService`, `Prisma.ComputeVersion` and a composed `Prisma.Compute`; a new version no longer deletes the previous one | nothing |
| B | Composer keeps previous versions | this repository | Deploy with Composer, then roll back in the console | A merged and released |
| C | Composer declares `Prisma.Compute` | this repository | A Composer deploy checks a new version's health before making it live | B |
| D | An unchanged deploy creates no new version | this repository | Deploy an app twice with nothing changed, and a service that reads another service's URL keeps its version | nothing known; see below |

Piece A is not opened as a pull request by the bot. When its branch is ready, Will gets the compare link and the description file, with the list of breaking changes at the top (design section 9).

## Standing decisions

- Other Alchemy users' code is not kept compatible. Their deployed services must not be damaged: an upgrade carries on with the same service, or stops with a clear error.
- Until the Alchemy maintainers say how many people use the Prisma provider, old `Prisma.Compute` stacks get the clear error, not an upgrade path.
- Review artifacts under `reviews/` are local and never committed.

## Where the work happens

- Piece A: a fresh checkout of `alchemy-run/alchemy` at `wip/alchemy-compute` in this worktree, on branch `feat/prisma-compute-composition`, pushed to the remote `bot` (`git@github-wmadden-electric:wmadden-electric/alchemy.git`). The older clone at `wip/alchemy` is reference only.
- Pieces B and C: a fresh branch in this repository.

## Open items

- Ask the Alchemy maintainers how many people use the Prisma provider besides Composer (Will).
- Why the root modules `ComputeService` and `ComputeVersion` were removed from the package earlier (find in the full history during piece A).

## Piece D: an unchanged deploy creates no new version

Recorded 2026-11-18 at Will's request, as a later piece of work with its own pull request.

**What happens today, on main.** A service that reads another service's URL gets a new version on every `prisma deploy`, even when nothing changed. In the `storefront-auth` example the storefront reads the auth service's URL. Each deploy replaces the storefront's version, and today that also deletes the previous one.

**Why.** The URL a service publishes comes from its deployment, and that value is not known until the deployment has been promoted. The reading service's `triggers` include that URL, so at planning time they are unresolved, and an unresolved trigger counts as changed.

**The fix found while proving piece B.** Read a service's `url` output from the service's stable domain, which is known at planning time. It is commit `dde80b76` on the branch `feat/compute-keeps-previous-versions`, in the worktree `.claude/worktrees/compute-keep-versions`. After it, the first deploy still replaces the reading service's version once, and later unchanged deploys replace nothing.

**To do.**

- Take that fix out of piece B's branch into its own pull request, with a test that deploys twice unchanged and sees no new version.
- Find out whether it can ship on main before the Alchemy change is released. The cause exists on main today, so it probably can, but that has not been checked.
- Check the other outputs a service publishes for the same problem.

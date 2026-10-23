# Handover: node-addressing project

Written 2026-10-23 by agent brunhilde-44 for the next agent. Read this first, then the files it links. You work for Will Madden (`madden@prisma.io`), who makes design decisions; you execute with the Drive process (`/drive-process`) and ask him as rarely as possible. Follow `~/.claude/CLAUDE.md` and the repo's `CLAUDE.md` exactly: name yourself first, read the design docs before any design opinion, write plain English, act as the `wmadden-electric` bot for git and GitHub, turn on Auto-fix for every PR you open and follow it to merge.

## Where to find the full context

- **Previous session's transcript** (the whole design discussion, every decision and correction): `/Users/will/.claude/projects/-Users-will-Projects-prisma-composer--claude-worktrees-composer-destroy-discussion-56c939/c88b7a0c-7a0a-48cf-823d-46cdaa0a9ad8.jsonl`. It is large; search it rather than reading it whole. The session in the app: `claude://claude.ai/epitaxy/local_d8cff239-c134-4d67-8d00-e695a9dfc40e`.
- **Project files on the branch** `drive/fully-qualified-node-addresses` (pushed to `prisma/composer`):
  - [spec.md](spec.md): purpose, non-goals, project done conditions.
  - [design-notes.md](design-notes.md): every decision with its reason and rejected alternatives. Treat it as settled.
  - [plan.md](plan.md): the slices and their order.
  - [assets/spike-alchemy-renames.md](assets/spike-alchemy-renames.md): real-platform evidence that Alchemy renames keep data.
  - `slices/a1-fully-qualified-identity/`: slice A1's spec, dispatch plan and the two review files under `reviews/`.
  - `.drive/deferred.md`: the deferred `deploy delete` design.
- **Will's memory notes**: `/Users/will/.claude/projects/-Users-will-Projects-prisma-composer/memory/project-node-addressing-teardown.md` and the feedback files indexed in that folder's `MEMORY.md`.

## What the project is

It started as "should Composer have a `destroy` command?" and became this:

1. **A node's address is fully qualified and is its only identity.** `shop`, `shop.catalog`, `shop.auth.api`; the root's address is the deployed app name. The platform `logicalId` is that string. Alchemy resource IDs are `<address>` or `<address>.<role>`. `COMPOSER_` env keys come from the full address with `-` turned into `_`. `serviceOrigin()` takes the full address. Will rejected any second form of identity ("address" vs "path"); do not reintroduce one.
2. **Existing apps migrate on their next deploy** through Alchemy `renamedFrom` declarations on every resource, with no data loss. Will does not care about an older Composer deploying after the migration.
3. **Deploy's entry file moves into `prisma.config.ts`** (`composer({ entry })`), with `--entry` overriding it; the positional argument goes away.
4. **Platform commands accept a node address as their subject**: `prisma service logs @pr-42:shop.api`. Positional only; no `--node` flag. No stage means production. The API already supports the lookups.
5. **`prisma deploy list [--stage]`** lists a stage's nodes with address, kind, platform ID and URL.
6. **Teardown uses platform commands, not a Composer command.** `prisma project delete` already works with live compute (checked in pdp-control-plane code). A new cascading Branch delete in the Management API plus `prisma branch delete <name> --confirm <name>` covers one stage. `deploy delete` is deferred, design kept.

`--stage` keeps its name: it is Alchemy's target-neutral term. Do not propose renaming it.

## State of each slice (see plan.md)

| Slice | Repo | State |
| --- | --- | --- |
| Spike | composer | Done. All answers yes. |
| A1 Fully qualified identity + migration | composer | See "A1 status" below. |
| A2 `prisma deploy list` | composer | Not started. Starts after A1 merges. |
| A3 Entry in the config | composer | Not started. A proposed session card exists in the app ("Node addressing A3: deploy entry in the config"). |
| B1 `@stage:address` in platform commands | prisma/prisma-cli | Not started. Will has not yet said whether to start it. |
| B2 Cascading Branch delete + reject `:` in Branch names (PRO-225) | prisma/pdp-control-plane | Not started. Same. |
| B3 `prisma branch delete` | prisma/prisma-cli | Not started; needs B2 deployed. |
| Docs direct change | composer | Mostly done inside A1 (guides now say `project delete`). Still to do: remove CI's out-of-date `deleteProjectDeep` 409 workaround in `scripts/ci-cleanup-utils.ts`; document `branch delete` once B3 ships. |

PRO-225 (Product team, Linear) asks the platform to reject `:` in Branch names. TML-3605 was canceled; Will tracks Composer work outside Linear, so no Linear issues for slices.

## A1 status

_Updated at the end of the session; see the last section._

## How to work

- Clone sibling repos fresh into this worktree's `wip/` (git-ignored) before citing them. Never cite `~/Projects/prisma/*` checkouts; they are stale.
- QA credentials: `~/.config/prisma-compose/deploy.env` (PDP token and workspace). Use them; do not ask Will. Name test Projects so they are obviously yours and delete them afterwards.
- Implementer and reviewer subagents: always pass `model: opus` explicitly.
- Commit with `git commit -s --trailer "Signed-off-by: Will Madden <madden@prisma.io>"`; push with `git push bot <branch>`.
- PRs: lead with a grounding example, then a narrative, alternatives last; put `Agent: <your name>` above the attribution line; turn on Auto-fix; once Will approves, turn on squash auto-merge and watch until merged.

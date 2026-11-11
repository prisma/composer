# Handover: platform-variables project, prisma/composer

Written 2026-11-11 by hipparchus-99 for the next agent. Read this whole file before doing anything.

## Where things stand

- **Project:** platform-variables, in prisma/composer. It lets an app declare the values the operator sets on Prisma Cloud as nodes in its graph, and makes `prisma deploy` stop copying local values to the platform.
- **Slice 1, "The root is written with `appRoot()`":** merged as prisma/composer#421.
- **Slice 2, "The deploy stops copying local values":** merged as prisma/composer#426 (squash `ab3b4f7a`).
- **Slice 3, "A platform variable is a node":** the design is written and reviewed, and is **waiting for Will's approval**. No code is written. Branch `claude/platform-variables-s3`, pushed to the `bot` remote; its four commits are all design documents.
- **Slice 4, "A platform variable has a schema":** not started. Its spec is written after slice 3 merges.

**Your next step:** ask Will whether he approves the slice 3 design in [slices/3-a-platform-variable-is-a-node/spec.md](slices/3-a-platform-variable-is-a-node/spec.md). He was about to read it when this session hit a rate limit. Do not start building until he says yes. If he asks for changes, make them, then run them past the architect and principal-engineer reviewers again (see "How to run a design review" below).

## The documents, in reading order

All under `.drive/projects/platform-variables/` on the branch:

1. [spec.md](spec.md): the project spec. Requirements R1 to R8, decisions D1 to D15, terms, out of scope.
2. [plan.md](plan.md): the four slices, each with its decision, what is true after it merges, and what QA checks on Prisma Cloud.
3. [design.md](design.md): the full design, authoritative for behaviour. Section 3 records platform facts checked on 2026-11-06.
4. [slices/3-a-platform-variable-is-a-node/spec.md](slices/3-a-platform-variable-is-a-node/spec.md): the slice 3 design. It leads with the decision and a requirements table, walks the flow end to end, gives every type, rule, message, file and test, and ends with alternatives considered.
5. [deferred.md](deferred.md): work deliberately left for later, each with its reason.
6. The merged slices' specs: `slices/1-the-root-is-written-with-approot/spec.md`, `slices/2-the-deploy-fills-nothing/spec.md`.
7. The records slice 2 wrote: `docs/design/90-decisions/ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md`, and ADR-0029, 0032, 0042, 0058, 0062 as rewritten.

## Slice 3 in one paragraph

A value the operator supplies reaches an app in exactly two ways: a **root input field**, filled at deploy from the `config` and `secrets` adapters; or a **platform variable node**, `provision(variable({ name }))` or `provision(variable.secret({ name }))` in an `appRoot()` body, read by the service at boot. `provision()` returns the value itself, so the root passes it down through module inputs. Only `appRoot()` can provision one, and the compiler enforces it with an error that names `appRoot()`. Core gains a "value resource": a resource node that keeps its value hidden so only `provision()` can take it out. **`envSecret()` and `envParam()` are removed** (Will's decision on 2026-11-11, for one consistent mechanism); the spec lists every piece of code that goes, and the release note is a migration guide. Internal Prisma apps that use the removed functions (`prisma/streams`, `prisma/asks`, `prisma/program`, `prisma/pdp-control-plane`) and the docs in `prisma/skills` and `prisma/web` are follow-ups in their own repositories, recorded in `deferred.md`.

## Context that is not in the documents

- **The full session transcript:** `/Users/wmadden/.claude/projects/-Users-wmadden-Projects-prisma-composer--claude-worktrees-module-input-handover-b64d55/ba1ecc57-be6d-454b-848e-8925945cfa1e.jsonl`. It is large; search it for a topic rather than reading it whole.
- **Local files the branch does not carry** (gitignored by rule; still on disk in the old worktree):
  - Slice 3 design reviews, three rounds each: `/Users/wmadden/Projects/prisma/composer/.claude/worktrees/module-input-handover-b64d55/.drive/projects/platform-variables/slices/3-a-platform-variable-is-a-node/reviews/design-architect.md` and `design-principal-engineer.md`.
  - The slice 3 code grounding (what exists in the code, with line numbers): `/Users/wmadden/Projects/prisma/composer/.claude/worktrees/module-input-handover-b64d55/wip/pv-review/slice3-grounding.md`.
  - Slice 2's review artifacts and QA logs: the same worktree's `.drive/projects/platform-variables/slices/2-the-deploy-fills-nothing/reviews/` and `wip/qa-slice2/`.
  - Platform check evidence: `wip/pv-review/platform-checks.md`, `platform-check-4.md`.
- **A side session** investigates why the CI job "Deploy, verify, destroy (bucket)" sometimes hangs for 30 seconds on Prisma Cloud: session "Bucket e2e check hangs instead of failing upstream". It is not part of this project. Do not relay its notes; Will reads it himself.

## How Will wants the work done

These are his standing rules. Most are also in `~/.claude/CLAUDE.md` and the memory files under `~/.claude/projects/-Users-wmadden-Projects-prisma-composer/memory/`; read both.

- **Name yourself first** with `bash ~/.claude/scripts/agent-name.sh`, put the name in the session title, and add `Agent: <name>` above the attribution line in every PR.
- **Design with Will, then execute without interrupting him.** He makes high-level decisions; make engineering decisions yourself. Never use the question UI. When something truly needs him, explain it once with your recommendation.
- **The Drive process** (`/drive-process`): spec, dispatch plan, build each dispatch with an Opus implementer (`model: "opus"`), review each dispatch as it lands, then `/drive-code-review` on the slice, fix findings, QA on Prisma Cloud, PR.
- **`/drive-code-review` reviewers** are started with the skill itself and read `.drive/CODE-REVIEW.md`. Do not hand them a brief of your own instead. On slice 2, reviewers briefed by hand passed 146 rule violations Will then found.
- **Every implementer brief** carries his rules in full: no comments unless the code cannot say it; no shortcut explained by a comment; no multi-line shell in a YAML `run:` step (use a script); plain English (ISO 24495-1); never "load-bearing", "gate", "smoking gun", "belt and suspenders"; never hard-wrap markdown; no bare `as` casts; state a current choice with its reason, never as a permanent "never".
- **Never run the full integration or e2e suites locally.** In `test/integration`, `pnpm test <file>` runs the whole suite; use `bun run test/<file>`. Postgres-backed package tests fail locally for want of shared memory; CI covers them.
- **No temp directories.** Keep working files under `wip/` (gitignored). Never commit `wip/` or `.drive/**/reviews/`.
- **Git:** commit as the bot with `git -c core.hooksPath=/dev/null commit -s --trailer "Signed-off-by: Will Madden <madden@prisma.io>"`, ending the message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push only through the `bot` remote.
- **PR descriptions** open with a concrete example, state the decision, build the explanation step by step, and end with alternatives. The title says what changes for a user. Read it as a teammate without context before opening.
- **After Will approves a PR, merge it on green CI without asking.**
- **Prisma Cloud QA credentials:** `set -a; . ~/.config/prisma-compose/deploy.env; set +a` and `export PRISMA_REGION=us-east-1`. Never print the values. Destroy every project you create and confirm it returns 404.

## How to run a design review

Spawn two Opus subagents. Each reads its persona file whole (`~/.claude/skills/drive-agent-personas/personas/architect.md` or `principal-engineer.md`), `.drive/CODE-REVIEW.md`, the design, its sources and the code it names, and writes its findings next to the spec under `reviews/`. Fix every finding, then send the revised design back to the same reviewers until they report no open findings. Then show Will.

## After Will approves slice 3

1. Write the dispatch plan (`slices/3-a-platform-variable-is-a-node/plan.md`), about five dispatches: core value resources and provision types; the target's constructors, graph check and serializer/preflight; `prisma dev`; the removal of `envSecret()` and `envParam()` with the examples; records, guides and skill.
2. Build each dispatch with an Opus implementer, reviewing each as it lands.
3. Run `/drive-code-review` on the whole slice; fix the findings.
4. QA on Prisma Cloud as the spec's "Done when" lists.
5. Open the PR with a migration guide; merge on Will's approval and green CI.
6. Then slice 4.

# Next-session brief — Prisma App Framework

You're picking up the **Prisma App Framework**, the authoring layer for Prisma Cloud:
developers describe services and their typed dependencies in TypeScript, and
the framework deploys them to Prisma Compute + Prisma Postgres. Work runs
under the **Drive process** (`drive-process` skill). The **authoring-layer
project is closed** — R1–R9 all shipped and merged; there is currently no
active `.drive/projects/` project for this stream (open one when work starts).

## What the system is now (read in this order)

1. `docs/design/10-domains/core-model.md` — the complete type-level design:
   `compute({deps, build})` declarations, `run`/`load`, the Target SPI, the
   four planes, the invariants. The build contract for everything.
2. `docs/design/10-domains/connection-contracts.md` — typed service-to-service
   Contracts (`contract()`/`rpc()`/`serve()`, assignability + `satisfies()` +
   per-call validation).
3. `docs/design/10-domains/deploy-cli.md` — `prisma-app deploy <entry>`: the
   zero-config pipeline (Load → infer target → assemble → generated stack →
   Alchemy).
4. `docs/design/90-decisions/` — ADR-0003…0012. The state-store set
   (0009–0012) covers hosted deploy state, the deploy lock, targets supplying
   the state layer, and the deliberate SQL-not-Prisma-Next deferral.
5. `docs/design/03-domain-model/layering.md` — the three planes and the
   provisioning-state spectrum.
6. `.cursor/rules/` — hard repo rules (no bare `as` — blindCast/castAs +
   CI ratchet; type predicates; git staging/DCO).
7. `gotchas.md` — real platform footguns (PRO-200/211/212/213, FT-5219/5220).

## Likely next work

- **Naming/rename**: an operator design session settled **Prisma App Framework
  (`@prisma/app`) replacing "MakerKit" and Module/`mod()` replacing Hex** (see
  agent memory `naming-decisions-2026-07`); the rename has since shipped as
  ADR-0014 (framework: Prisma App, unit: System, not Module). Confirm any
  remaining scope with the operator.
- **In-memory/mock contract bindings** — first capability slice on the backlog
  (`.drive/deferred.md` § Capability backlog): bind a contract slot to a
  co-located handler or mock; tests + local dev without deploy. Starts with a
  design pass (where the binding decision lives in wiring).
- The rest of the backlog + the two **unfiled platform asks** live in
  `.drive/deferred.md`.

## How we work

- Drive process; slices are one PR; propose plans before coding; operator
  confirms scope. Implementer subagents: Sonnet (mid); reviewers: Opus (mid).
- **Prove it live**: a slice's bar is a real deploy to Prisma Cloud
  (`examples/storefront-auth` round trip renders `auth.verify() → ok`). CI's
  E2E does deploy/verify/destroy for both examples + a no-op-redeploy check.
- **Commits**: DCO — every commit `-s` plus the operator trailer
  (`--trailer 'Signed-off-by: Will Madden <madden@prisma.io>'`); the shell env
  authors as the willbot identity. Stage explicitly, single-quoted messages.
- **Code-review artifacts are never committed** (operator rule): write
  reviews under `wip/`, deliver findings via chat/PR threads.
- Reply to operator PR review comments **in-thread**, per comment.

## Environment footguns

- **Nested checkouts are NOT part of this repo**: `datahub/`, and any of
  `ignite/`, `pdp-control-plane/`, `prisma-next/` if present. Never edit,
  stage, or scan them (gitignored + biome-excluded, as are `.agents/`,
  `.claude/`).
- **Deploy credentials**: untracked `.env` at the main checkout root
  (`~/Projects/prisma/makerkit/.env`) — copy to each new worktree root.
  `PRISMA_SERVICE_TOKEN` + `PRISMA_WORKSPACE_ID` are all a deploy needs.
  Never print secrets.
- **Deploy state is hosted** (ADR-0009): no local `.alchemy` state matters;
  any credentialed machine deploys incrementally. The workspace shows a
  `prisma-app-state` project — control-plane, never delete it as cleanup.
- **turbo 2 strict env** strips undeclared vars from tasks — declare in
  turbo.json (`env`/`globalPassThroughEnv`). Check this first when CI-only
  failures make no sense.
- **State-store tests** need a real Postgres: the harness self-spawns via
  Homebrew `postgresql@15` locally (`LC_ALL=C`), or `STATE_TEST_DATABASE_URL`
  points at a server (CI uses a service container and fails loudly if absent).
- **Workspace ids** circulate two shapes (`wksp_`-prefixed and bare) —
  normalize before comparing.
- Push agent branches only via the bot SSH remote (`bot`), never origin;
  `gh` acts as the wmadden-electric bot.

# Emulator commands — project plan

**Spec:** `.drive/projects/emulator-commands/spec.md` · **Design notes:** `design-notes.md`

## Slices

### S1 — Emulators know nothing about Composer (prisma/composer)

**Outcome.** The Compute, Postgres and bucket emulators key instances by their own ids, accept and return free-form labels, and each lists all its instances. The Prisma Cloud local target creates instances, labels them, and records the per-directory mapping in `.prisma-composer/dev/`. Every Composer operation on the emulators goes through the mapping: deploy, session start and stop, logs, `--fresh` teardown. `prisma dev` behaves the same from outside, except that pre-upgrade local state is discarded. Two directories running one app get separate instances. Port allocation keeps its current rule on a first start: services reserve ports in dependency order (prisma/composer#350), lowest free from 3000. An instance keeps its port from creation until it is deleted, stopped or not, so a directory's ports never change. The mapping remembers each node's port and requests it when an instance has to be re-created. When `prisma dev` ends it stops all of the directory's instances, Postgres servers included (the Postgres emulator gains a stop that keeps data).

**Builds on:** prisma/composer#353 (stack on its branch until it merges).
**Hands to S3:** the mapping file and its reader; the emulator client's list-everything calls; ADR amending ADR-0041.

Likely too large for one review: split at pickup into Compute (with the mapping and remembered ports), then Postgres and buckets (with the Postgres stop).

### S2 — A command path can also be a group (prisma/prisma-cli)

**Outcome.** The CLI engine accepts a command mounted at a path that other commands mount under. `prisma dev module.ts` runs the command, `prisma dev url gateway` runs the subcommand, a subcommand name wins over a positional argument with the same spelling, and `prisma dev --help` shows the command's usage and its subcommands. Proven with engine tests using a stand-in command; no Composer change needed.

**Builds on:** nothing. Runs in parallel with S1.
**Hands to S4:** an engine release that allows the `dev` mount.

### S3 — `prisma dev url`, `prisma dev stop` and `prisma emulator list` (prisma/composer)

**Outcome.** The command family exports `dev url`, `dev stop` and `emulator list` with tests first (bun:test; emulator tests set `PRISMA_COMPOSER_EMULATORS_DIR` to a temporary directory). The core local-target attachment gains the resolve-one-address method. Error codes are recorded in ADR-0044. A new ADR amends ADR-0050 (the family is no longer exactly `deploy` and `dev`). `local-dev.md`, the running-locally guide and the core-concepts skill are updated, including that `start` and `stop` are planned.

**Builds on:** S1.
**Hands to S4:** a Composer release containing both commands.

### S4 — Mount the commands (prisma/prisma-cli)

**Outcome.** The `prisma` binary pins the Composer release from S3 and mounts `dev url`, `dev stop` and `emulator list`, with an `emulator` group whose help defines "emulator", `mount-coverage.test.ts` updated, and `EXCLUSIONS` entries in `e2e-coverage.test.ts`.

**Builds on:** S2, S3 (released).
**Hands to S5:** a `prisma` release with both commands.

### S5 — Docs stop hard-coding ports (prisma/web)

**Outcome.** The Composer getting-started and local-development pages use `prisma dev url` instead of `localhost:3000`/`3001`.

**Builds on:** S4 (released).

## Sequence

```
#353 ─► S1 ─► S3 ─┐
                  ├─► S4 ─► S5
S2 ───────────────┘
```

S1 and S2 run in parallel. S4 and S5 wait on releases, which are currently blocked on an upstream Alchemy issue.

Five slices is one over the usual ceiling. S4 and S5 are small handoffs into other repos, and each one waits on a release, so they can't fold into a neighbour.

## Tracking

No Linear project exists for this work. Slices are tracked in this plan.

## Close-out

- [ ] Verify every Project DoD item in `spec.md`.
- [ ] Long-lived content lives in ADRs, `docs/design/10-domains/local-dev.md`, the guide and the skill.
- [ ] Strip repo-wide references to `.drive/projects/emulator-commands/`.
- [ ] Delete `.drive/projects/emulator-commands/`.

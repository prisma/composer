# Node addressing — plan

**Spec:** [spec.md](spec.md) · **Decisions:** [design-notes.md](design-notes.md)

Six slices in two independent tracks, plus one spike and one small docs change. Six is above the usual limit of four. The tracks live in different repositories and share no code, so they run in parallel with no coordination beyond the address format, which is already settled. Splitting them into two projects would add bookkeeping without reducing coordination.

Tracking: Will tracks this work outside Linear, so no Linear issues are created. PRO-225 already exists for the platform's `:` rule.

## Spike: verify upstream Alchemy behaviour

Before slice A1. Deploy a fabricated test app with QA credentials and answer, with evidence:

1. Does a rename declaration whose old ID is not in the state (a new stage) deploy cleanly?
2. If a deploy fails partway through the renames, does the next deploy finish them?
3. Do Alchemy and the platform's hosted state accept dots in resource IDs?

**Hands to A1:** a short findings note in `assets/`. If any answer is no, return to design discussion before A1 starts.

## Track A — Composer (prisma/composer)

### A1. Fully qualified node identity, with automatic migration

Addresses include the app name. `logicalId`s, topology nodes, Alchemy resource IDs and `COMPOSER_` keys are built from them as the design notes describe. Every resource declares a rename from its old ID. `serviceOrigin` and `dev url` take the full address. Local dev's record is rewritten on first run. The topology root uses the deployed app name (fixes the `--name` mismatch). The identity decision record is replaced, and the principles, glossary and domain docs are updated in the same PR.

- **Builds on:** the spike.
- **Hands to:** every deployed stage names its nodes by fully qualified address, on its rows and in its topology.
- **Done when:** a test app deployed with the current release and redeployed with this branch keeps its database rows, bucket objects, generated secrets and RPC keys; a new stage deploys from scratch; the asks app's production deploy upgrades with its data intact.

### A2. `prisma deploy list`

Lists every node on a stage with its address, kind, platform ID and URL, from the stored topology joined to rows by `logicalId`. `--stage` narrows it; without it, production. `--json` output.

- **Builds on:** A1, so it prints the final address format.
- **Done when:** against a real stage it lists every node, and its end-to-end test passes.

### A3. Deploy's entry in the config

`composer({ entry })` in `prisma.config.ts`, `--entry` override, positional argument removed from `deploy` and `dev`. The three affected decision records are amended in the same PR.

- **Builds on:** nothing. Runs in parallel with the spike and A1.
- **Done when:** `prisma deploy` and `prisma dev` run from the config's entry, `--entry` overrides it, and a missing entry fails with a message that names both.

## Track B — platform commands (prisma/prisma-cli, prisma/pdp-control-plane)

### B1. Platform commands accept `@stage:address`

In prisma-cli, every command whose subject is a project, service, database or bucket accepts `@<stage>:<address>` in place of the ID. No stage means production. It is resolved through the existing `logicalId` and `branchGitName` filters, with a clear error when nothing matches or the row is the wrong kind.

- **Builds on:** nothing. It matches `logicalId`s exactly, whatever format a stage was deployed with.
- **Done when:** `prisma service logs @<stage>:<address>` and `prisma postgres delete @<stage>:<address> --confirm …` work against a real deployed app, with end-to-end tests.

### B2. Cascading Branch delete in the Management API

In pdp-control-plane, deleting a Branch first deletes its services, databases and buckets, then the Branch, in one server-side operation. The production Branch is still never deleted. The same PR rejects `:` in Branch names (PRO-225).

- **Builds on:** nothing.
- **Hands to B3:** an API call that removes a stage with live members.

### B3. `prisma branch delete`

In prisma-cli: `prisma branch delete <name> --confirm <name>`, calling the cascading delete.

- **Builds on:** B2 deployed.
- **Done when:** it removes a stage whose services are running, with an end-to-end test.

## Direct change: teardown documentation

Not part of a track. The Composer guides and agent skill say how to remove an app (`prisma project delete`, then confirm with `prisma project list`) and, once B3 ships, one stage. CI's `deleteProjectDeep` 409 workaround in `scripts/ci-cleanup-utils.ts` is removed, because `project delete` no longer refuses live compute.

## Order

```
spike ──▶ A1 ──▶ A2
A3                         (parallel)
B1                         (parallel)
B2 ──▶ B3                  (parallel)
docs direct change         (any time; stage removal docs after B3)
```

## Close-out

- [ ] Verify every Project DoD condition in [spec.md](spec.md).
- [ ] Long-lived content is already in `docs/design/` from each slice; confirm nothing in this folder is still needed.
- [ ] Remove references to `.drive/projects/node-addressing/` elsewhere in the repo.
- [ ] Delete `.drive/projects/node-addressing/`.

# System design review — A3, deploy's entry file lives in the config

Range: `origin/main...HEAD` on `drive/deploy-entry-in-config`, 4 commits, 68 files.

Read for this review:
- the repo `CLAUDE.md` and `docs/design/01-principles/`;
- design note 6, and the project and slice specs and plan;
- the ADR index;
- ADR-0003, ADR-0044, ADR-0049 and ADR-0050 as amended on the branch;
- ADR-0017, ADR-0024, ADR-0041, ADR-0053 and ADR-0056, where they state the command shape;
- the changed parts of `deploy-cli.md`, `local-dev.md`, `core-model.md` and the glossary.

## Verdict

The change fits the recorded design. ADR-0003's rule that application facts stay in code still holds. `entry` says where to look, not what the application is, and the amendment says so in the same terms as design note 6. The new field sits in the section ADR-0049 owns. The resolution rule is the CLI engine's rule for path fields, so Composer adds no rule of its own. The positional's removal is one change applied across commands, operations, scripts and CI.

Two design-level gaps: four older records still state the positional as the current form (S01), and the guide's "from any directory" conflicts with local dev's per-directory record (S02).

## Subsystem fit

- The field lives in `PrismaAppConfig` (core) with a one-line doc comment, but core never reads it. Only the CLI's `resolveEntryPath` interprets it. Core stays free of file paths at run time, as ADR-0017 intends.
- One function owns precedence and resolution. Every command and operation goes through it, so the CLI and `@prisma/composer/control` cannot drift apart.
- `CONFIG.ENTRY_MISSING` belongs in the `CONFIG` namespace: the failure is a missing config field with a CLI override. It carries `where: <config file>`.

## Naming

- `entry` matches the existing word for this file in the commands, the operations and the docs. `--entry` matches it.
- `resolveEntryPath(override, source, cwd)` says what it returns. The parameter name `override` states the precedence.

## Decision records against the code

Accurate:
- the ADR-0003 amendment and its note on the rejected alternative;
- ADR-0049's allowed fields, validation and resolution base;
- ADR-0050's command shapes and script example;
- ADR-0044's registry entry.

Incomplete: S01, and the ADR-0050 amendment's mention of only `destroy` and `log` (code-review F08).

## Findings

**S01 — Records that state the command shape were not amended**
- Location: ADR-0024 and ADR-0041 (their ADR-0050 amendment notes), ADR-0053 (lines 12, 18), ADR-0056 (line 52), and the index entries for ADR-0024 and ADR-0041.
- Issue: These are the records an agent reads for local dev and stages. ADR-0053 and ADR-0056 show `prisma dev module.ts` as the way to run the app. ADR-0024 and ADR-0041 state `prisma deploy <entry>` and `prisma dev <entry>` in amendment notes that read as current.
- Suggestion: Add a one-line amendment note to each and update the index entries. Keep the bodies as history, as the branch does for ADR-0003.

**S02 — "From any directory" holds for deploy, not for local dev**
- Location: `docs/guides/deploying.md` line 104.
- Issue: ADR-0052 makes local dev's record per working directory. With the entry in the config, `prisma dev` now runs from a subdirectory, and gets a second local copy of the app.
- Suggestion: Say that local dev's commands use the directory they run in (code-review F04).

---

# Round 2

Commits `a7184afe`, `1bdd405f`.
- **S01 fixed.** ADR-0024, ADR-0041, ADR-0053 and ADR-0056 have amendment notes citing ADR-0050, and the index entries say so. The bodies are kept as history.
- **S02 fixed.** The guide confines "from any directory" to `prisma deploy`, and states local dev's per-directory record.

No new design findings. Verdict: SATISFIED.

# S7 — A piped stdout gets the command's data, not JSON

Repo: prisma/prisma-cli. Branch `feat/piped-output-is-data` off `main`, which now includes prisma/prisma-cli#349.

## At a glance

```bash
$ prisma project list | head -3              # today: one NDJSON result frame
proj_cm3x…  shop
proj_k91…   blog
$ curl "$(prisma dev url gateway)"           # today: curl gets a JSON frame
$ prisma project list --json | jq '…'        # JSON is always explicit
```

Will ruled on 2026-10-15 that when stdout is not a terminal and no format flag is given, the CLI prints the command's plain data lines, and JSON requires `--json` (or `--format json`).

This replaces the engine's rule from the PR that created it ("a terminal gets human output and a pipe gets JSON"). None of the CLIs surveyed switch to JSON when piped (gh, aws, kubectl, gcloud, az, docker, supabase). Single-value commands print the value bare: `docker port`, `encore db conn-uri`.

## Chosen design

**Engine (`packages/cli-engine`).**
- With no `--json`/`--format` flag, the format is `human` whether or not stdout is a TTY.
- In human format, stdout carries only the command's data lines (`presentation.stdout`), as the product docs already require. Human blocks go to stderr, undecorated when stderr isn't a TTY, as today.
- The existing rule that skips the stdout data lines when stdout and stderr are the same terminal stays.
- The pre-parse format sniff (`sniffFormat`) and `resolveAutoFormat` change accordingly. Errors in a pipe render as human errors on stderr with the exit code, unless `--json` is given.
- `--format markdown` is unchanged.
- This is a breaking change to the engine's output contract, so the engine gets a minor version bump with `pnpm bump-cli-engine-version`, and conformance exceptions as the repo's process requires.

**Every mounted command defines its data lines.** About 34 of 58 presentations define no stdout today, so in a pipe they would print nothing. For each mounted command, decide what a pipe user expects and define `stdout`, following `docs/product/output-conventions.md`:
- A list: one line per item, the subject a follow-up command takes (normally its id), plus the name, tab-separated.
- A show: the resource's identifying value, or `key\tvalue` lines when there is no single value.
- A command whose result is one value: the bare value. Examples: a URL, a connection string, a created id.
- A command with no data (logout, delete): nothing on stdout. Its success is the exit code.

Write the rules into the product docs first, as ARCHITECTURE.md requires, then implement. Composer and ORM family commands are owned by those repos. List any whose stdout needs work as follow-ups, with the specific command.

**Docs.** Update every statement that a pipe gets JSON: `output-conventions.md` (TTY and piped behaviour, the `--format markdown` paragraph), `cli-style-guide.md`, `error-conventions.md`, the engine README and AGENTS.md, and the agent skills in `skills/` that tell agents to rely on piped JSON. Agents use `--json`. The e2e harness and tests that rely on piped JSON pass `--json` explicitly.

## Slice-specific done conditions

- [ ] Engine tests: no flag and piped stdout gives the data lines and no JSON; `--json` piped gives one NDJSON result frame as today; an error piped without `--json` gives a human error on stderr and the right exit code.
- [ ] A test that fails when a mounted command defines no stdout data lines and isn't on an explicit, reasoned list of commands with no data.
- [ ] The e2e suite still passes (`pnpm --filter @prisma/cli test:e2e`, if credentials are available; otherwise say so).

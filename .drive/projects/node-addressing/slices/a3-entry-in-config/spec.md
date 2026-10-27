# A3 — Deploy's entry file lives in the config

## At a glance

```ts
// prisma.config.ts
export default definePrismaConfig({
  composer: composer({
    entry: './module.ts',
    extensions: [prismaCloud(), nodeBuild()],
    state: prismaState(),
  }),
});
```

```
$ prisma deploy --stage pr-42          # was: prisma deploy module.ts --stage pr-42
$ prisma dev                           # was: prisma dev module.ts
$ prisma deploy --entry other.ts       # overrides the config for one run
```

## Chosen design

From design note 6, grounded in the code at `origin/main` `561f5336`:

- **The field.** The `composer` section takes an optional `entry: string`. The engine-free section check (`packages/0-framework/3-tooling/cli/src/composer-config.ts`) adds `entry` to the allowed keys, next to `extensions` and `state`. It checks that `entry` is a non-empty string when present, and reports `CONFIG.FIELD_INVALID` otherwise.
- **Where the path resolves.** The config's `entry` resolves against the directory of the file that declared the section (`ComposerConfigSource.file`). This is how the Prisma 8 CLI engine resolves path fields in `prisma.config.ts` (`resolveSectionPath`: against the declaring file, never the cwd). `--entry` resolves against the command's working directory, as Prisma's own path flags do.
- **The commands.** `prisma deploy` and `prisma dev` lose their positional `<entry>` and gain `--entry <path>` (`cli/src/family/commands/deploy.ts`, `dev.ts`). `--entry` wins over the config.
- **The operations.** `deploy`, `destroy`, `dev` and `log` on `@prisma/composer/control` keep their `entry` input, but it becomes optional. When it is given, it overrides the config and resolves against `cwd`, as today. When it is absent, the operation uses `config.value.entry`, resolved against `config.file`'s directory.
- **No entry anywhere.** If neither the config nor `--entry` (or the operation's `entry`) gives an entry, the command fails before any work with a new code, `CONFIG.ENTRY_MISSING`. The message names both ways to supply one: `entry` in the `composer` section of `prisma.config.ts`, or `--entry <path>`. The code is added to ADR-0044's registry.
- **A leftover positional.** `prisma deploy module.ts` must not silently ignore `module.ts`. If the CLI engine lets a command see unexpected positionals, fail with a message saying the entry moved to `entry` in the config or `--entry`. Otherwise the engine's own unknown-argument error is acceptable. Say which in the PR.
- **The repo's own uses.** The examples, the website, `scripts/composer-destroy.ts`, the deploy-verify-destroy CI action and the docs-deploy workflow put `entry` in each `prisma.config.ts` and stop passing a positional. `composer-destroy.ts` takes `--entry` instead of a positional.
- **Design records, in this PR.**
  - ADR-0003: amend. The config now carries one input to the tool, the entry path. It names no application facts; those stay in code. Its rejected alternative, "a config that names the application", stays rejected for application facts (`app`, `target`, `name`).
  - ADR-0049: amend the list of allowed section fields.
  - ADR-0050: amend the command shapes.
  - Update `docs/design/10-domains/deploy-cli.md`, `local-dev.md`, the glossary where it shows the command, the guides, the agent skill, `gotchas.md` and the READMEs.

## Coherence rationale

One input, the entry path, moves from the command line into the config, with every place that passes it updated in the same change. Splitting it would leave a release where some docs or CI scripts pass a positional the commands no longer take.

## Scope

**In:** everything above.

**Out:**
- `dev` watching the entry file (today it watches the config file and each build's watch paths).
- Deploying part of an app by pointing the entry at a submodule (a project non-goal).
- `deploy list` (A2).

## Pre-investigated edge cases

- `@prisma/composer/control` callers that pass `entry` keep working unchanged; only callers that omit it are new.
- The generated stack file for the Alchemy child process already imports the declaring `prisma.config.ts`. The resolved entry path it is given must be absolute, so it doesn't depend on the child's working directory.

## Slice-specific done conditions

- `prisma deploy` and `prisma dev` run from the config's entry. `--entry` overrides it. A missing entry fails with `CONFIG.ENTRY_MISSING`, naming both sources.
- A real deploy of one example to the platform, from its config's entry, succeeds. That deploy is QA's evidence.

## Open questions

None.

## References

- [Project spec](../../spec.md), [design notes](../../design-notes.md) decision 6.
- ADR-0003, ADR-0044, ADR-0049, ADR-0050.

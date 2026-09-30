# ADR-0049: Composer's configuration is the `composer` section of `prisma.config.ts`

## Decision

Composer reads its configuration from one place: the `composer` section of the app's `prisma.config.ts`, the file every Prisma CLI command family already shares. There is no separate Composer config file.

```ts
// prisma.config.ts
import { defineConfig as composer } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';
import { definePrismaConfig } from 'prisma/config';

export default definePrismaConfig({
  composer: composer({
    extensions: [prismaCloud(), nodeBuild()],
    state: prismaState(),
  }),
  orm: /* the ORM's own section, unchanged */,
});
```

The section's value is the `PrismaAppConfig` that [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md) describes: the extension descriptors the deploy looks nodes up in, and the one state store. The CLI engine (the command-line runtime every Prisma command family mounts into) loads the file, and Composer's section validator hands the validated value to the command. The programmatic operations on `@prisma/composer/control` take the same value, together with the declaring file's path, as a required `config` input.

## Reasoning

The Prisma CLI engine already discovers, evaluates and merges `prisma.config.ts`, and it gives each command family a named section with a validator of its own. A second Composer-only file meant a second loader, a second discovery rule (walking up from the deploy entry rather than from where the command runs), and a second file for users to learn. With the configuration in the shared file, Composer has one loader, the engine's, and one discovery rule, the engine's: from the command's working directory up to the repository root.

The section holds executable values. Extension descriptors carry provider layers, container lifecycles and preflight hooks, none of which can be described by a schema. So the validator checks only the fields that identify each descriptor: `extensions` is an array of objects, each with a non-empty string `id` and an object `nodes`, and the ids are distinct; `state` is an object with a string `extension` and a `create` function. Everything else passes through untouched: the command receives the descriptors as the very objects the config file built, never copies. Any other top-level key of the section is an error, because a key the validator does not know is a key the deploy would silently ignore.

The engine resolves a section over the chain of config files it loaded, nearest first, and by default merges a section key by key. Composer's section declares its own merge, which takes the nearest declaring file's section whole. A section therefore always comes from exactly one file, and that matters beyond tidiness: the deploy runs its infrastructure engine (Alchemy) in a child process, and the stack file generated for that child imports the declaring `prisma.config.ts` and reads its `composer` export. A section assembled from two files would have no single file to import.

That child-process import is also why the handler still needs a path. The engine gives the validator the section's provenance, the files that declared it; the handler recovers the same provenance by running the engine's own `resolveSectionOverChain` over the loaded files and passes `{ value, path }` to the operation. The programmatic operations cannot do that themselves: `@prisma/composer` must not depend on the engine, so a host that drives a deploy from code evaluates `prisma.config.ts` itself and passes `config: { value, path }`.

The old setup is refused, not migrated. A project that still has only `prisma-composer.config.ts` gets `CONFIG.SECTION_MISSING` from the validator, which names the old file because the engine gives the validator no directory to look in when no file declares the section. A section that still carries the old `configPath` pointer gets `CONFIG.LEGACY_FIELD`. A declaring file with `prisma-composer.config.{ts,mts,mjs,js}` beside it fails in the handler with `CONFIG.LEGACY_FILE` before any operation starts, so an old file is never silently ignored. All three name the fix: move `extensions` and `state` into the section and delete the old file. Only that directory is checked; searching further would be guessing.

Moving evaluation into the engine also retires Composer's effect pre-flight. The pre-flight inspected the installed tree to explain a failed import of Alchemy as `DEPS.EFFECT_VERSION_CONFLICT`. Alchemy declares a loose peer range on `effect` (`>=4.0.0-rc.115 || >=4.0.0`), and a different `effect` hoisted into the app does break it at import time: `alchemy@2.0.0-beta.78` and `beta.79` fail to import with `effect@4.0.0-rc.118` and import cleanly with `rc.115` (checked 2026-09-30). But the `composer` section imports Alchemy through the extensions' `/control` entries, so a broken tree now fails the moment the engine evaluates `prisma.config.ts`, with `CLI.CONFIG_UNREADABLE` naming the file and carrying the module error, before any Composer code runs. The case is rare, because the public packages pin every `effect`-family package Alchemy would otherwise float, and only the user's package manager can fix it. A separate tree walk to put a Composer code on that failure is not worth its upkeep. A failed import of an operation's executor is reported as `DEPS.EXECUTOR_UNLOADABLE` with the import error.

## Consequences

- `prisma.config.ts` is the only config file Composer reads. Examples and fixtures declare the section there, next to any `orm` section.
- The generated deploy and dev stack files import the declaring `prisma.config.ts` and pass its `composer` export to `lower()`. The file is evaluated again in the child, as the old config file was.
- `dev` reads the section once, at start. A change to `prisma.config.ts` needs a `dev` restart.
- `deploy`, `destroy`, `dev` and `log` on `@prisma/composer/control` take a required `config: { value, path }` and never look for a config file. This is a breaking change to that surface.
- `@prisma/composer-cli/family` no longer exports `ComposerSection`; the section's value type is `PrismaAppConfig` from `@prisma/composer/config`.
- A broken `effect` tree surfaces as the engine's `CLI.CONFIG_UNREADABLE`, not as a Composer code. `DEPS.EFFECT_VERSION_CONFLICT` no longer exists.
- Section-level failures (`CONFIG.SECTION_MISSING`, `CONFIG.LEGACY_FIELD`, and field errors) appear as diagnostics under the engine's `CLI.CONFIG_SECTION_INVALID` headline; only `CONFIG.LEGACY_FILE`, raised in the handler, is the headline itself.
- `c12` is no longer a Composer dependency.
- The dependency-cruiser configuration excludes `prisma.config.ts` by name, so the `/control` imports in the section are not cruised.

## Alternatives considered

- **Keep `prisma-composer.config.ts` and point to it from the section** (a `configPath` field): rejected. It keeps two files, two loaders and two discovery rules, which is the confusion this decision removes.
- **A schema-declared section** (`defineConfigSection({ schema })` with the engine's `reference()` helper): rejected. The engine's schema path does not reject unknown keys, emits `CLI.` codes rather than Composer's `CONFIG.` codes, and cannot give `configPath` its own migration message.
- **The engine's default per-key merge**: rejected. A section merged from several files has no single file for the generated stack to import.
- **Migrate the old file automatically**: rejected. Rewriting a user's `prisma.config.ts` is out of place for a deploy command; a refusal naming the exact change is deterministic and short.
- **Keep the effect pre-flight**: rejected for the reasons above. It would be a second, Composer-owned check for a failure the engine already reports, fixable only in the user's package manager.
- **Programmatic operations that find the config themselves**: rejected. It would need a private loader in `@prisma/composer`, which must stay free of the engine, and so reintroduce the second loader.

## Related

- [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md) — the control-plane firewall this section now carries.
- [ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md) — the programmatic surface that gains the `config` input.
- [ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md) — the `CONFIG` and `DEPS` namespaces.

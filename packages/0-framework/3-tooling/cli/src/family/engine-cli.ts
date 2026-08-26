/**
 * Composer's own CLI, rebuilt as a thin composition of the family it
 * publishes: `createCli` over `createComposerFamily()`, `Cli.run` with a
 * Runtime. Grammar, help, arg validation, output framing, exit codes and
 * signal ownership all belong to the engine now — this module contributes the
 * family and the environment, and nothing else.
 *
 * Running composer's commands through the same path an external host uses is
 * the point: it is what proves the family works standalone before the `prisma`
 * bin mounts it.
 *
 * This IS composer's CLI. The clipanion shell it replaced, and the bespoke
 * runner that shelled out to alchemy, are gone; `bin.ts` is a call into here.
 */
import {
  type Cli,
  type CliRunHooks,
  type CommandFamily,
  createCli,
  defineCommandFamily,
  defineConfigSection,
  type HostProcess,
  loadConfig,
  type MountedTree,
} from '@prisma/cli-engine';
import { createDestroyCommand } from './commands/destroy.ts';
import { createLogCommand } from './commands/log.ts';
import { type ComposerOperations, createComposerFamily, realOperations } from './family.ts';
import { createRuntime } from './runtime.ts';

export const BINARY_NAME = 'prisma-composer';

export interface ComposerCliSpec {
  /**
   * The version to report. Supplied by the caller rather than read here: the
   * version a user sees belongs to the package that shipped the executable,
   * and this module is bundled into that package rather than being it.
   */
  readonly version: string;
  readonly operations?: ComposerOperations | undefined;
}

/**
 * Composer's commands mount at the top level of its own CLI (`prisma-composer
 * deploy`). The bin mounts more than the family carries: `destroy` and `log`
 * were retired from the family (the surface the `prisma` bin mounts, per the
 * 2026-08-21 PM review) but stay first-class commands of `prisma-composer`
 * itself, so their definitions are mounted here on top of the family.
 */
function mountedTree(family: CommandFamily, operations: ComposerOperations): MountedTree {
  return {
    ...family.commands,
    destroy: createDestroyCommand(operations),
    log: createLogCommand(operations),
  };
}

/**
 * The ORM's slice of prisma.config.ts, declared so a config shared with the
 * unified `prisma` CLI loads here: the engine rejects any top-level key no
 * mounted family declares, and this bin does not mount the ORM family. The
 * value passes through unvalidated — the ORM CLI owns its section's shape,
 * and no composer command reads it.
 */
export const foreignOrmSectionFamily: CommandFamily = defineCommandFamily({
  configSection: defineConfigSection({
    name: 'orm',
    validate: (raw) => ({ ok: true, value: raw, diagnostics: [] }),
  }),
  commands: {},
});

export function createComposerCli(spec: ComposerCliSpec): Cli {
  const operations = spec.operations ?? realOperations;
  const family = createComposerFamily({ operations });
  return createCli({
    name: BINARY_NAME,
    version: spec.version,
    commandFamilies: [family, foreignOrmSectionFamily],
    groups: {},
    commands: mountedTree(family, operations),
  });
}

/**
 * Composes the Runtime and runs one invocation. Returns the exit code rather
 * than exiting, so the caller owns the process — a bin assigns it to
 * `process.exitCode` and lets the streams drain, as composer's CLI has always
 * done.
 *
 * `prisma.config.ts` is not read here. The loader goes in as a function, and the
 * engine calls it only when the command it is about to run declares a config
 * section, passing it the file `--config` named; the loader resolves that
 * against the host's cwd.
 */
export function runComposerCli(
  argv: readonly string[],
  host: HostProcess,
  spec: ComposerCliSpec,
  hooks?: CliRunHooks,
): Promise<number> {
  const runtime = createRuntime(host, (configPath) => loadConfig(host.cwd(), configPath));
  return createComposerCli(spec).run(argv, runtime, hooks);
}

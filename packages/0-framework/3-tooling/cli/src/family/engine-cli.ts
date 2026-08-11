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
  type HostProcess,
  loadConfig,
  type MountedTree,
} from '@prisma/cli-engine';
import { type ComposerOperations, createComposerFamily } from './family.ts';
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
 * deploy`); under the `prisma` bin the same family mounts one level down
 * (`prisma composer deploy`). The family is identical either way — only the
 * mount paths differ, which is exactly the split `createCli` draws between
 * `commandFamilies` and `commands`.
 */
function mountedTree(family: CommandFamily): MountedTree {
  return { ...family.commands };
}

export function createComposerCli(spec: ComposerCliSpec): Cli {
  const family = createComposerFamily({ operations: spec.operations });
  return createCli({
    name: BINARY_NAME,
    version: spec.version,
    commandFamilies: [family],
    groups: {},
    commands: mountedTree(family),
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

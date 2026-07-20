/**
 * Pipeline step 7 (deploy-cli.md § The pipeline; design-notes.md's "Driving
 * Alchemy" call): shell out to the generated stack file. Resolves the
 * workspace's own installed `alchemy` bin (walking up `node_modules/.bin`
 * from the generated file's package dir) rather than going through
 * `bunx`/`npx`, so this works the same under node and bun — the resolved
 * bin's own launcher (`alchemy/bin/cli.js`) does its own node/bun dispatch
 * from there, driven by the env it inherits.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CliError } from './cli-error.ts';

/** Walks up from `startDir` looking for `node_modules/.bin/alchemy`. */
export function resolveAlchemyBin(startDir: string): string {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'alchemy');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new CliError(
        `Could not find an installed \`alchemy\` bin above "${startDir}" — add "alchemy" as a ` +
          'dependency of your app.',
      );
    }
    dir = parent;
  }
}

export interface RunAlchemyInput {
  readonly command: 'deploy' | 'destroy';
  /** The generated stack file's path, relative to `cwd`. */
  readonly stackFileRelativePath: string;
  readonly cwd: string;
  readonly stage: string | undefined;
  /** Every extension's resolved container, serialized — one env var per extension (core's container-transport naming). Content-blind: the CLI never reads these values, only writes them. */
  readonly containerEnv: Readonly<Record<string, string>>;
  /** Defaults to `process.env`; overridable so tests can pin a fake bin's inputs. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Runs `alchemy deploy|destroy <stack file> --yes [--stage <stage>]`, inheriting stdio + env, plus every extension's resolved container. */
export function runAlchemy(input: RunAlchemyInput): number {
  const bin = resolveAlchemyBin(input.cwd);
  const args = [input.command, input.stackFileRelativePath, '--yes'];
  if (input.stage !== undefined) args.push('--stage', input.stage);

  const result = spawnSync(bin, args, {
    cwd: input.cwd,
    stdio: 'inherit',
    env: {
      ...(input.env ?? process.env),
      ...input.containerEnv,
    },
  });

  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

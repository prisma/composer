import * as path from 'node:path';
import spawn from 'cross-spawn';

export const integrationDir = path.resolve(import.meta.dir, '..');

const composerBinDir = path.join(integrationDir, 'node_modules', '.bin');

/** Runs the installed CLI exactly as a shell would, including Windows's `.CMD` shim. */
export function spawnComposer(args: readonly string[], inputEnv: NodeJS.ProcessEnv = process.env) {
  const env = { ...inputEnv };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${composerBinDir}${path.delimiter}${env[pathKey] ?? ''}`;

  return spawn.sync('prisma-composer', [...args], {
    cwd: integrationDir,
    encoding: 'utf8',
    env,
  });
}

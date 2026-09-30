import * as fs from 'node:fs';
import * as path from 'node:path';
import spawn from 'cross-spawn';

export const integrationDir = path.resolve(import.meta.dir, '..');

/**
 * The `node_modules/.bin` nearest to `from` that links the installed `prisma` host.
 * The workspace installs with `node-linker=hoisted`, so it is usually the repository root's.
 */
export function prismaBinDir(from: string): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', '.bin');
    if (fs.existsSync(path.join(candidate, 'prisma'))) return candidate;
    if (path.dirname(dir) === dir) {
      throw new Error(`No node_modules/.bin/prisma at or above ${from}. Run pnpm install.`);
    }
  }
}

/** Runs the installed `prisma` host exactly as a shell would, including Windows's `.CMD` shim. */
export function spawnPrisma(args: readonly string[], inputEnv: NodeJS.ProcessEnv = process.env) {
  const env = { ...inputEnv };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${prismaBinDir(integrationDir)}${path.delimiter}${env[pathKey] ?? ''}`;

  return spawn.sync('prisma', [...args], {
    cwd: integrationDir,
    encoding: 'utf8',
    env,
  });
}

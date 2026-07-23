/**
 * Generalized form of the CLI's `resolveAlchemyBin` pattern (local-dev spec
 * § 4): walk up from `startDir` looking for `node_modules/.bin/<binName>`.
 * Returns `undefined` rather than throwing — callers name their own bin and
 * their own fix in the pinned error message (e.g. postgres.ts's "add prisma
 * to your app's devDependencies"), which a generic helper cannot phrase.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export function resolveLocalBin(startDir: string, binName: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', binName);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

import * as fs from 'node:fs';
import * as path from 'node:path';

export const CONFIG_FILENAME = 'prisma-composer.config.ts';

/** Walks up from the entry file's directory looking for the documented Composer config filename. */
export function findConfigPathForEntry(entryPath: string): string | undefined {
  let current = path.dirname(path.resolve(entryPath));
  while (true) {
    const candidate = path.join(current, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

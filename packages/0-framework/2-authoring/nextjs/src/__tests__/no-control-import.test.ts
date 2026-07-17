import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The firewall by file boundary (ADR-0017): control-plane code is loaded only
 * through `prisma-composer.config.ts` — nothing reachable from this package's
 * AUTHORING entry may import a `/control` entry (its own or any other
 * extension's), or the wrapper bundle would drag esbuild and the rest of the
 * deploy toolchain into the runtime artifact.
 */

const srcDir = path.join(import.meta.dir, '..');

function importSpecifiers(text: string): string[] {
  const pattern =
    /(?:import|export)\s+[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;
  const out: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec !== undefined) out.push(spec);
  }
  return out;
}

/** Walks the import graph from `entry`, following relative imports only (bare specifiers leave the package). */
function reachableImports(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    const specs = importSpecifiers(fs.readFileSync(file, 'utf8'));
    seen.set(file, specs);
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), spec);
      if (fs.existsSync(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

describe('firewall: the authoring entry never reaches a control entry', () => {
  test('no module reachable from src/index.ts imports a /control entry', () => {
    const reachable = reachableImports(path.join(srcDir, 'index.ts'));
    expect(reachable.size).toBeGreaterThan(0);

    for (const [file, specs] of reachable) {
      const offending = specs.filter((spec) => /\/control(\.ts)?$/.test(spec));
      expect({ file: path.relative(srcDir, file), offending }).toEqual({
        file: path.relative(srcDir, file),
        offending: [],
      });
    }
  });
});

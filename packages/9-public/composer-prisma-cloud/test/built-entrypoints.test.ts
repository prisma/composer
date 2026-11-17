import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const packageDir = path.join(import.meta.dir, '..');
const distDir = path.join(packageDir, 'dist');
const sharedModulesDir = path.join(packageDir, '..', '..', '1-prisma-cloud', '2-shared-modules');

const SHARED_MODULE_ENTRYPOINTS: readonly (readonly [string, string])[] = [
  ['auth', 'auth-entrypoint.mjs'],
  ['cron', 'scheduler-entrypoint.mjs'],
  ['email', 'email-entrypoint.mjs'],
  ['storage', 'storage-entrypoint.mjs'],
  ['streams', 'streams-entrypoint.mjs'],
];

const INLINED_PACKAGES = ['@cfworker/json-schema', '@internal/input-document'];

const VALIDATOR_SOURCE = '__absolute_uri__';

function builtFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.mjs'))
    .map((file) => path.join(dir, file));
}

function withRelativeChunks(entry: string): string {
  const relativeImport = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;
  const seen = new Set<string>();
  const parts: string[] = [];
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    parts.push(text);
    for (const match of text.matchAll(relativeImport)) {
      const resolved = path.resolve(path.dirname(file), match[1] ?? '');
      if (fs.existsSync(resolved)) queue.push(resolved);
    }
  }
  return parts.join('\n');
}

function importsOf(text: string, specifier: string): boolean {
  const quoted = [`"${specifier}`, `'${specifier}`];
  return quoted.some(
    (q) =>
      text.includes(`from ${q}`) || text.includes(`import(${q}`) || text.includes(`import ${q}`),
  );
}

const entrypoints = [
  ...SHARED_MODULE_ENTRYPOINTS.map(([module, file]) =>
    path.join(sharedModulesDir, module, 'dist', file),
  ),
  ...SHARED_MODULE_ENTRYPOINTS.map(([module, file]) => path.join(distDir, module, file)),
];

describe('the built code a service runs carries the platform-variable validator inside it', () => {
  test('no built file of @prisma/composer-prisma-cloud imports the validator or the input document', () => {
    const files = builtFiles(distDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const specifier of INLINED_PACKAGES) {
        expect({
          file: path.relative(packageDir, file),
          specifier,
          imports: importsOf(text, specifier),
        }).toEqual({
          file: path.relative(packageDir, file),
          specifier,
          imports: false,
        });
      }
    }
  });

  for (const entrypoint of entrypoints) {
    const label = path
      .relative(path.join(packageDir, '..', '..'), entrypoint)
      .split(path.sep)
      .join('/');
    test(`${label} holds the validator and imports neither package`, () => {
      const graph = withRelativeChunks(entrypoint);
      expect(graph).toContain(VALIDATOR_SOURCE);
      for (const specifier of INLINED_PACKAGES) {
        expect({ specifier, imports: importsOf(graph, specifier) }).toEqual({
          specifier,
          imports: false,
        });
      }
    });
  }

  test("the services' runtime in @prisma/composer-prisma-cloud holds the validator", () => {
    expect(withRelativeChunks(path.join(distDir, 'index.mjs'))).toContain(VALIDATOR_SOURCE);
  });
});

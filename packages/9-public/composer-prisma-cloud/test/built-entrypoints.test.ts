import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const packageDir = path.join(import.meta.dir, '..');
const distDir = path.join(packageDir, 'dist');
const sharedModulesDir = path.join(packageDir, '..', '..', '1-prisma-cloud', '2-shared-modules');

const isEntrypoint = (file: string): boolean => file.endsWith('-entrypoint.mjs');

const sharedModules = fs
  .readdirSync(sharedModulesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

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

const sharedModuleEntrypoints = sharedModules.flatMap((module) =>
  builtFiles(path.join(sharedModulesDir, module, 'dist')).filter((file) =>
    isEntrypoint(path.basename(file)),
  ),
);
const packageEntrypoints = builtFiles(distDir).filter((file) => isEntrypoint(path.basename(file)));
const entrypoints = [...sharedModuleEntrypoints, ...packageEntrypoints];

describe('the built code a service runs carries the platform-variable validator inside it', () => {
  test('every shared module builds a service entrypoint, and this package ships a copy of each', () => {
    for (const module of sharedModules) {
      const own = sharedModuleEntrypoints.filter((file) =>
        file.startsWith(path.join(sharedModulesDir, module, 'dist')),
      );
      expect({ module, entrypoints: own.length > 0 }).toEqual({ module, entrypoints: true });
      for (const file of own) {
        expect(fs.existsSync(path.join(distDir, module, path.basename(file)))).toBe(true);
      }
    }
  });

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

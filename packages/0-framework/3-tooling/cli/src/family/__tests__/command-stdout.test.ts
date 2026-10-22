/** Every command says what its data lines are, or why it has none. */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const COMMANDS_DIR = path.join(import.meta.dir, '../commands');

const EMPTY_STDOUT = [
  /stdout:\s*\(\)\s*=>\s*\(?\s*\[\s*\]/,
  /stdout\s*(?::\s*(?:function\s*)?)?\([^)]*\)\s*(?:=>\s*)?\{\s*return\s*\[\s*\]/,
];

const sources = readdirSync(COMMANDS_DIR)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ name, text: readFileSync(path.join(COMMANDS_DIR, name), 'utf8') }));

describe('command stdout', () => {
  test('reads every command source', () => {
    expect(sources.map((source) => source.name).sort()).toEqual([
      'deploy.ts',
      'dev-stop.ts',
      'dev-url.ts',
      'dev.ts',
    ]);
  });

  test('no command declares an empty data-line list instead of noDataLines', () => {
    const silent = sources
      .filter((source) => EMPTY_STDOUT.some((pattern) => pattern.test(source.text)))
      .map((source) => source.name);

    expect(silent).toEqual([]);
  });

  test.each([
    ['an arrow returning an empty list', 'stdout: () => [],'],
    ['an arrow returning a parenthesized empty list', 'stdout: () => ([]),'],
    ['a method returning an empty list', 'stdout() { return []; },'],
    ['a function returning an empty list', 'stdout: function () { return []; },'],
  ])('recognizes %s as no data lines', (_name, text) => {
    expect(EMPTY_STDOUT.some((pattern) => pattern.test(text))).toBe(true);
  });
});

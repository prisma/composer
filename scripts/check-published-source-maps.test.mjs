import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { sourceMapProblems } from './check-published-source-maps-utils.mjs';

const root = mkdtempSync(join(tmpdir(), 'published-source-maps-'));
after(() => rmSync(root, { recursive: true, force: true }));

let count = 0;
/** A dist folder holding `files`; an object value is written as JSON. */
function dist(files) {
  const dir = join(root, `dist-${count++}`);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const code = 'export function f() { return 1; }\n//# sourceMappingURL=index.mjs.map\n';
const map = (sources, sourcesContent = sources.map(() => 'source')) => ({
  version: 3,
  sources,
  sourcesContent,
  mappings: '',
});

function problemsFor(files) {
  return sourceMapProblems([dist(files)]);
}

describe('sourceMapProblems', () => {
  it('passes maps that name our TypeScript, third-party dist files and declaration sources', () => {
    assert.deepEqual(
      problemsFor({
        'index.mjs': code,
        'index.mjs.map': map([
          '../../core/src/index.ts',
          '../../node_modules/kysely/dist/index.js',
        ]),
        'index.d.mts.map': { version: 3, sources: ['../../core/src/index.ts'], mappings: '' },
        'reexports.mjs': 'import { t as f } from "./index.mjs";\nexport { f };\n',
        'star.mjs': 'export * from "./index.mjs";\nexport { f as g } from "./index.mjs";\n',
        'rolldown-runtime-abc.mjs': 'var x = 1;\nexport { x };\n',
      }),
      [],
    );
  });

  it('fails a .mjs with code but no map', () => {
    const problems = problemsFor({ 'index.mjs': code });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /index\.mjs: has no source map/);
  });

  it('fails a .mjs without a map whose lines start with import or export but hold code', () => {
    const problems = problemsFor({
      'a.mjs': 'export function f() { return 1; }\n',
      'b.mjs': 'import "x"; const y = 2; export { y };\n',
    });
    assert.equal(problems.length, 2);
    assert.match(problems[0], /a\.mjs: has no source map/);
    assert.match(problems[1], /b\.mjs: has no source map/);
  });

  it('fails an own-code source inside a dist folder, including one under node_modules/@internal', () => {
    const problems = problemsFor({
      'index.mjs': code,
      'index.mjs.map': map([
        '../../core/dist/index.mjs',
        '../node_modules/@internal/core/dist/x.mjs',
      ]),
    });
    assert.equal(problems.length, 2);
    assert.match(problems[0], /built output.*core\/dist\/index\.mjs/);
    assert.match(problems[1], /built output.*@internal\/core\/dist\/x\.mjs/);
  });

  it('fails a JavaScript map without sourcesContent for our code, but not a declaration map', () => {
    const problems = problemsFor({
      'index.mjs': code,
      'index.mjs.map': map(['../src/index.ts'], [null]),
      'index.d.mts.map': { version: 3, sources: ['../src/index.ts'], mappings: '' },
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /index\.mjs\.map: no sourcesContent for \.\.\/src\/index\.ts/);
  });

  it('fails absolute paths and URLs', () => {
    const sources = [
      '/home/ci/src/a.ts',
      '\\\\server\\a.ts',
      'C:\\src\\a.ts',
      'file:///src/a.ts',
      'webpack://app/a.ts',
    ];
    const problems = problemsFor({ 'index.mjs': code, 'index.mjs.map': map(sources) });
    assert.equal(problems.length, sources.length);
    for (const problem of problems) assert.match(problem, /absolute path or URL/);
  });

  it('fails any map carrying the Prisma ORM or prettier', () => {
    const problems = problemsFor({
      'auth/testing.mjs': code,
      'auth/testing.mjs.map': map([
        '../../node_modules/@prisma/orm-postgres/dist/control.mjs',
        '../../node_modules/prettier/index.mjs',
        '../../node_modules/@prisma/streams-local/dist/index.mjs',
      ]),
    });
    assert.equal(problems.length, 1);
    assert.match(
      problems[0],
      /testing\.mjs\.map: inlines 2 source files of the Prisma ORM or prettier/,
    );
  });

  it('fails a missing dist folder', () => {
    const problems = sourceMapProblems([join(root, 'nowhere')]);
    assert.match(problems[0], /nowhere: missing/);
  });
});

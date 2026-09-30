import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALLOWED_MENTIONS, findRetiredNameMentions } from './lint-retired-binary-name.mjs';

const SCRIPT_PATH = join(
  fileURLToPath(new URL('.', import.meta.url)),
  'lint-retired-binary-name.mjs',
);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OLD = 'prisma-composer';

let base;

function write(relativePath, content) {
  const full = join(base, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function runScript() {
  return spawnSync(execPath, [SCRIPT_PATH, base], { encoding: 'utf-8' });
}

function kindsIn(file) {
  return findRetiredNameMentions(base, {})
    .filter((finding) => finding.file === file)
    .map(({ line, kind }) => ({ line, kind }));
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lint-retired-binary-name-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('findRetiredNameMentions', () => {
  it('finds nothing in text that uses prisma and the names that only start with the old one', () => {
    write(
      'docs/guides/deploying.md',
      [
        'Run `prisma deploy module.ts`.',
        `The ${OLD}-core-concepts skill and the ${OLD}-state project,`,
        `the .${OLD}/alchemy.run.ts stack file and ${OLD}.map.json.`,
      ].join('\n'),
    );

    assert.deepEqual(findRetiredNameMentions(base, {}), []);
  });

  it('finds a command, a wrapped shell line, a bare prompt, a package runner and a backticked name', () => {
    write(
      'docs/guides/deploying.md',
      [
        `${OLD} deploy module.ts`,
        `${OLD} \\`,
        '  deploy module.ts',
        `$ ${OLD}`,
        `npm exec -- ${OLD} deploy`,
        `Run \`${OLD}\` deploy.`,
      ].join('\n'),
    );

    assert.deepEqual(kindsIn('docs/guides/deploying.md'), [
      { line: 1, kind: 'binary name' },
      { line: 2, kind: 'binary name' },
      { line: 4, kind: 'binary name' },
      { line: 5, kind: 'binary name' },
      { line: 6, kind: 'binary name' },
    ]);
  });

  it('finds the binary path', () => {
    write('examples/app/package.json', `{ "deploy": "bun node_modules/.bin/${OLD}" }\n`);

    assert.deepEqual(kindsIn('examples/app/package.json'), [{ line: 1, kind: 'binary path' }]);
  });

  it('scans root Markdown, docs/oss and a hand-written generated folder in an example', () => {
    write('CONTRIBUTING.md', `Run ${OLD}.\n`);
    write('docs/oss/versioning.md', `Run ${OLD}.\n`);
    write('examples/app/generated/notes.md', `Run ${OLD}.\n`);

    assert.deepEqual(
      findRetiredNameMentions(base, {}).map(({ file }) => file),
      ['CONTRIBUTING.md', 'docs/oss/versioning.md', 'examples/app/generated/notes.md'],
    );
  });

  it('scans package source but not package tests, fixtures, node_modules or the rendered site', () => {
    write('packages/core/src/message.ts', `export const hint = 'run ${OLD} dev';\n`);
    write('packages/core/src/__tests__/message.test.ts', `'${OLD} dev'\n`);
    write('packages/core/src/message.test.ts', `'${OLD} dev'\n`);
    write('packages/core/test/fixtures/app.ts', `'${OLD} dev'\n`);
    write('examples/app/node_modules/pkg/README.md', `${OLD} deploy\n`);
    write('website/src/generated/content.ts', `${OLD} deploy\n`);
    write('docs/design/adr.md', `${OLD} deploy\n`);

    assert.deepEqual(
      findRetiredNameMentions(base, {}).map(({ file }) => file),
      ['packages/core/src/message.ts'],
    );
  });

  it('accepts exactly the allowlisted count of findings', () => {
    write('docs/guides/deploying.md', `A ${OLD}.config.ts is no longer read.\n`);

    assert.deepEqual(findRetiredNameMentions(base, { 'docs/guides/deploying.md': 1 }), []);
  });

  it('reports every finding in an allowlisted file whose count differs', () => {
    write('docs/guides/deploying.md', `A ${OLD}.config.ts is no longer read.\nRun ${OLD} dev.\n`);

    assert.deepEqual(
      findRetiredNameMentions(base, { 'docs/guides/deploying.md': 1 }).map(({ line, kind }) => ({
        line,
        kind,
      })),
      [
        { line: 1, kind: 'config file (1 allowed, 2 found)' },
        { line: 2, kind: 'binary name (1 allowed, 2 found)' },
      ],
    );
  });

  it('reports an allowlisted file that no longer has the findings it is allowed', () => {
    write('docs/guides/deploying.md', 'Nothing about the old file.\n');

    assert.deepEqual(findRetiredNameMentions(base, { 'docs/guides/deploying.md': 1 }), [
      {
        file: 'docs/guides/deploying.md',
        line: 0,
        kind: 'allowlist (1 allowed, 0 found)',
        text: 'update ALLOWED_MENTIONS in scripts/lint-retired-binary-name.mjs',
      },
    ]);
  });

  it('allowlists only files that exist in the repository', () => {
    for (const file of Object.keys(ALLOWED_MENTIONS)) {
      assert.ok(existsSync(join(REPO_ROOT, file)), `${file} is allowlisted but does not exist`);
    }
  });
});

describe('the script', () => {
  it('exits 1 and names the file and line of a planted mention', () => {
    write('README.md', `Deploy with ${OLD} deploy.\n`);

    const result = runScript();

    assert.equal(result.status, 1);
    assert.match(result.stderr, /README\.md:1: binary name:/);
  });

  it('exits 0 on a clean tree holding the allowlisted findings', () => {
    write('README.md', 'Deploy with `prisma deploy`.\n');
    for (const [file, count] of Object.entries(ALLOWED_MENTIONS)) {
      write(file, `A ${OLD}.config.ts is no longer read.\n`.repeat(count));
    }

    const result = runScript();

    assert.equal(result.status, 0, result.stderr);
  });
});

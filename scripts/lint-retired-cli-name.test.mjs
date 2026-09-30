import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALLOWED_CONFIG_FILE_MENTIONS, findRetiredNameMentions } from './lint-retired-cli-name.mjs';

const SCRIPT_PATH = join(fileURLToPath(new URL('.', import.meta.url)), 'lint-retired-cli-name.mjs');
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

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lint-retired-cli-name-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('findRetiredNameMentions', () => {
  it('finds nothing in docs that use prisma and the reserved-name forms', () => {
    write(
      'docs/guides/deploying.md',
      [
        'Run `prisma deploy module.ts`.',
        `The ${OLD}-core-concepts skill, the ${OLD}-state project,`,
        `the .${OLD}/alchemy.run.ts stack file and ${OLD}.map.json.`,
      ].join('\n'),
    );

    assert.deepEqual(findRetiredNameMentions(base, {}), []);
  });

  it('finds a planted command in a guide', () => {
    write('docs/guides/deploying.md', `Intro.\n\n${OLD} deploy module.ts --stage x\n`);

    assert.deepEqual(findRetiredNameMentions(base, {}), [
      {
        file: 'docs/guides/deploying.md',
        line: 3,
        kind: 'command',
        text: `${OLD} deploy module.ts --stage x`,
      },
    ]);
  });

  it('finds the binary path and a package-runner form', () => {
    write('examples/app/package.json', `{ "deploy": "bun node_modules/.bin/${OLD}" }\n`);
    write('website/README.md', `bunx ${OLD}\n`);

    assert.deepEqual(
      findRetiredNameMentions(base, {}).map(({ file, kind }) => ({ file, kind })),
      [
        { file: 'examples/app/package.json', kind: 'command' },
        { file: 'website/README.md', kind: 'command' },
      ],
    );
  });

  it('ignores node_modules and files outside the checked trees', () => {
    write('examples/app/node_modules/pkg/README.md', `${OLD} deploy\n`);
    write('docs/design/adr.md', `${OLD} deploy\n`);

    assert.deepEqual(findRetiredNameMentions(base, {}), []);
  });

  it('accepts exactly the allowlisted count of config-file mentions', () => {
    write('docs/guides/deploying.md', `A ${OLD}.config.ts is no longer read.\n`);

    assert.deepEqual(findRetiredNameMentions(base, { 'docs/guides/deploying.md': 1 }), []);
  });

  it('reports every config-file mention when the count differs from the allowlist', () => {
    write(
      'docs/guides/deploying.md',
      `A ${OLD}.config.ts is no longer read.\nNor is ${OLD}.config.mjs.\n`,
    );

    assert.deepEqual(
      findRetiredNameMentions(base, { 'docs/guides/deploying.md': 1 }).map(({ line, kind }) => ({
        line,
        kind,
      })),
      [
        { line: 1, kind: 'config file (1 allowed, 2 found)' },
        { line: 2, kind: 'config file (1 allowed, 2 found)' },
      ],
    );
  });

  it('reports an allowlisted file that no longer has the mentions it is allowed', () => {
    write('docs/guides/deploying.md', 'Nothing about the old file.\n');

    assert.deepEqual(findRetiredNameMentions(base, { 'docs/guides/deploying.md': 1 }), [
      {
        file: 'docs/guides/deploying.md',
        line: 0,
        kind: 'config file (1 allowed, 0 found)',
        text: 'update the allowlist in scripts/lint-retired-cli-name.mjs',
      },
    ]);
  });

  it('does not let the allowlist excuse a command', () => {
    write('docs/guides/deploying.md', `A ${OLD}.config.ts is no longer read.\n${OLD} dev\n`);

    assert.deepEqual(
      findRetiredNameMentions(base, { 'docs/guides/deploying.md': 1 }).map(({ kind }) => kind),
      ['command'],
    );
  });

  it('allowlists only paths that exist in the repository', () => {
    assert.deepEqual(Object.keys(ALLOWED_CONFIG_FILE_MENTIONS).sort(), [
      'docs/guides/deploying.md',
      'skills/prisma-composer-core-concepts/SKILL.md',
    ]);
  });
});

describe('the script', () => {
  it('exits 1 and names the file and line of a planted mention', () => {
    write('README.md', `Deploy with ${OLD} deploy.\n`);

    const result = runScript();

    assert.equal(result.status, 1);
    assert.match(result.stderr, /README\.md:1: command:/);
  });

  it('exits 0 on a clean tree with the allowlisted migration passages', () => {
    write('README.md', 'Deploy with `prisma deploy`.\n');
    for (const [file, count] of Object.entries(ALLOWED_CONFIG_FILE_MENTIONS)) {
      write(file, `A ${OLD}.config.ts is no longer read.\n`.repeat(count));
    }

    const result = runScript();

    assert.equal(result.status, 0, result.stderr);
  });
});

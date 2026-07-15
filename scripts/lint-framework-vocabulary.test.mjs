import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FORBIDDEN_VOCABULARY, findVocabularyViolations } from './lint-framework-vocabulary.mjs';

const SCRIPT_PATH = join(
  fileURLToPath(new URL('.', import.meta.url)),
  'lint-framework-vocabulary.mjs',
);
const DOMAIN = 'packages/0-framework';

let base;

function write(relPath, content) {
  const full = join(base, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Run the script with the fixture dir as the scanned root. */
function runScript() {
  return spawnSync(execPath, [SCRIPT_PATH, base], { encoding: 'utf-8' });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lint-vocab-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('findVocabularyViolations', () => {
  it('returns no violations for a clean framework domain', () => {
    write(`${DOMAIN}/src/core.ts`, 'export const answer = 42;\n');
    assert.deepEqual(findVocabularyViolations(base, FORBIDDEN_VOCABULARY), []);
  });

  it('flags the forbidden term in code AND in a comment (comments are scanned)', () => {
    write(
      `${DOMAIN}/src/leak.ts`,
      [
        '// This helper is Postgres-specific — it should not live here.',
        'export const driver = "postgres";',
        '',
      ].join('\n'),
    );
    const violations = findVocabularyViolations(base, FORBIDDEN_VOCABULARY);
    assert.equal(violations.length, 2, 'both the comment line and the code line are violations');
    assert.deepEqual(
      violations.map((v) => v.line),
      [1, 2],
    );
    assert.ok(violations.every((v) => v.term === 'postgres'));
  });

  it('matches case-insensitively (Postgres / POSTGRES / PostgreSQL)', () => {
    write(`${DOMAIN}/src/a.ts`, 'const x = "Postgres";\n');
    write(`${DOMAIN}/src/b.ts`, 'const y = "POSTGRES";\n');
    write(`${DOMAIN}/src/c.ts`, '// PostgreSQL note\nexport const z = 1;\n');
    const violations = findVocabularyViolations(base, FORBIDDEN_VOCABULARY);
    assert.equal(violations.length, 3);
  });

  it('excludes test files and __tests__ dirs (they use postgres:// as example data)', () => {
    write(`${DOMAIN}/src/x.test.ts`, 'const url = "postgres://x";\n');
    write(`${DOMAIN}/src/x.test-d.ts`, 'const url = "postgres://x";\n');
    write(`${DOMAIN}/src/x.spec.ts`, 'const url = "postgres://x";\n');
    write(`${DOMAIN}/src/__tests__/helper.ts`, 'const url = "postgres://x";\n');
    write(`${DOMAIN}/src/fixtures/seed.ts`, 'const url = "postgres://x";\n');
    assert.deepEqual(findVocabularyViolations(base, FORBIDDEN_VOCABULARY), []);
  });
});

describe('the script (exit code + report)', () => {
  it('exits 0 with a friendly message when the domain is clean', () => {
    write(`${DOMAIN}/src/core.ts`, 'export const answer = 42;\n');
    const result = runScript();
    assert.equal(result.status, 0);
    assert.match(result.stdout, /no forbidden vocabulary found/);
  });

  it('exits 1 and reports file:line:term for a leak', () => {
    write(`${DOMAIN}/src/leak.ts`, 'export const driver = "postgres";\n');
    const result = runScript();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /leak\.ts:1: postgres:/);
    assert.match(result.stderr, /target-agnostic/);
  });
});

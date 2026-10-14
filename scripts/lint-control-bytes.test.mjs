import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findControlBytes } from './lint-control-bytes.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('lint-control-bytes.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

let base;

function track(file, content) {
  writeFileSync(join(base, file), content);
  execFileSync('git', ['add', file], { cwd: base });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lint-control-bytes-'));
  execFileSync('git', ['init', '-q'], { cwd: base });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('findControlBytes', () => {
  it('reports each line holding a control byte, with its bytes', () => {
    track('key.ts', 'const ok = 1;\nconst key = a + "\0" + b + "\x1f";\n');
    assert.deepEqual(findControlBytes(base), ['key.ts:2: 0x00 0x1f']);
  });

  it('accepts tabs, newlines and carriage returns', () => {
    track('text.md', 'a\tb\r\nc\n');
    assert.deepEqual(findControlBytes(base), []);
  });

  it('skips binary assets and untracked files', () => {
    track('logo.png', '\0\x01\x02');
    writeFileSync(join(base, 'untracked.ts'), '\0');
    assert.deepEqual(findControlBytes(base), []);
  });

  it('exits 1 naming the file when run as a script', () => {
    track('key.ts', '\0');
    const result = spawnSync(execPath, [SCRIPT_PATH, base], { encoding: 'utf-8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /key\.ts:1: 0x00/);
  });

  it('finds nothing in this repository', () => {
    assert.deepEqual(findControlBytes(REPO_ROOT), []);
  });
});

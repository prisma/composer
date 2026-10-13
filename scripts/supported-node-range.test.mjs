import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SUPPORTED_NODE_RANGE = '^22.18.0 || ^24.11.0 || >=26.0.0';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const WORKSPACE_DIRS = ['packages', 'examples', 'test', 'website'];

const manifests = execFileSync('git', ['ls-files', '--', ...WORKSPACE_DIRS], {
  cwd: repoRoot,
  encoding: 'utf-8',
})
  .split('\n')
  .filter((file) => file === 'package.json' || file.endsWith('/package.json'))
  .map((file) => ({ file, json: JSON.parse(readFileSync(join(repoRoot, file), 'utf-8')) }));

describe('supported Node.js range', () => {
  it('is declared by every published package', () => {
    const published = manifests.filter(({ file }) => file.startsWith('packages/9-public/'));
    assert.ok(published.length > 0);
    for (const { file, json } of published) {
      assert.equal(json.engines?.node, SUPPORTED_NODE_RANGE, file);
    }
  });

  it('is the only engines.node any workspace package declares', () => {
    for (const { file, json } of manifests) {
      if (json.engines?.node === undefined) continue;
      assert.equal(json.engines.node, SUPPORTED_NODE_RANGE, file);
    }
  });
});

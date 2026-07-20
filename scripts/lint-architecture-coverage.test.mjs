import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findUnaliasedSpecifiers,
  findUnclassifiedFiles,
  normalizeGlob,
  readImportSpecifiers,
} from './architecture-coverage.mjs';

const PACKAGE_CONFIGS = [
  { glob: 'packages/9-public/composer/src/index.ts', domain: 'public', plane: 'shared' },
  { glob: 'packages/0-framework/0-foundation/**', domain: 'framework', plane: 'shared' },
];

describe('findUnclassifiedFiles', () => {
  it('reports a new file that matches no glob', () => {
    // The regression: a new public file joins no module group, so the cruiser
    // applies no plane rule and a violation in it passes on a green gate.
    assert.deepEqual(
      findUnclassifiedFiles(['packages/9-public/composer/src/report.ts'], PACKAGE_CONFIGS),
      ['packages/9-public/composer/src/report.ts'],
    );
  });

  it('accepts a file listed individually', () => {
    assert.deepEqual(
      findUnclassifiedFiles(['packages/9-public/composer/src/index.ts'], PACKAGE_CONFIGS),
      [],
    );
  });

  it('accepts a file covered by a directory glob', () => {
    assert.deepEqual(
      findUnclassifiedFiles(
        ['packages/0-framework/0-foundation/foundation/src/casts.ts'],
        PACKAGE_CONFIGS,
      ),
      [],
    );
  });

  it('does not let a path merely containing a glob pass', () => {
    assert.deepEqual(
      findUnclassifiedFiles(['vendor/packages/9-public/composer/src/index.ts'], PACKAGE_CONFIGS),
      ['vendor/packages/9-public/composer/src/index.ts'],
    );
  });
});

describe('readImportSpecifiers', () => {
  it('reads static, type, re-export and dynamic specifiers', () => {
    const source = [
      "import { a } from '@internal/core';",
      "import type { B } from '@internal/storage';",
      "export * from '@internal/streams';",
      "const c = await import('@internal/cron');",
    ].join('\n');

    assert.deepEqual(readImportSpecifiers(source), [
      '@internal/core',
      '@internal/storage',
      '@internal/streams',
      '@internal/cron',
    ]);
  });
});

describe('findUnaliasedSpecifiers', () => {
  const WORKSPACE = ['@internal/storage', '@internal/core'];
  const PATHS = { '@internal/core': ['./packages/0-framework/1-core/core/src/index.ts'] };

  it('reports a workspace specifier missing from paths', () => {
    // Without a paths entry the import resolves to the package's exports map
    // (built dist), which the cruiser excludes — the edge is dropped and no
    // rule can fire on it.
    assert.deepEqual(findUnaliasedSpecifiers(['@internal/storage'], WORKSPACE, PATHS), [
      '@internal/storage',
    ]);
  });

  it('reports an unaliased subpath even when the bare package is aliased', () => {
    assert.deepEqual(findUnaliasedSpecifiers(['@internal/core/testing'], WORKSPACE, PATHS), [
      '@internal/core/testing',
    ]);
  });

  it('accepts an aliased specifier', () => {
    assert.deepEqual(findUnaliasedSpecifiers(['@internal/core'], WORKSPACE, PATHS), []);
  });

  it('ignores third-party specifiers', () => {
    assert.deepEqual(findUnaliasedSpecifiers(['node:fs', 'alchemy'], WORKSPACE, PATHS), []);
  });
});

describe('normalizeGlob', () => {
  it('anchors a file pattern so it cannot match a longer path', () => {
    const pattern = new RegExp(normalizeGlob('packages/9-public/composer/src/node.ts'));
    assert.equal(pattern.test('packages/9-public/composer/src/node.ts'), true);
    assert.equal(pattern.test('packages/9-public/composer/src/node-control.ts'), false);
  });
});

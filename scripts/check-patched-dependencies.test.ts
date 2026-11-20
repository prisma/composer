import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  failureMessage,
  type Manifest,
  packageNameOf,
  patchedRuntimeDependencies,
} from './check-patched-dependencies.ts';

const workspace = new Map<string, Manifest>([
  [
    '@prisma/composer-prisma-cloud',
    {
      name: '@prisma/composer-prisma-cloud',
      dependencies: {
        '@alchemy.run/prisma': 'catalog:',
        '@prisma/composer': 'workspace:0.39.0',
        effect: 'catalog:',
      },
    },
  ],
  [
    '@prisma/composer',
    {
      name: '@prisma/composer',
      dependencies: { '@prisma/engine': 'catalog:' },
      devDependencies: { '@internal/lowering': 'workspace:0.39.0', vitest: '^4' },
    },
  ],
  ['@internal/lowering', { name: '@internal/lowering', dependencies: { 'only-for-tests': '^1' } }],
]);

describe('patchedRuntimeDependencies', () => {
  it('names a patched package a published package depends on', () => {
    assert.deepEqual(
      patchedRuntimeDependencies(
        ['@alchemy.run/prisma@2.0.0-beta.87'],
        ['@prisma/composer-prisma-cloud'],
        workspace,
      ),
      [
        {
          patched: '@alchemy.run/prisma',
          publishedPackage: '@prisma/composer-prisma-cloud',
          via: [],
        },
      ],
    );
  });

  it('follows the workspace packages a published package installs', () => {
    assert.deepEqual(
      patchedRuntimeDependencies(
        ['@prisma/engine@1.0.0'],
        ['@prisma/composer-prisma-cloud'],
        workspace,
      ),
      [
        {
          patched: '@prisma/engine',
          publishedPackage: '@prisma/composer-prisma-cloud',
          via: ['@prisma/composer'],
        },
      ],
    );
  });

  it('ignores a patched package that only a devDependency or a test needs', () => {
    assert.deepEqual(
      patchedRuntimeDependencies(
        ['only-for-tests@1.0.0', 'vitest@4.0.0'],
        ['@prisma/composer-prisma-cloud', '@prisma/composer'],
        workspace,
      ),
      [],
    );
  });

  it('passes when nothing is patched', () => {
    assert.deepEqual(
      patchedRuntimeDependencies(
        [],
        ['@prisma/composer-prisma-cloud', '@prisma/composer'],
        workspace,
      ),
      [],
    );
  });
});

describe('packageNameOf', () => {
  it('drops the version from a scoped and an unscoped patch key', () => {
    assert.equal(packageNameOf('@alchemy.run/prisma@2.0.0-beta.87'), '@alchemy.run/prisma');
    assert.equal(packageNameOf('alchemy@2.0.0-beta.87'), 'alchemy');
  });
});

describe('failureMessage', () => {
  it('names the dependency and the published package, and says why it fails', () => {
    const message = failureMessage([
      {
        patched: '@distilled.cloud/prisma',
        publishedPackage: '@prisma/composer-prisma-cloud',
        via: ['@prisma/composer'],
      },
    ]);
    assert.match(
      message,
      /@prisma\/composer-prisma-cloud depends on @distilled\.cloud\/prisma \(through @prisma\/composer\)/,
    );
    assert.match(message, /gets the unpatched dependency/);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  failureMessage,
  type Lockfile,
  packageNameOf,
  patchedNames,
  patchedRuntimeDependencies,
} from './check-patched-dependencies.ts';

const lockfile: Lockfile = {
  patchedDependencies: { '@alchemy.run/prisma@2.0.0': { path: 'patches/a.patch' } },
  importers: {
    'packages/9-public/cloud': {
      dependencies: {
        '@alchemy.run/prisma': { version: '2.0.0(patch_hash=abc)' },
        '@prisma/composer': { version: 'link:../composer' },
        'third-party': { version: '1.0.0' },
      },
    },
    'packages/9-public/composer': {
      dependencies: { effect: { version: '4.1.4' } },
    },
    'packages/1-prisma-cloud/lowering': {
      dependencies: { 'bundled-only': { version: '1.0.0' } },
    },
  },
  snapshots: {
    '@alchemy.run/prisma@2.0.0(patch_hash=abc)': {
      dependencies: { '@distilled.cloud/prisma': '1.0.0(patch_hash=def)' },
    },
    '@distilled.cloud/prisma@1.0.0(patch_hash=def)': {},
    'third-party@1.0.0': { dependencies: { 'deep-patched': '3.0.0' } },
    'deep-patched@3.0.0': {},
    'effect@4.1.4': {},
    'bundled-only@1.0.0': {},
  },
};

const published = new Map([
  ['packages/9-public/cloud', '@prisma/composer-prisma-cloud'],
  ['packages/9-public/composer', '@prisma/composer'],
]);

describe('patchedRuntimeDependencies', () => {
  it('names a patched package a published package lists', () => {
    assert.deepEqual(
      patchedRuntimeDependencies(new Set(['@alchemy.run/prisma']), published, lockfile),
      [
        {
          patched: '@alchemy.run/prisma',
          publishedPackage: '@prisma/composer-prisma-cloud',
          via: [],
        },
      ],
    );
  });

  it('finds a patched package that only a third-party dependency pulls in', () => {
    assert.deepEqual(patchedRuntimeDependencies(new Set(['deep-patched']), published, lockfile), [
      {
        patched: 'deep-patched',
        publishedPackage: '@prisma/composer-prisma-cloud',
        via: ['third-party'],
      },
    ]);
    assert.deepEqual(
      patchedRuntimeDependencies(new Set(['@distilled.cloud/prisma']), published, lockfile),
      [
        {
          patched: '@distilled.cloud/prisma',
          publishedPackage: '@prisma/composer-prisma-cloud',
          via: ['@alchemy.run/prisma'],
        },
      ],
    );
  });

  it('follows the workspace packages a published package installs', () => {
    assert.deepEqual(patchedRuntimeDependencies(new Set(['effect']), published, lockfile), [
      {
        patched: 'effect',
        publishedPackage: '@prisma/composer-prisma-cloud',
        via: ['@prisma/composer'],
      },
      { patched: 'effect', publishedPackage: '@prisma/composer', via: [] },
    ]);
  });

  it('ignores a patched package reached only through a bundled workspace package', () => {
    assert.deepEqual(
      patchedRuntimeDependencies(new Set(['bundled-only']), published, lockfile),
      [],
    );
  });

  it('passes when nothing is patched', () => {
    assert.deepEqual(patchedRuntimeDependencies(new Set(), published, lockfile), []);
  });
});

describe('patchedNames', () => {
  it('takes a patch declared only in pnpm-workspace.yaml', () => {
    assert.deepEqual(
      patchedNames({
        rootManifest: {},
        workspaceFile: { patchedDependencies: { 'only-in-workspace@1.0.0': 'patches/w.patch' } },
        lockfile: { importers: {} },
      }),
      new Set(['only-in-workspace']),
    );
  });

  it('takes patches from the root manifest and the lockfile', () => {
    assert.deepEqual(
      patchedNames({
        rootManifest: { pnpm: { patchedDependencies: { 'in-manifest@1.0.0': 'p' } } },
        workspaceFile: null,
        lockfile,
      }),
      new Set(['in-manifest', '@alchemy.run/prisma']),
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
        via: ['@alchemy.run/prisma'],
      },
    ]);
    assert.match(
      message,
      /@prisma\/composer-prisma-cloud depends on @distilled\.cloud\/prisma \(through @alchemy\.run\/prisma\)/,
    );
    assert.match(message, /gets the unpatched dependency/);
  });
});

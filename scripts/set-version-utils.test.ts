import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type MutablePackageJson, rewriteWorkspaceDeps } from './set-version-utils.ts';

describe('rewriteWorkspaceDeps', () => {
  it('leaves a package with no workspace: deps unchanged (fixture A)', () => {
    const pkg: MutablePackageJson = {
      name: 'a-no-workspace-deps',
      version: '0.7.0',
      dependencies: { lodash: '^4.17.21' },
      devDependencies: { vitest: '^4.0.0' },
    };
    const before = JSON.stringify(pkg);
    rewriteWorkspaceDeps(pkg, '0.8.0');
    assert.equal(JSON.stringify(pkg), before);
  });

  it('rewrites workspace:* and workspace:<old-version> in lockstep (fixture B)', () => {
    const pkg: MutablePackageJson = {
      name: 'b-mixed-workspace-deps',
      version: '0.7.0',
      dependencies: {
        '@prisma/compose': 'workspace:*',
        '@prisma/compose-cloud': 'workspace:0.6.0',
        arktype: '^2.1.29',
      },
      devDependencies: {
        '@prisma/compose-tsdown': 'workspace:*',
      },
    };
    rewriteWorkspaceDeps(pkg, '0.8.0');
    assert.deepEqual(pkg.dependencies, {
      '@prisma/compose': 'workspace:0.8.0',
      '@prisma/compose-cloud': 'workspace:0.8.0',
      arktype: '^2.1.29',
    });
    assert.deepEqual(pkg.devDependencies, {
      '@prisma/compose-tsdown': 'workspace:0.8.0',
    });
  });

  it('is idempotent — re-running with the same version produces no further change (fixture C)', () => {
    const pkg: MutablePackageJson = {
      name: 'c-already-pinned',
      version: '0.8.0',
      dependencies: {
        '@prisma/compose': 'workspace:0.8.0',
      },
      peerDependencies: {
        '@prisma/compose-cloud': 'workspace:0.8.0',
      },
    };
    const before = JSON.stringify(pkg);
    rewriteWorkspaceDeps(pkg, '0.8.0');
    assert.equal(JSON.stringify(pkg), before);
    rewriteWorkspaceDeps(pkg, '0.8.0');
    assert.equal(JSON.stringify(pkg), before);
  });

  it('rewrites across every dep field (dependencies, peer, dev, optional)', () => {
    const pkg: MutablePackageJson = {
      name: 'all-fields',
      version: '0.7.0',
      dependencies: { '@prisma/compose': 'workspace:*' },
      peerDependencies: { '@prisma/compose-cloud': 'workspace:*' },
      devDependencies: { '@prisma/compose-tsdown': 'workspace:*' },
      optionalDependencies: { '@prisma/compose-rpc': 'workspace:*' },
    };
    rewriteWorkspaceDeps(pkg, '1.0.0');
    assert.equal(pkg.dependencies!['@prisma/compose'], 'workspace:1.0.0');
    assert.equal(pkg.peerDependencies!['@prisma/compose-cloud'], 'workspace:1.0.0');
    assert.equal(pkg.devDependencies!['@prisma/compose-tsdown'], 'workspace:1.0.0');
    assert.equal(pkg.optionalDependencies!['@prisma/compose-rpc'], 'workspace:1.0.0');
  });

  it('does not rewrite a non-workspace pin (e.g. a published-version pin)', () => {
    // A consumer package installs a published `@prisma/compose*` dep from the
    // registry. That spec is an exact published version (no `workspace:`
    // prefix) and must not be touched by a host-workspace version bump.
    const pkg: MutablePackageJson = {
      name: 'consumer-with-published-app-dep',
      version: '0.7.0',
      dependencies: {
        '@prisma/compose': '0.7.0',
        '@prisma/compose-cloud': '^0.7.0',
      },
    };
    rewriteWorkspaceDeps(pkg, '0.8.0');
    assert.equal(pkg.dependencies!['@prisma/compose'], '0.7.0');
    assert.equal(pkg.dependencies!['@prisma/compose-cloud'], '^0.7.0');
  });

  it('rewrites a workspace: dep regardless of its name (no name-prefix filter)', () => {
    const pkg: MutablePackageJson = {
      name: 'with-differently-named-workspace-dep',
      version: '0.7.0',
      dependencies: {
        '@example/sibling': 'workspace:*',
        '@prisma/compose': 'workspace:*',
      },
    };
    rewriteWorkspaceDeps(pkg, '0.8.0');
    assert.equal(pkg.dependencies!['@example/sibling'], 'workspace:0.8.0');
    assert.equal(pkg.dependencies!['@prisma/compose'], 'workspace:0.8.0');
  });

  it('tolerates a package with missing dep-field objects', () => {
    const pkg: MutablePackageJson = { name: 'sparse', version: '0.7.0' };
    rewriteWorkspaceDeps(pkg, '0.8.0');
    assert.equal(pkg.version, '0.7.0'); // version is the caller's job, not the helper's
    assert.equal(pkg.dependencies, undefined);
  });
});

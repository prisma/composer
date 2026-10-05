import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { catalogVersion } from './pnpm-catalog.mjs';

describe('catalogVersion', () => {
  it('reads an unquoted pin', () => {
    assert.equal(
      catalogVersion('packages:\n  - x\ncatalog:\n  prisma: 8.0.0-rc.19\n', 'prisma'),
      '8.0.0-rc.19',
    );
  });

  it('reads a quoted pin after other entries', () => {
    const yaml =
      'catalog:\n  effect: \'3.0.0\'\n  prisma: "8.0.0"\nonlyBuiltDependencies:\n  - y\n';
    assert.equal(catalogVersion(yaml, 'prisma'), '8.0.0');
  });

  it('ignores the name outside the catalog block', () => {
    const yaml = 'catalog:\n  effect: 3.0.0\noverrides:\n  prisma: 7.0.0\n';
    assert.equal(catalogVersion(yaml, 'prisma'), undefined);
  });

  it('does not match a name that only ends with the requested one', () => {
    assert.equal(
      catalogVersion('catalog:\n  "@x/prisma": 1.0.0\n  myprisma: 2.0.0\n', 'prisma'),
      undefined,
    );
  });

  it('returns undefined without a catalog', () => {
    assert.equal(catalogVersion('packages:\n  - x\n', 'prisma'), undefined);
  });

  it('finishes quickly on catalog: followed by many whitespace-only lines', () => {
    const yaml = `catalog:\n${' \t '.repeat(20).concat('\n').repeat(5000)}`;
    const start = performance.now();
    assert.equal(catalogVersion(yaml, 'prisma'), undefined);
    assert.ok(performance.now() - start < 100, 'took longer than 100ms');
  });
});

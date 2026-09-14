import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ormPinViolations } from './check-orm-pins.mjs';

describe('ormPinViolations', () => {
  it('passes when every manifest pins each ORM package at one version', () => {
    const manifests = [
      { path: 'a/package.json', deps: { '@prisma/orm-toolchain': '8.0.0-rc.4' } },
      {
        path: 'b/package.json',
        deps: { '@prisma/orm-postgres': '8.0.0-rc.4', '@prisma/orm-toolchain': '8.0.0-rc.4' },
      },
    ];
    assert.deepEqual(ormPinViolations(manifests), []);
  });

  it('reports every manifest whose pin disagrees with the newest pin in the tree', () => {
    const manifests = [
      { path: 'a/package.json', deps: { '@prisma/orm-toolchain': '8.0.0-rc.4' } },
      { path: 'b/package.json', deps: { '@prisma/orm-postgres': '8.0.0-rc.1' } },
    ];
    const violations = ormPinViolations(manifests);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /b\/package\.json/);
    assert.match(violations[0], /@prisma\/orm-postgres@8\.0\.0-rc\.1/);
    assert.match(violations[0], /8\.0\.0-rc\.4/);
  });

  it('ignores non-ORM packages and workspace specifiers', () => {
    const manifests = [
      {
        path: 'a/package.json',
        deps: { '@prisma/cli-engine': '0.2.0', '@internal/x': 'workspace:1.0.0' },
      },
    ];
    assert.deepEqual(ormPinViolations(manifests), []);
  });
});

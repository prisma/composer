import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { identityMismatches, type PlatformRow, type TopologyNode } from './platform-identity.ts';

const BRANCH = 'br_main';

const nodes: TopologyNode[] = [
  { logicalId: 'shop', kind: 'module' },
  { logicalId: 'auth', kind: 'module' },
  { logicalId: 'auth.service', kind: 'service', type: 'compute' },
  { logicalId: 'auth.database', kind: 'resource', type: 'raw-postgres' },
  { logicalId: 'files', kind: 'resource', type: 's3' },
  { logicalId: 'creds', kind: 'resource', type: 'credentials' },
];

const matchingRows: PlatformRow[] = [
  { kind: 'app', id: 'app_1', branchId: BRANCH, logicalId: 'auth.service' },
  { kind: 'database', id: 'db_1', branchId: BRANCH, logicalId: 'auth.database' },
  { kind: 'bucket', id: 'bkt_1', branchId: BRANCH, logicalId: 'files' },
];

describe('identityMismatches', () => {
  it('accepts one row per service, database and bucket node, ignoring modules and row-less resources', () => {
    assert.deepEqual(identityMismatches(nodes, matchingRows, BRANCH), []);
  });

  it('ignores rows on other branches', () => {
    const rows = [
      ...matchingRows,
      { kind: 'app' as const, id: 'app_2', branchId: 'br_pr', logicalId: null },
    ];
    assert.deepEqual(identityMismatches(nodes, rows, BRANCH), []);
  });

  it('reports a node whose row carries a different logicalId, and that row', () => {
    const rows = matchingRows.map((row) =>
      row.id === 'db_1' ? { ...row, logicalId: 'auth.database-db' } : row,
    );
    assert.deepEqual(identityMismatches(nodes, rows, BRANCH), [
      'resource node "auth.database" should match exactly one database row on branch br_main; found 0',
      'database db_1 on branch br_main has logicalId "auth.database-db", which names no database-backed node in the topology',
    ]);
  });

  it('reports a row with no logicalId', () => {
    const rows = matchingRows.map((row) =>
      row.id === 'app_1' ? { ...row, logicalId: null } : row,
    );
    assert.deepEqual(identityMismatches(nodes, rows, BRANCH), [
      'service node "auth.service" should match exactly one app row on branch br_main; found 0',
      'app app_1 on branch br_main has no logicalId',
    ]);
  });

  it('reports a row whose logicalId names a node of another kind', () => {
    const rows = [
      ...matchingRows,
      { kind: 'bucket' as const, id: 'bkt_2', branchId: BRANCH, logicalId: 'auth.service' },
    ];
    assert.deepEqual(identityMismatches(nodes, rows, BRANCH), [
      'bucket bkt_2 on branch br_main has logicalId "auth.service", which names no bucket-backed node in the topology',
    ]);
  });

  it('reports a node matched by two rows', () => {
    const rows = [
      ...matchingRows,
      { kind: 'bucket' as const, id: 'bkt_2', branchId: BRANCH, logicalId: 'files' },
    ];
    assert.deepEqual(identityMismatches(nodes, rows, BRANCH), [
      'resource node "files" should match exactly one bucket row on branch br_main; found 2',
    ]);
  });
});

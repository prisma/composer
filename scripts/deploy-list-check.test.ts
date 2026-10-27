import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deployListMismatches,
  type ListedNode,
  type ListedPlatform,
  parseListed,
} from './deploy-list-check.ts';

const BRANCH = 'br_main';

const platform: ListedPlatform = {
  projectId: 'proj_1',
  branchId: BRANCH,
  nodes: [
    { logicalId: 'shop', parentLogicalId: null, kind: 'module' },
    { logicalId: 'shop.api', parentLogicalId: 'shop', kind: 'service', type: 'compute' },
    { logicalId: 'shop.db', parentLogicalId: 'shop', kind: 'resource', type: 'raw-postgres' },
    { logicalId: 'shop.files', parentLogicalId: 'shop', kind: 'resource', type: 's3' },
    { logicalId: 'shop.creds', parentLogicalId: 'shop', kind: 'resource', type: 'credentials' },
  ],
  rows: [
    {
      kind: 'app',
      id: 'app_1',
      branchId: BRANCH,
      logicalId: 'shop.api',
      appEndpointDomain: 'https://api.prisma.app',
    },
    { kind: 'app', id: 'app_other', branchId: 'br_other', logicalId: 'shop.api' },
    { kind: 'database', id: 'db_1', branchId: BRANCH, logicalId: 'shop.db' },
    { kind: 'bucket', id: 'bkt_1', branchId: BRANCH, logicalId: 'shop.files' },
  ],
};

const listed: ListedNode[] = [
  { address: 'shop', kind: 'project', platformId: 'proj_1', url: null },
  { address: 'shop.api', kind: 'service', platformId: 'app_1', url: 'https://api.prisma.app' },
  { address: 'shop.db', kind: 'postgres', platformId: 'db_1', url: null },
  { address: 'shop.files', kind: 'bucket', platformId: 'bkt_1', url: null },
  { address: 'shop.creds', kind: 'credentials', platformId: null, url: null },
];

describe('deployListMismatches', () => {
  it('accepts a listing that matches the topology and the rows on the stage Branch', () => {
    assert.deepEqual(deployListMismatches(listed, platform), []);
  });

  it('reports a missing node', () => {
    assert.deepEqual(deployListMismatches(listed.slice(0, -1), platform), [
      'lists [shop, shop.api, shop.db, shop.files], but the topology has [shop, shop.api, shop.db, shop.files, shop.creds]',
    ]);
  });

  it('reports a node out of topology order', () => {
    const swapped = [listed[0], listed[2], listed[1], listed[3], listed[4]].filter(
      (entry) => entry !== undefined,
    );
    assert.equal(deployListMismatches(swapped, platform).length, 1);
  });

  it('reports an ID that is not the row with the node logicalId on the stage Branch', () => {
    const wrong = listed.map((entry) =>
      entry.address === 'shop.api' ? { ...entry, platformId: 'app_other' } : entry,
    );
    assert.deepEqual(deployListMismatches(wrong, platform), [
      'shop.api lists platform ID app_other, but the platform has app_1',
    ]);
  });

  it('reports a kind that is not the one its topology node implies', () => {
    const wrong = listed.map((entry) => {
      if (entry.address === 'shop.db') return { ...entry, kind: 'raw-postgres' };
      if (entry.address === 'shop.files') return { ...entry, kind: 'module' };
      return entry;
    });
    assert.deepEqual(deployListMismatches(wrong, platform), [
      'shop.db lists kind raw-postgres, but its topology node is a postgres',
      'shop.files lists kind module, but its topology node is a bucket',
    ]);
  });

  it('reports a root whose ID is not the Project', () => {
    const wrong = listed.map((entry) =>
      entry.address === 'shop' ? { ...entry, platformId: null } : entry,
    );
    assert.deepEqual(deployListMismatches(wrong, platform), [
      'shop lists platform ID null, but the platform has proj_1',
    ]);
  });

  it('reports a service URL that is not its endpoint, or not https', () => {
    const wrong = listed.map((entry) =>
      entry.address === 'shop.api' ? { ...entry, url: 'http://api.prisma.app' } : entry,
    );
    assert.deepEqual(deployListMismatches(wrong, platform), [
      'shop.api lists URL http://api.prisma.app, but expected https://api.prisma.app',
      'shop.api lists URL http://api.prisma.app, which is not https',
    ]);
  });
});

describe('parseListed', () => {
  it('reads the nodes from the result event', () => {
    assert.deepEqual(
      parseListed({ kind: 'result', envelope: { ok: true, result: listed } }),
      listed,
    );
  });

  it('rejects an event with no list of nodes', () => {
    assert.throws(
      () => parseListed({ kind: 'result', envelope: { ok: false, error: {} } }),
      /printed no list of nodes/,
    );
    assert.throws(() =>
      parseListed({ kind: 'result', envelope: { ok: true, result: [{ address: 1 }] } }),
    );
  });
});

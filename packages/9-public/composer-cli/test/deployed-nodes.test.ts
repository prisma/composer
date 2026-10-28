import { describe, expect, test } from 'bun:test';
import type { DeployedEnvironment } from '@internal/lowering/deployed';
import { deployedNodes } from '../src/family/deployed-nodes.ts';

const empty: DeployedEnvironment = {
  projectId: 'proj_1',
  branchId: 'br_1',
  nodes: [],
  services: [],
  databases: [],
  buckets: [],
};

describe('deployedNodes', () => {
  test('the root node is the Project', () => {
    expect(
      deployedNodes({
        ...empty,
        nodes: [{ logicalId: 'shop', parentLogicalId: null, kind: 'module' }],
      }),
    ).toEqual([{ address: 'shop', kind: 'project', platformId: 'proj_1', url: null }]);
  });

  test('a service is its row, with the URL a deploy prints', () => {
    expect(
      deployedNodes({
        ...empty,
        nodes: [{ logicalId: 'shop.api', parentLogicalId: 'shop', kind: 'service' }],
        services: [
          { id: 'svc_other', logicalId: 'shop.web', appEndpointDomain: 'https://web.prisma.app' },
          { id: 'svc_1', logicalId: 'shop.api', appEndpointDomain: 'https://api.prisma.app' },
        ],
      }),
    ).toEqual([
      { address: 'shop.api', kind: 'service', platformId: 'svc_1', url: 'https://api.prisma.app' },
    ]);
  });

  test('both Postgres types are postgres, found among the databases', () => {
    expect(
      deployedNodes({
        ...empty,
        nodes: [
          { logicalId: 'shop.db', parentLogicalId: 'shop', kind: 'resource', type: 'postgres' },
          {
            logicalId: 'shop.raw',
            parentLogicalId: 'shop',
            kind: 'resource',
            type: 'raw-postgres',
          },
        ],
        databases: [
          { id: 'db_raw', logicalId: 'shop.raw' },
          { id: 'db_1', logicalId: 'shop.db' },
        ],
      }),
    ).toEqual([
      { address: 'shop.db', kind: 'postgres', platformId: 'db_1', url: null },
      { address: 'shop.raw', kind: 'postgres', platformId: 'db_raw', url: null },
    ]);
  });

  test('an S3 resource is a bucket, found among the buckets', () => {
    expect(
      deployedNodes({
        ...empty,
        nodes: [{ logicalId: 'shop.files', parentLogicalId: 'shop', kind: 'resource', type: 's3' }],
        buckets: [{ id: 'bkt_1', logicalId: 'shop.files' }],
      }),
    ).toEqual([{ address: 'shop.files', kind: 'bucket', platformId: 'bkt_1', url: null }]);
  });

  test('a module below the root has no row', () => {
    expect(
      deployedNodes({
        ...empty,
        nodes: [{ logicalId: 'shop.catalog', parentLogicalId: 'shop', kind: 'module' }],
      }),
    ).toEqual([{ address: 'shop.catalog', kind: 'module', platformId: null, url: null }]);
  });

  test('another resource shows its type and has no row', () => {
    expect(
      deployedNodes({
        ...empty,
        nodes: [
          {
            logicalId: 'shop.keys',
            parentLogicalId: 'shop',
            kind: 'resource',
            type: 's3-credentials',
          },
        ],
      }),
    ).toEqual([{ address: 'shop.keys', kind: 's3-credentials', platformId: null, url: null }]);
  });

  test('a node whose row is missing lists with no platform ID', () => {
    expect(
      deployedNodes({
        ...empty,
        nodes: [
          { logicalId: 'shop.api', parentLogicalId: 'shop', kind: 'service' },
          { logicalId: 'shop.db', parentLogicalId: 'shop', kind: 'resource', type: 'postgres' },
        ],
        services: [
          { id: 'svc_1', logicalId: 'shop.web', appEndpointDomain: 'https://web.prisma.app' },
        ],
      }),
    ).toEqual([
      { address: 'shop.api', kind: 'service', platformId: null, url: null },
      { address: 'shop.db', kind: 'postgres', platformId: null, url: null },
    ]);
  });

  test('no topology lists nothing', () => {
    expect(deployedNodes(empty)).toEqual([]);
  });

  test('keeps topology order', () => {
    expect(
      deployedNodes({
        ...empty,
        nodes: [
          { logicalId: 'shop', parentLogicalId: null, kind: 'module' },
          { logicalId: 'shop.z', parentLogicalId: 'shop', kind: 'module' },
          { logicalId: 'shop.a', parentLogicalId: 'shop', kind: 'module' },
        ],
      }).map((node) => node.address),
    ).toEqual(['shop', 'shop.z', 'shop.a']);
  });
});

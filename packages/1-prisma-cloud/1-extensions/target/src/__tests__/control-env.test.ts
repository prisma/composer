import { describe, expect, test } from 'bun:test';
import { prismaCloud } from '../control.ts';

/** Sets env vars for the duration of `fn`, restoring whatever was there before. */
async function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): Promise<T> {
  const previous = new Map(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('prismaCloud() — env read + validation at construction (config evaluation)', () => {
  test('builds a descriptor from PRISMA_WORKSPACE_ID alone', async () => {
    await withEnv({ PRISMA_WORKSPACE_ID: 'ws-123', PRISMA_REGION: undefined }, () => {
      const descriptor = prismaCloud();
      expect(descriptor.id).toBe('@prisma/composer-prisma-cloud');
      expect(Object.keys(descriptor.nodes).sort()).toEqual([
        'compute',
        'credentials',
        'postgres',
        'prisma-next',
        's3-store',
      ]);
    });
  });

  test('an explicit workspaceId option wins — no env needed', async () => {
    await withEnv({ PRISMA_WORKSPACE_ID: undefined, PRISMA_REGION: undefined }, () => {
      expect(() => prismaCloud({ workspaceId: 'ws-explicit' })).not.toThrow();
    });
  });

  test('accepts a known PRISMA_REGION', async () => {
    await withEnv({ PRISMA_WORKSPACE_ID: 'ws-123', PRISMA_REGION: 'eu-west-3' }, () => {
      expect(() => prismaCloud()).not.toThrow();
    });
  });

  test('throws naming PRISMA_WORKSPACE_ID when it is missing', async () => {
    await withEnv({ PRISMA_WORKSPACE_ID: undefined, PRISMA_REGION: undefined }, () => {
      expect(() => prismaCloud()).toThrow(/PRISMA_WORKSPACE_ID/);
    });
  });

  test('throws naming the bad value when PRISMA_REGION is not a known region', async () => {
    await withEnv({ PRISMA_WORKSPACE_ID: 'ws-123', PRISMA_REGION: 'mars-1' }, () => {
      expect(() => prismaCloud()).toThrow(/PRISMA_REGION="mars-1"/);
    });
  });

  test('the descriptor carries the registry kinds the router checks', async () => {
    await withEnv({ PRISMA_WORKSPACE_ID: 'ws-123', PRISMA_REGION: undefined }, () => {
      const descriptor = prismaCloud();
      expect(descriptor.nodes['postgres']?.kind).toBe('resource');
      expect(descriptor.nodes['compute']?.kind).toBe('service');
      expect(descriptor.nodes['credentials']?.kind).toBe('resource');
      expect(descriptor.nodes['s3-store']?.kind).toBe('service');
      expect(descriptor.application).toBeDefined();
      expect(descriptor.providers).toBeDefined();
    });
  });
});

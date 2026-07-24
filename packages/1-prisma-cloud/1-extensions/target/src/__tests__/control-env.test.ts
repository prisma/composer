import { describe, expect, test } from 'bun:test';
import type { LowerContext } from '@internal/core/deploy';
import * as Effect from 'effect/Effect';
import { prismaCloud } from '../exports/control.ts';

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

const SCRUBBED = {
  PRISMA_WORKSPACE_ID: undefined,
  PRISMA_REGION: undefined,
  PRISMA_SERVICE_TOKEN: undefined,
};

/** Minimal `LowerContext` for driving one node descriptor's `provision` in isolation. */
function computeCtx(): LowerContext {
  return {
    id: 'auth',
    application: { projectId: 'shop-project#cloud-id', branchId: undefined },
  } as unknown as LowerContext;
}

/** The throw under test happens before any yield, so no Alchemy context is ever needed — collapse E/R for `runSync` like `control-lowering.test.ts`'s `run` helper does. */
function runSync<A>(eff: Effect.Effect<unknown, unknown, unknown>): A {
  return Effect.runSync(eff as Effect.Effect<A>);
}

describe('prismaCloud() — constructs with NO environment present (local-dev spec § 5)', () => {
  test('succeeds in a fully scrubbed environment — no PRISMA_* var is required at construction', async () => {
    await withEnv(SCRUBBED, () => {
      const descriptor = prismaCloud();
      expect(descriptor.id).toBe('@prisma/composer-prisma-cloud');
      expect(Object.keys(descriptor.nodes).sort()).toEqual([
        'compute',
        'credentials',
        'postgres',
        'prisma-next',
        's3',
        's3-store',
      ]);
      // The localTarget descriptor is present unconditionally — an
      // extension without one is not local-target-capable, and this one
      // always is (ADR-0041).
      expect(descriptor.localTarget).toBeDefined();
    });
  });

  test('an explicit workspaceId option still works — no env needed either way', async () => {
    await withEnv(SCRUBBED, () => {
      expect(() => prismaCloud({ workspaceId: 'ws-explicit' })).not.toThrow();
    });
  });

  test('builds a descriptor from PRISMA_WORKSPACE_ID alone', async () => {
    await withEnv({ PRISMA_WORKSPACE_ID: 'ws-123', PRISMA_REGION: undefined }, () => {
      const descriptor = prismaCloud();
      expect(descriptor.nodes['postgres']?.kind).toBe('resource');
      expect(descriptor.nodes['compute']?.kind).toBe('service');
      expect(descriptor.nodes['credentials']?.kind).toBe('resource');
      expect(descriptor.nodes['s3-store']?.kind).toBe('service');
      expect(descriptor.nodes['s3']?.kind).toBe('resource');
      expect(descriptor.application).toBeDefined();
      expect(descriptor.providers).toBeDefined();
    });
  });
});

describe('prismaCloud() — region resolution is deferred to first lowering use, not construction', () => {
  test('a bad PRISMA_REGION does not fail construction — only an actual lowering', async () => {
    await withEnv({ PRISMA_WORKSPACE_ID: 'ws-123', PRISMA_REGION: 'mars-1' }, () => {
      expect(() => prismaCloud()).not.toThrow();

      const descriptor = prismaCloud();
      const compute = descriptor.nodes['compute'];
      if (compute === undefined || compute.kind !== 'service') {
        throw new Error('expected a service descriptor for "compute"');
      }
      expect(() => runSync(compute.provision(computeCtx()))).toThrow(/PRISMA_REGION="mars-1"/);
    });
  });
});

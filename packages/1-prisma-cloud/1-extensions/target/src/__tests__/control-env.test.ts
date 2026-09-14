import { describe, expect, test } from 'bun:test';
import type { ManagementApiClient } from '@internal/lowering';
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

describe('prismaCloud() — constructs with NO environment present (local-dev spec § 5)', () => {
  test('succeeds in a fully scrubbed environment — no PRISMA_* var is required at construction', async () => {
    await withEnv(SCRUBBED, () => {
      const descriptor = prismaCloud();
      expect(descriptor.id).toBe('@prisma/composer-prisma-cloud');
      expect(Object.keys(descriptor.nodes).sort()).toEqual([
        'compute',
        'credentials',
        'postgres',
        'raw-postgres',
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

/** A stub client covering only what `ensure` calls for a project that does not exist yet; records every project-create body. */
const fakeClient = (projectCreateBodies: Array<Record<string, unknown>>): ManagementApiClient => {
  const page = <T>(data: T[]) =>
    Promise.resolve({
      data: { data, pagination: { nextCursor: null, hasMore: false } },
      error: undefined,
      response: new Response(null, { status: 200 }),
    });
  const GET = (path: string) => {
    if (path === '/v1/projects') return page([]);
    if (path === '/v1/projects/{projectId}/branches') {
      return page([{ id: 'br-default', gitName: 'main', isDefault: true }]);
    }
    throw new Error(`fakeClient: unexpected GET ${path}`);
  };
  const POST = (path: string, init: { body?: Record<string, unknown> } = {}) => {
    if (path !== '/v1/projects') throw new Error(`fakeClient: unexpected POST ${path}`);
    projectCreateBodies.push(init.body ?? {});
    return Promise.resolve({
      data: { data: { id: 'proj-1' } },
      error: undefined,
      response: new Response(null, { status: 201 }),
    });
  };
  // biome-ignore lint/suspicious/noExplicitAny: test stub — see the doc comment above.
  return { GET, POST } as any as ManagementApiClient;
};

describe('prismaCloud() — region resolution is deferred to first lowering use, not construction', () => {
  test('an arbitrary PRISMA_REGION string passes through unchanged — no list to validate against', async () => {
    await withEnv({ PRISMA_WORKSPACE_ID: 'ws-123', PRISMA_REGION: 'xx-test-1' }, async () => {
      expect(() => prismaCloud()).not.toThrow();

      const projectCreateBodies: Array<Record<string, unknown>> = [];
      const container = prismaCloud().container;
      expect(container).toBeDefined();
      await container?.ensure(
        { appName: 'storefront', stage: undefined },
        { workspaceId: 'ws-123', client: fakeClient(projectCreateBodies) },
      );
      expect(projectCreateBodies[0]?.['region']).toBe('xx-test-1');
    });
  });
});

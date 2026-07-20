import { describe, expect, test } from 'bun:test';
import type { StackServices } from 'alchemy';
import type { State } from 'alchemy/State';
import type * as Layer from 'effect/Layer';
import { prismaStateLayer } from '../layer.ts';

describe('prismaStateLayer', () => {
  test('its signature satisfies core’s StateDescriptor.create contract — typechecked, never run (that would touch the cloud)', () => {
    const typed: (ids: {
      readonly projectId: string;
      readonly branchId?: string;
    }) => Layer.Layer<State, never, StackServices> = prismaStateLayer;
    expect(typed).toBe(prismaStateLayer);
  });

  test('constructing the layer is inert — a projectId builds a Layer without touching the network', () => {
    // Layer.effect(...) only builds a lazy Effect description — no Management
    // API call, no Postgres connection, no PRISMA_SERVICE_TOKEN read — until
    // something actually provides/runs the layer, which this test never does.
    expect(prismaStateLayer({ projectId: 'prj_1' })).toBeDefined();
  });

  test('branchId is optional — a named-stage deploy passes it, the default stage omits it', () => {
    expect(prismaStateLayer({ projectId: 'prj_1', branchId: 'br_1' })).toBeDefined();
  });
});

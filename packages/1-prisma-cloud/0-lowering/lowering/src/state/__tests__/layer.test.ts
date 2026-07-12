import { afterEach, describe, expect, test } from 'bun:test';
import type { StackServices } from 'alchemy';
import type { State } from 'alchemy/State';
import type * as Layer from 'effect/Layer';
import { prismaState } from '../layer.ts';

const originalWorkspaceId = process.env['PRISMA_WORKSPACE_ID'];

afterEach(() => {
  if (originalWorkspaceId === undefined) delete process.env['PRISMA_WORKSPACE_ID'];
  else process.env['PRISMA_WORKSPACE_ID'] = originalWorkspaceId;
});

describe('prismaState', () => {
  test('its signature satisfies core’s LowerOptions.state contract — typechecked, never run (that would touch the cloud)', () => {
    const typed: (opts?: { workspaceId?: string }) => Layer.Layer<State, never, StackServices> =
      prismaState;
    expect(typed).toBe(prismaState);
  });

  test('constructing the layer is inert — an explicit workspaceId builds a Layer without touching the network', () => {
    // Layer.effect(...) only builds a lazy Effect description — no Management
    // API call, no Postgres connection, no PRISMA_SERVICE_TOKEN read — until
    // something actually provides/runs the layer, which this test never does.
    expect(prismaState({ workspaceId: 'ws_1' })).toBeDefined();
  });

  test('omitted workspaceId falls back to PRISMA_WORKSPACE_ID', () => {
    process.env['PRISMA_WORKSPACE_ID'] = 'ws_env';
    expect(prismaState()).toBeDefined();
  });

  test('missing PRISMA_WORKSPACE_ID fails at construction naming the variable', () => {
    delete process.env['PRISMA_WORKSPACE_ID'];
    expect(() => prismaState()).toThrow(/PRISMA_WORKSPACE_ID/);
  });
});

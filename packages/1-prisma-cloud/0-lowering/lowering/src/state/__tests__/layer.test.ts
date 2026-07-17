import { afterEach, describe, expect, test } from 'bun:test';
import type { StackServices } from 'alchemy';
import type { State } from 'alchemy/State';
import type * as Layer from 'effect/Layer';
import { prismaState } from '../layer.ts';

const originalProjectId = process.env['PRISMA_PROJECT_ID'];
const originalBranchId = process.env['PRISMA_BRANCH_ID'];

afterEach(() => {
  if (originalProjectId === undefined) delete process.env['PRISMA_PROJECT_ID'];
  else process.env['PRISMA_PROJECT_ID'] = originalProjectId;
  if (originalBranchId === undefined) delete process.env['PRISMA_BRANCH_ID'];
  else process.env['PRISMA_BRANCH_ID'] = originalBranchId;
});

describe('prismaState', () => {
  test('its signature satisfies core’s LowerOptions.state contract — typechecked, never run (that would touch the cloud)', () => {
    const typed: () => Layer.Layer<State, never, StackServices> = prismaState;
    expect(typed).toBe(prismaState);
  });

  test('constructing the layer is inert — a set PRISMA_PROJECT_ID builds a Layer without touching the network', () => {
    // Layer.effect(...) only builds a lazy Effect description — no Management
    // API call, no Postgres connection, no PRISMA_SERVICE_TOKEN read — until
    // something actually provides/runs the layer, which this test never does.
    process.env['PRISMA_PROJECT_ID'] = 'prj_1';
    delete process.env['PRISMA_BRANCH_ID'];
    expect(prismaState()).toBeDefined();
  });

  test('PRISMA_BRANCH_ID is optional — a named-stage deploy sets it, the default stage leaves it unset', () => {
    process.env['PRISMA_PROJECT_ID'] = 'prj_1';
    process.env['PRISMA_BRANCH_ID'] = 'br_1';
    expect(prismaState()).toBeDefined();
  });

  test('an empty-string PRISMA_BRANCH_ID is treated as absent, same as unset', () => {
    process.env['PRISMA_PROJECT_ID'] = 'prj_1';
    process.env['PRISMA_BRANCH_ID'] = '';
    expect(prismaState()).toBeDefined();
  });

  test('missing PRISMA_PROJECT_ID fails at construction naming the variable', () => {
    delete process.env['PRISMA_PROJECT_ID'];
    expect(() => prismaState()).toThrow(/PRISMA_PROJECT_ID/);
  });

  test('empty-string PRISMA_PROJECT_ID fails at construction, same as unset', () => {
    process.env['PRISMA_PROJECT_ID'] = '';
    expect(() => prismaState()).toThrow(/PRISMA_PROJECT_ID/);
  });
});

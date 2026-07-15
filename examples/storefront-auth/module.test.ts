import { describe, expect, test } from 'bun:test';
import { Load } from '@prisma/compose';
import { secretName } from '@prisma/compose-prisma-cloud';
import root from './module.ts';

describe('storefront-auth root graph', () => {
  test('the auth secret need forwards from the root binding down to the inner service', () => {
    // Loads the REAL app graph: dropping the module→service forward, renaming
    // the slot, or removing the root envSecret binding all break this — none of
    // which typecheck catches, and the only other graph-Loading gate is CI E2E.
    const graph = Load(root);
    expect(graph.secrets.length).toBe(1);
    expect(graph.secrets[0]?.serviceAddress).toBe('auth.service');
    expect(graph.secrets[0]?.slot).toBe('signingKey');
    // The env-var name lives in the target's opaque payload, read via secretName.
    expect(secretName(graph.secrets[0]!)).toBe('AUTH_SIGNING_SECRET');
  });
});

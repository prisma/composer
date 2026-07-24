import { describe, expect, test } from 'bun:test';
import { isSecretSource, Load } from '@prisma/composer';
import { secretName } from '@prisma/composer-prisma-cloud';
import root from './module.ts';

describe('storefront-auth root graph', () => {
  test('the auth secret forwards from the root binding into the inner service input binding', () => {
    // Loads the REAL app graph: dropping the module→service forward, renaming
    // the input key, or removing the root envSecret binding all break this —
    // none of which typecheck catches, and the only other graph-Loading check
    // is CI E2E.
    const graph = Load(root);
    expect(graph.inputBindings.length).toBe(1);
    const recorded = graph.inputBindings[0];
    expect(recorded?.serviceAddress).toBe('auth.service');
    const binding = recorded?.binding;
    if (typeof binding !== 'object' || binding === null || Array.isArray(binding)) {
      throw new Error('expected an object input binding for auth.service');
    }
    const leaf = (binding as Record<string, unknown>)['signingKey'];
    if (!isSecretSource(leaf)) throw new Error('expected a secret-source leaf');
    // The env-var name lives in the target's opaque payload, read via secretName.
    expect(secretName(leaf, 'the signingKey leaf')).toBe('AUTH_SIGNING_SECRET');
  });
});

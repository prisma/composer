import { describe, expect, test } from 'bun:test';
import { Load, type SecretSource } from '@prisma/composer';
import { isOriginParamSource, secretName } from '@prisma/composer-prisma-cloud';
import root from '../module.ts';

/** The recorded input binding of one service, as the plain object it is. */
function bindingOf(graph: ReturnType<typeof Load>, address: string): Record<string, unknown> {
  const binding = graph.inputBindings.find((b) => b.serviceAddress === address)?.binding;
  if (typeof binding !== 'object' || binding === null || Array.isArray(binding)) {
    throw new Error(`expected an object input binding for ${address}`);
  }
  return binding as Record<string, unknown>;
}

describe('auth example root graph', () => {
  test("the root binds the email module's input from the config pool and auth's baseUrl to the api's origin", () => {
    const graph = Load(root, {
      configPool: { EMAIL_DELIVERY_MODE: 'none', EMAIL_FROM: 'dev@example.com' },
    });

    const mail = bindingOf(graph, 'auth-example.mail.service');
    expect(mail['deliveryMode']).toBe('none');
    expect(mail['from']).toBe('dev@example.com');
    expect(secretName(mail['deliveryCredential'] as SecretSource, 'deliveryCredential')).toBe(
      'EMAIL_DELIVERY_CREDENTIAL',
    );
    expect(isOriginParamSource(bindingOf(graph, 'auth-example.auth.service')['baseUrl'])).toBe(
      true,
    );
  });
});

import { describe, expect, test } from 'bun:test';
import { Load, type SecretSource } from '@prisma/composer';
import { secretName } from '@prisma/composer-prisma-cloud';
import root from '../module.ts';

/** The email service's recorded input binding, as the plain object it is. */
function serviceBindingOf(graph: ReturnType<typeof Load>): Record<string, unknown> {
  const binding = graph.inputBindings.find(
    (b) => b.serviceAddress === 'email-example.email.service',
  )?.binding;
  if (typeof binding !== 'object' || binding === null || Array.isArray(binding)) {
    throw new Error('expected an object input binding for email-example.email.service');
  }
  return binding as Record<string, unknown>;
}

describe('email example root graph', () => {
  test("the root's input from the config pool reaches the email service", () => {
    const graph = Load(root, {
      configPool: { EMAIL_DELIVERY_MODE: 'none', EMAIL_FROM: 'a@example.com', PATH: '/bin' },
    });
    const binding = serviceBindingOf(graph);
    expect(binding['deliveryMode']).toBe('none');
    expect(binding['from']).toBe('a@example.com');
    expect(secretName(binding['deliveryCredential'] as SecretSource, 'deliveryCredential')).toBe(
      'EMAIL_DELIVERY_CREDENTIAL',
    );
  });

  test("a delivery mode the root's schema does not name fails before anything is created", () => {
    let message = '';
    try {
      Load(root, { configPool: { EMAIL_DELIVERY_MODE: 'smpt', EMAIL_FROM: 'a@example.com' } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toStartWith(
      'The input of root module "email-example" does not match its input schema: EMAIL_DELIVERY_MODE must be ',
    );
    expect(message).toContain('(was "smpt")');
  });
});

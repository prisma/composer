import { describe, expect, test } from 'bun:test';
import { Load } from '@prisma/composer';
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

/** The name of the platform variable a service's input field reads, found through the graph. */
function variableReadAt(graph: ReturnType<typeof Load>, reader: string, path: string): unknown {
  const read = graph.valueReads.find(
    (entry) =>
      entry.reader === reader && entry.site.kind === 'serviceInput' && entry.site.path === path,
  );
  const node = graph.nodes.find((entry) => entry.id === read?.resource)?.node;
  return node?.kind === 'resource' ? node.props['name'] : undefined;
}

describe('email example root graph', () => {
  test("the root's input from the app configuration reaches the email service", () => {
    const graph = Load(root, {
      configuration: { EMAIL_DELIVERY_MODE: 'none', EMAIL_FROM: 'a@example.com', PATH: '/bin' },
    });
    const binding = serviceBindingOf(graph);
    expect(binding['deliveryMode']).toBe('none');
    expect(binding['from']).toBe('a@example.com');
    expect(variableReadAt(graph, 'email-example.email.service', 'deliveryCredential')).toBe(
      'EMAIL_DELIVERY_CREDENTIAL',
    );
  });

  test("a delivery mode the root's schema does not name fails before anything is created", () => {
    let message = '';
    try {
      Load(root, { configuration: { EMAIL_DELIVERY_MODE: 'smpt', EMAIL_FROM: 'a@example.com' } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toStartWith(
      'The input of root module "email-example" does not match its input schema: EMAIL_DELIVERY_MODE must be ',
    );
    expect(message).toContain('(was "smpt")');
  });
});

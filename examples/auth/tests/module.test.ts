import { describe, expect, test } from 'bun:test';
import { Load } from '@prisma/composer';
import { isOriginParamSource } from '@prisma/composer-prisma-cloud';
import root from '../module.ts';

/** The recorded input binding of one service, as the plain object it is. */
function bindingOf(graph: ReturnType<typeof Load>, address: string): Record<string, unknown> {
  const binding = graph.inputBindings.find((b) => b.serviceAddress === address)?.binding;
  if (typeof binding !== 'object' || binding === null || Array.isArray(binding)) {
    throw new Error(`expected an object input binding for ${address}`);
  }
  return binding as Record<string, unknown>;
}

function variableReadAt(graph: ReturnType<typeof Load>, reader: string, path: string): unknown {
  const read = graph.valueReads.find((entry) => entry.reader === reader && entry.path === path);
  const node = graph.nodes.find((entry) => entry.id === read?.resource)?.node;
  return node?.kind === 'resource' ? node.props['name'] : undefined;
}

describe('auth example root graph', () => {
  test("the root binds the email module's delivery mode from the app configuration, its sender and credential to platform variables, and auth's baseUrl to the api's origin", () => {
    const graph = Load(root, {
      configuration: { EMAIL_DELIVERY_MODE: 'none' },
    });

    const mail = bindingOf(graph, 'auth-example.mail.service');
    expect(mail['deliveryMode']).toBe('none');
    expect(variableReadAt(graph, 'auth-example.mail.service', 'from')).toBe('EMAIL_FROM');
    expect(variableReadAt(graph, 'auth-example.mail.service', 'deliveryCredential')).toBe(
      'EMAIL_DELIVERY_CREDENTIAL',
    );
    expect(isOriginParamSource(bindingOf(graph, 'auth-example.auth.service')['baseUrl'])).toBe(
      true,
    );
  });
});

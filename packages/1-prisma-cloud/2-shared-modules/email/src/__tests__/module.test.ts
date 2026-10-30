/**
 * The `email()` module Loads into a wired graph: it owns a Postgres `db`
 * resource and the `email` service wired to it, passes its input on to the
 * service, and its two ports (`send`, `outbox`) wire to two different
 * consumers independently. Mirrors storage's module.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { Load, module, type SecretSource } from '@internal/core';
import node from '@internal/node';
import { compute, envParam, envSecret, secretName } from '@internal/prisma-cloud';
import { rpc } from '@internal/service-rpc';
import { emailOutboxContract, emailSender } from '../contract.ts';
import { email } from '../email-module.ts';

const build = node({ module: import.meta.url, entry: '../dist/x.mjs' });

/** The email service's recorded input binding, as the plain object it is. */
function serviceBindingOf(
  inputBindings: ReadonlyArray<{ serviceAddress: string; binding: unknown }>,
): Record<string, unknown> {
  const binding = inputBindings.find((b) => b.serviceAddress === 'root.email.service')?.binding;
  if (typeof binding !== 'object' || binding === null || Array.isArray(binding)) {
    throw new Error('expected an object input binding for root.email.service');
  }
  return binding as Record<string, unknown>;
}

const senderConsumer = () =>
  compute({ name: 'senderConsumer', deps: { email: emailSender({}) }, build });
const outboxConsumer = () =>
  compute({ name: 'outboxConsumer', deps: { outbox: rpc(emailOutboxContract) }, build });

const configPool = { EMAIL_DELIVERY_MODE: 'none', EMAIL_FROM: 'shop@example.com' };

const emailInput = () => ({
  deliveryMode: envParam('EMAIL_DELIVERY_MODE'),
  from: envParam('EMAIL_FROM'),
  deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL'),
});

function rootWithEmail() {
  return module('root', {}, ({ provision }) => {
    provision(email(), { id: 'email', input: emailInput() });
    return {};
  });
}

describe('email()', () => {
  test('Loads the db resource and the email service, wired to each other', () => {
    const graph = Load(rootWithEmail(), { configPool });
    const byId = new Map(graph.nodes.map((n) => [n.id, n.node]));
    const typeOf = (id: string): string | undefined => {
      const n = byId.get(id);
      return n !== undefined && 'type' in n ? n.type : undefined;
    };

    expect(typeOf('root.email.db')).toBe('raw-postgres');
    expect(typeOf('root.email.service')).toBe('compute');
    expect(graph.edges).toContainEqual({
      from: 'root.email.db',
      to: 'root.email.service',
      input: 'db',
      kind: 'dependency',
    });
  });

  test('the db resource is not exposed to a consumer — only send/outbox are', () => {
    const graph = Load(rootWithEmail(), { configPool });
    // No edge targets anything outside "root.email.*" from "root.email.db" directly —
    // the only consumer of the db is the service itself.
    const dbEdges = graph.edges.filter((e) => e.from === 'root.email.db');
    expect(dbEdges).toEqual([
      { from: 'root.email.db', to: 'root.email.service', input: 'db', kind: 'dependency' },
    ]);
  });

  test("the module's input reaches the service's input: envParam() fields as their values, envSecret() as its source", () => {
    const graph = Load(rootWithEmail(), { configPool });
    const binding = serviceBindingOf(graph.inputBindings);
    expect(binding['deliveryMode']).toBe('none');
    expect(binding['from']).toBe('shop@example.com');
    expect(secretName(binding['deliveryCredential'] as SecretSource, 'deliveryCredential')).toBe(
      'EMAIL_DELIVERY_CREDENTIAL',
    );
    expect(binding['deliveryUrl']).toBe('https://api.resend.com');
  });

  test("a literal binds a field, as in a service's input", () => {
    const root = module('root', {}, ({ provision }) => {
      provision(email(), { id: 'email', input: { ...emailInput(), deliveryMode: 'smtp' } });
      return {};
    });
    const graph = Load(root, { configPool });
    expect(serviceBindingOf(graph.inputBindings)['deliveryMode']).toBe('smtp');
  });

  test("the module's schema refuses a missing from before the service's does", () => {
    let message: string | undefined;
    try {
      Load(rootWithEmail(), { configPool: { EMAIL_DELIVERY_MODE: 'none' } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      'The input binding of module "root.email" does not match the module\'s input schema: from must be a string or an object (was missing)',
    );
  });

  test('opts.deliveryUrl overrides the literal deliveryUrl leaf of the input binding', () => {
    const root = module('root', {}, ({ provision }) => {
      provision(email({ deliveryUrl: 'http://localhost:8025' }), {
        id: 'email',
        input: emailInput(),
      });
      return {};
    });
    const graph = Load(root, { configPool });
    expect(serviceBindingOf(graph.inputBindings)['deliveryUrl']).toBe('http://localhost:8025');
  });

  test('the send port resolves to the service for a sender consumer', () => {
    const root = module('root', {}, ({ provision }) => {
      const mail = provision(email(), {
        id: 'email',
        input: emailInput(),
      });
      provision(senderConsumer(), { id: 'sender', deps: { email: mail.send } });
      return {};
    });

    const graph = Load(root, { configPool });
    expect(graph.edges).toContainEqual({
      from: 'root.email.service',
      to: 'root.sender',
      input: 'email',
      kind: 'dependency',
    });
  });

  test('the outbox port resolves to the service for a different consumer, independent of send', () => {
    const root = module('root', {}, ({ provision }) => {
      const mail = provision(email(), {
        id: 'email',
        input: emailInput(),
      });
      provision(senderConsumer(), { id: 'sender', deps: { email: mail.send } });
      provision(outboxConsumer(), { id: 'reader', deps: { outbox: mail.outbox } });
      return {};
    });

    const graph = Load(root, { configPool });
    expect(graph.edges).toContainEqual({
      from: 'root.email.service',
      to: 'root.sender',
      input: 'email',
      kind: 'dependency',
    });
    expect(graph.edges).toContainEqual({
      from: 'root.email.service',
      to: 'root.reader',
      input: 'outbox',
      kind: 'dependency',
    });
  });

  test('opts.name sets the declared module name, independent of the provision id', () => {
    // Deliberately distinct values: opts.name is the module's own declared
    // name; id is the graph address a provision() call picks. Using the same
    // string for both couldn't tell them apart.
    const root = module('root', {}, ({ provision }) => {
      provision(email({ name: 'mailerModule' }), {
        id: 'mailInstance',
        input: emailInput(),
      });
      return {};
    });

    const graph = Load(root, { configPool });
    const byId = new Map(graph.nodes.map((n) => [n.id, n.node]));
    // Address generation is driven by the provision id.
    expect([...byId.keys()]).toContain('root.mailInstance.service');
    expect([...byId.keys()]).toContain('root.mailInstance.db');
    // The module's own declared name/identifier is opts.name, not the id.
    const moduleNode = byId.get('root.mailInstance');
    expect(moduleNode !== undefined && 'name' in moduleNode ? moduleNode.name : undefined).toBe(
      'mailerModule',
    );
  });
});

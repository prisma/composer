/**
 * The `email()` module Loads into a wired graph: it owns a Postgres `db`
 * resource and the `email` service wired to it, forwards its boundary
 * `deliveryMode`/`from` params and `deliveryCredential` secret down to the
 * service, and its two ports (`send`, `outbox`) wire to two different
 * consumers independently. Mirrors storage's module.test.ts — this is the
 * first shipped module using boundary params (spec §"Module factory").
 */
import { describe, expect, test } from 'bun:test';
import {
  isParamSource,
  isSecretSource,
  Load,
  module,
  paramSource,
  secretSource,
} from '@internal/core';
import node from '@internal/node';
import { compute } from '@internal/prisma-cloud';
import { rpc } from '@internal/service-rpc';
import { emailOutboxContract, emailSender } from '../contract.ts';
import { email } from '../email-module.ts';

const build = node({ module: import.meta.url, entry: '../dist/x.mjs' });

/** The env var name a `paramSource`/`secretSource` binding carries — asserting the identity, not just that a slot got bound to something. */
function sourcePayload(binding: unknown): unknown {
  if (isParamSource(binding) || isSecretSource(binding)) return binding.payload;
  throw new Error('expected a ParamSource or SecretSource binding');
}

/** The email service's recorded input binding, as the plain object it is. */
function serviceBindingOf(
  inputBindings: ReadonlyArray<{ serviceAddress: string; binding: unknown }>,
): Record<string, unknown> {
  const binding = inputBindings.find((b) => b.serviceAddress === 'email.service')?.binding;
  if (typeof binding !== 'object' || binding === null || Array.isArray(binding)) {
    throw new Error('expected an object input binding for email.service');
  }
  return binding as Record<string, unknown>;
}

const senderConsumer = () =>
  compute({ name: 'senderConsumer', deps: { email: emailSender({}) }, build });
const outboxConsumer = () =>
  compute({ name: 'outboxConsumer', deps: { outbox: rpc(emailOutboxContract) }, build });

function rootWithEmail() {
  return module('root', {}, ({ provision }) => {
    provision(email(), {
      id: 'email',
      params: { deliveryMode: paramSource('EMAIL_DELIVERY_MODE'), from: paramSource('EMAIL_FROM') },
      secrets: { deliveryCredential: secretSource('EMAIL_DELIVERY_CREDENTIAL') },
    });
    return {};
  });
}

describe('email()', () => {
  test('Loads the db resource and the email service, wired to each other', () => {
    const graph = Load(rootWithEmail());
    const byId = new Map(graph.nodes.map((n) => [n.id, n.node]));
    const typeOf = (id: string): string | undefined => {
      const n = byId.get(id);
      return n !== undefined && 'type' in n ? n.type : undefined;
    };

    expect(typeOf('email.db')).toBe('postgres');
    expect(typeOf('email.service')).toBe('compute');
    expect(graph.edges).toContainEqual({
      from: 'email.db',
      to: 'email.service',
      input: 'db',
      kind: 'dependency',
    });
  });

  test('the db resource is not exposed to a consumer — only send/outbox are', () => {
    const graph = Load(rootWithEmail());
    // No edge targets anything outside "email.*" from "email.db" directly —
    // the only consumer of the db is the service itself.
    const dbEdges = graph.edges.filter((e) => e.from === 'email.db');
    expect(dbEdges).toEqual([
      { from: 'email.db', to: 'email.service', input: 'db', kind: 'dependency' },
    ]);
  });

  test("boundary params and secret forward into the service's input binding, mapped to their bound env sources (ADR-0042)", () => {
    const graph = Load(rootWithEmail());
    const binding = serviceBindingOf(graph.inputBindings);
    expect(sourcePayload(binding['deliveryMode'])).toBe('EMAIL_DELIVERY_MODE');
    expect(sourcePayload(binding['from'])).toBe('EMAIL_FROM');
    expect(sourcePayload(binding['deliveryCredential'])).toBe('EMAIL_DELIVERY_CREDENTIAL');
    expect(binding['deliveryUrl']).toBe('https://api.resend.com');
  });

  test('opts.deliveryUrl overrides the literal deliveryUrl leaf of the input binding', () => {
    const root = module('root', {}, ({ provision }) => {
      provision(email({ deliveryUrl: 'http://localhost:8025' }), {
        id: 'email',
        params: {
          deliveryMode: paramSource('EMAIL_DELIVERY_MODE'),
          from: paramSource('EMAIL_FROM'),
        },
        secrets: { deliveryCredential: secretSource('EMAIL_DELIVERY_CREDENTIAL') },
      });
      return {};
    });
    const graph = Load(root);
    expect(serviceBindingOf(graph.inputBindings)['deliveryUrl']).toBe('http://localhost:8025');
  });

  test('the send port resolves to the service for a sender consumer', () => {
    const root = module('root', {}, ({ provision }) => {
      const mail = provision(email(), {
        id: 'email',
        params: {
          deliveryMode: paramSource('EMAIL_DELIVERY_MODE'),
          from: paramSource('EMAIL_FROM'),
        },
        secrets: { deliveryCredential: secretSource('EMAIL_DELIVERY_CREDENTIAL') },
      });
      provision(senderConsumer(), { id: 'sender', deps: { email: mail.send } });
      return {};
    });

    const graph = Load(root);
    expect(graph.edges).toContainEqual({
      from: 'email.service',
      to: 'sender',
      input: 'email',
      kind: 'dependency',
    });
  });

  test('the outbox port resolves to the service for a different consumer, independent of send', () => {
    const root = module('root', {}, ({ provision }) => {
      const mail = provision(email(), {
        id: 'email',
        params: {
          deliveryMode: paramSource('EMAIL_DELIVERY_MODE'),
          from: paramSource('EMAIL_FROM'),
        },
        secrets: { deliveryCredential: secretSource('EMAIL_DELIVERY_CREDENTIAL') },
      });
      provision(senderConsumer(), { id: 'sender', deps: { email: mail.send } });
      provision(outboxConsumer(), { id: 'reader', deps: { outbox: mail.outbox } });
      return {};
    });

    const graph = Load(root);
    expect(graph.edges).toContainEqual({
      from: 'email.service',
      to: 'sender',
      input: 'email',
      kind: 'dependency',
    });
    expect(graph.edges).toContainEqual({
      from: 'email.service',
      to: 'reader',
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
        params: {
          deliveryMode: paramSource('EMAIL_DELIVERY_MODE'),
          from: paramSource('EMAIL_FROM'),
        },
        secrets: { deliveryCredential: secretSource('EMAIL_DELIVERY_CREDENTIAL') },
      });
      return {};
    });

    const graph = Load(root);
    const byId = new Map(graph.nodes.map((n) => [n.id, n.node]));
    // Address generation is driven by the provision id.
    expect([...byId.keys()]).toContain('mailInstance.service');
    expect([...byId.keys()]).toContain('mailInstance.db');
    // The module's own declared name/identifier is opts.name, not the id.
    const moduleNode = byId.get('mailInstance');
    expect(moduleNode !== undefined && 'name' in moduleNode ? moduleNode.name : undefined).toBe(
      'mailerModule',
    );
  });
});

/**
 * The `email()` module Loads into a wired graph: it owns a Postgres `db`
 * resource and the `email` service wired to it, passes its input on to the
 * service, and its two ports (`send`, `outbox`) wire to two different
 * consumers independently. Mirrors storage's module.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { type AppRootContext, appRoot, isSecretSource, Load } from '@internal/core';
import node from '@internal/node';
import { compute, variable } from '@internal/prisma-cloud';
import { rpc } from '@internal/service-rpc';
import { type } from 'arktype';
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

const configuration = { EMAIL_FROM: 'shop@example.com' };

const rootInput = type({ EMAIL_FROM: 'string' });

type RootContext = AppRootContext<typeof rootInput>;

const emailInput = ({ input, provision }: RootContext) => ({
  deliveryMode: 'none' as const,
  from: input.EMAIL_FROM,
  deliveryCredential: provision(variable.secret({ name: 'EMAIL_DELIVERY_CREDENTIAL' })),
});

const emailRoot = (body: (ctx: RootContext) => void) => appRoot('root', { input: rootInput }, body);

function rootWithEmail() {
  return emailRoot((ctx) => {
    ctx.provision(email(), { id: 'email', input: emailInput(ctx) });
  });
}

describe('email()', () => {
  test('Loads the db resource and the email service, wired to each other', () => {
    const graph = Load(rootWithEmail(), { configuration });
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
    const graph = Load(rootWithEmail(), { configuration });
    // No edge targets anything outside "root.email.*" from "root.email.db" directly —
    // the only consumer of the db is the service itself.
    const dbEdges = graph.edges.filter((e) => e.from === 'root.email.db');
    expect(dbEdges).toEqual([
      { from: 'root.email.db', to: 'root.email.service', input: 'db', kind: 'dependency' },
    ]);
  });

  test("the module's input reaches the service's input: a literal and a root input field as their values, a secret node as its source", () => {
    const graph = Load(rootWithEmail(), { configuration });
    const binding = serviceBindingOf(graph.inputBindings);
    expect(binding['deliveryMode']).toBe('none');
    expect(binding['from']).toBe('shop@example.com');
    expect(isSecretSource(binding['deliveryCredential'])).toBe(true);
    expect(graph.valueReads).toContainEqual({
      reader: 'root.email.service',
      resource: 'root.emailDeliveryCredential',
      path: 'deliveryCredential',
    });
    expect(binding['deliveryUrl']).toBe('https://api.resend.com');
  });

  test("a literal binds a field, as in a service's input", () => {
    const root = emailRoot((ctx) => {
      ctx.provision(email(), { id: 'email', input: { ...emailInput(ctx), deliveryMode: 'smtp' } });
    });
    const graph = Load(root, { configuration });
    expect(serviceBindingOf(graph.inputBindings)['deliveryMode']).toBe('smtp');
  });

  test("the module's schema refuses a missing from before the service's does", () => {
    const root = emailRoot((ctx) => {
      const withoutFrom: Partial<ReturnType<typeof emailInput>> = emailInput(ctx);
      delete withoutFrom.from;
      ctx.provision(email(), { id: 'email', input: withoutFrom as never });
    });
    let message: string | undefined;
    try {
      Load(root, { configuration });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      'The input binding of module "root.email" does not match the module\'s input schema: from must be a string or an object (was missing)',
    );
  });

  test('opts.deliveryUrl overrides the literal deliveryUrl leaf of the input binding', () => {
    const root = emailRoot((ctx) => {
      const { provision } = ctx;
      provision(email({ deliveryUrl: 'http://localhost:8025' }), {
        id: 'email',
        input: emailInput(ctx),
      });
    });
    const graph = Load(root, { configuration });
    expect(serviceBindingOf(graph.inputBindings)['deliveryUrl']).toBe('http://localhost:8025');
  });

  test('the send port resolves to the service for a sender consumer', () => {
    const root = emailRoot((ctx) => {
      const { provision } = ctx;
      const mail = provision(email(), {
        id: 'email',
        input: emailInput(ctx),
      });
      provision(senderConsumer(), { id: 'sender', deps: { email: mail.send } });
    });

    const graph = Load(root, { configuration });
    expect(graph.edges).toContainEqual({
      from: 'root.email.service',
      to: 'root.sender',
      input: 'email',
      kind: 'dependency',
    });
  });

  test('the outbox port resolves to the service for a different consumer, independent of send', () => {
    const root = emailRoot((ctx) => {
      const { provision } = ctx;
      const mail = provision(email(), {
        id: 'email',
        input: emailInput(ctx),
      });
      provision(senderConsumer(), { id: 'sender', deps: { email: mail.send } });
      provision(outboxConsumer(), { id: 'reader', deps: { outbox: mail.outbox } });
    });

    const graph = Load(root, { configuration });
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
    const root = emailRoot((ctx) => {
      const { provision } = ctx;
      provision(email({ name: 'mailerModule' }), {
        id: 'mailInstance',
        input: emailInput(ctx),
      });
    });

    const graph = Load(root, { configuration });
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

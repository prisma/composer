/**
 * `startLocalEmailServer` round-trips a real RPC call: a `makeClient` over
 * `emailSendContract` sends an email, then a `makeClient` over
 * `emailOutboxContract` reads it back by id and via `listEmails` — proving
 * the local stand-in actually serves both ports, mode `none`, no auth.
 * Also exercises `emailSender(templates)`'s hydrated client against the same
 * stand-in, proving explicit `undefined` optionals behave exactly like
 * absent ones on the wire (spec's `EmailSender` amendment, 2026-07-22).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { makeClient } from '@internal/service-rpc';
import { type } from 'arktype';
import {
  defineTemplates,
  emailOutboxContract,
  emailSendContract,
  emailSender,
} from '../contract.ts';
import { type LocalEmailServer, startLocalEmailServer } from '../execution/testing.ts';

let server: LocalEmailServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/**
 * A minimal loopback HTTP server that captures the raw RPC request body —
 * standing in for the email service so a test can inspect what actually
 * went over the wire, before any server-side normalization (`input.cc ??
 * []`, etc.) could hide a regression that starts serializing an explicit
 * `undefined` optional as `null`/`[]` instead of omitting the key.
 */
function startCaptureServer(): {
  readonly url: string;
  readonly requests: unknown[];
  stop(): void;
} {
  const requests: unknown[] = [];
  const httpServer = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push(await req.json().catch(() => undefined));
      return Response.json({ id: 'captured-id', status: 'stored' });
    },
  });
  return {
    url: `http://127.0.0.1:${httpServer.port}`,
    requests,
    stop: () => httpServer.stop(true),
  };
}

describe('startLocalEmailServer', () => {
  test('send then getEmail/listEmails round-trip over real RPC clients', async () => {
    server = await startLocalEmailServer();
    const sendClient = makeClient(emailSendContract, server.url);
    const outboxClient = makeClient(emailOutboxContract, server.url);

    const sent = await sendClient.send({
      templateId: 'welcome',
      to: ['user@example.com'],
      subject: 'Hi',
      html: '<p>hi</p>',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(sent.status).toBe('stored');

    const { email } = await outboxClient.getEmail({ id: sent.id });
    expect(email?.id).toBe(sent.id);
    expect(email?.subject).toBe('Hi');
    expect(email?.status).toBe('stored');

    const { emails } = await outboxClient.listEmails({});
    expect(emails.map((e) => e.id)).toContain(sent.id);
  });

  test('honors an explicit port', async () => {
    server = await startLocalEmailServer({ port: 0 });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('emailSender: explicit undefined optionals are omitted from the RAW wire payload, not just normalized storage', async () => {
    const capture = startCaptureServer();
    try {
      const templates = defineTemplates({
        welcome: {
          data: type({ name: 'string' }),
          render: ({ name }) => ({ subject: `Hi ${name}`, html: `<p>Hi ${name}</p>` }),
        },
      });
      const sender = await emailSender(templates).connection.hydrate({ url: capture.url });

      await sender.welcome({
        to: 'user@example.com',
        data: { name: 'Ada' },
        cc: undefined,
        bcc: undefined,
        replyTo: undefined,
        idempotencyKey: undefined,
      });

      expect(capture.requests).toHaveLength(1);
      const body = capture.requests[0];
      expect(body).not.toHaveProperty('cc');
      expect(body).not.toHaveProperty('bcc');
      expect(body).not.toHaveProperty('replyTo');
      // Omitted, but still present — emailSender mints its own key.
      expect(body).toHaveProperty('idempotencyKey');
    } finally {
      capture.stop();
    }
  });

  test("an async render's result is what lands on the wire (react-email-style templates)", async () => {
    server = await startLocalEmailServer();
    const templates = defineTemplates({
      welcome: {
        data: type({ name: 'string' }),
        render: async ({ name }) => {
          // Stands in for an async renderer (react-email's render() is
          // async) — a microtask hop proves the sender actually awaits.
          await Promise.resolve();
          return {
            subject: `Async hi ${name}`,
            html: `<p>Async hi ${name}</p>`,
            text: `Async hi ${name}`,
          };
        },
      },
    });
    const sender = await emailSender(templates).connection.hydrate({ url: server.url });

    const result = await sender.welcome({ to: 'user@example.com', data: { name: 'Ada' } });
    expect(result.status).toBe('stored');

    const outboxClient = makeClient(emailOutboxContract, server.url);
    const { email } = await outboxClient.getEmail({ id: result.id });
    expect(email?.subject).toBe('Async hi Ada');
    expect(email?.html).toBe('<p>Async hi Ada</p>');
    expect(email?.text).toBe('Async hi Ada');
  });

  test('a rejecting async render propagates to the caller — no send-op call, no outbox row', async () => {
    server = await startLocalEmailServer();
    const templates = defineTemplates({
      welcome: {
        data: type({ name: 'string' }),
        render: async () => {
          await Promise.resolve();
          throw new Error('render blew up');
        },
      },
    });
    const sender = await emailSender(templates).connection.hydrate({ url: server.url });

    await expect(sender.welcome({ to: 'user@example.com', data: { name: 'Ada' } })).rejects.toThrow(
      'render blew up',
    );

    const outboxClient = makeClient(emailOutboxContract, server.url);
    const { emails } = await outboxClient.listEmails({});
    expect(emails).toHaveLength(0);
  });
});

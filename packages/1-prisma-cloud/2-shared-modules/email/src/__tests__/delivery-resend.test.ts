/**
 * The Resend backing (spec §"Resend backing") against a local fake HTTP
 * endpoint (`Bun.serve`): headers, body shape with omit-empty-optionals,
 * the `resend <status> <name>: <message>` error format with a raw-text
 * fallback, retry classification (429/5xx retry, other 4xx and the 409
 * idempotency-conflict codes do not), and `attempts` in the result.
 *
 * `bun:test` has no fake-timer API, so the pinned 500ms/2000ms delays are
 * asserted by injecting a recording `sleep` into `withRetryPolicy` (already
 * an injection seam for this reason) rather than mocking `setTimeout` —
 * this checks the exact delay values requested, not wall-clock timing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { SecretBox } from '@internal/foundation/secret';
import { createResendDelivery } from '../delivery-resend.ts';
import type { EmailRow } from '../outbox-store.ts';

function row(overrides: Partial<EmailRow> = {}): EmailRow {
  return {
    id: crypto.randomUUID(),
    templateId: 'welcome',
    to: ['user@example.com'],
    cc: [],
    bcc: [],
    replyTo: null,
    from: 'noreply@example.com',
    subject: 'Hi',
    html: '<p>hi</p>',
    text: null,
    status: 'queued',
    providerMessageId: null,
    error: null,
    idempotencyKey: 'idem-key-1',
    attempts: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface RecordedRequest {
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

interface ScriptedResponse {
  readonly status: number;
  readonly body: unknown;
  readonly rawText?: string;
}

function startFakeResendServer(script: readonly ScriptedResponse[]) {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body: unknown = await req.json().catch(() => undefined);
      requests.push({ headers: Object.fromEntries(req.headers.entries()), body });
      const step = script[Math.min(requests.length - 1, script.length - 1)];
      if (step === undefined) throw new Error('fake resend server: script exhausted');
      if (step.rawText !== undefined) {
        return new Response(step.rawText, { status: step.status });
      }
      return new Response(JSON.stringify(step.body), {
        status: step.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

function fakeSleep(): { readonly delays: number[]; readonly sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

let activeServer: { stop: () => void } | undefined;
afterEach(() => {
  activeServer?.stop();
  activeServer = undefined;
});

describe('request shape', () => {
  test('headers: Bearer auth, JSON content-type, Idempotency-Key from the row', async () => {
    const server = startFakeResendServer([{ status: 200, body: { id: 'email_1' } }]);
    activeServer = server;
    const delivery = createResendDelivery({
      deliveryUrl: server.url,
      credential: new SecretBox('resend-token'),
    });
    await delivery.deliver(row({ idempotencyKey: 'my-idem-key' }));

    const request = server.requests[0];
    expect(request?.headers['authorization']).toBe('Bearer resend-token');
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.headers['idempotency-key']).toBe('my-idem-key');
  });

  test('body includes cc/bcc/reply_to/text only when present', async () => {
    const server = startFakeResendServer([{ status: 200, body: { id: 'email_1' } }]);
    activeServer = server;
    const delivery = createResendDelivery({
      deliveryUrl: server.url,
      credential: new SecretBox('t'),
    });
    await delivery.deliver(
      row({
        cc: ['cc@example.com'],
        bcc: ['bcc@example.com'],
        replyTo: 'reply@example.com',
        text: 'plain text body',
      }),
    );

    expect(server.requests[0]?.body).toEqual({
      from: 'noreply@example.com',
      to: ['user@example.com'],
      subject: 'Hi',
      html: '<p>hi</p>',
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      reply_to: 'reply@example.com',
      text: 'plain text body',
    });
  });

  test('omits cc/bcc/reply_to/text entirely — never sends [] or null', async () => {
    const server = startFakeResendServer([{ status: 200, body: { id: 'email_1' } }]);
    activeServer = server;
    const delivery = createResendDelivery({
      deliveryUrl: server.url,
      credential: new SecretBox('t'),
    });
    await delivery.deliver(row());

    const body = server.requests[0]?.body;
    expect(body).toEqual({
      from: 'noreply@example.com',
      to: ['user@example.com'],
      subject: 'Hi',
      html: '<p>hi</p>',
    });
    expect(body).not.toHaveProperty('cc');
    expect(body).not.toHaveProperty('bcc');
    expect(body).not.toHaveProperty('reply_to');
    expect(body).not.toHaveProperty('text');
  });
});

describe('success', () => {
  test('2xx: providerMessageId comes from body.id, attempts is 1', async () => {
    const server = startFakeResendServer([{ status: 200, body: { id: 'email_abc' } }]);
    activeServer = server;
    const delivery = createResendDelivery({
      deliveryUrl: server.url,
      credential: new SecretBox('t'),
    });
    const result = await delivery.deliver(row());
    expect(result).toEqual({ ok: true, providerMessageId: 'email_abc', attempts: 1 });
  });
});

describe('error string format', () => {
  test('parses the Resend error body: "resend <status> <name>: <message>"', async () => {
    const server = startFakeResendServer([
      {
        status: 403,
        body: { statusCode: 403, name: 'validation_error', message: 'invalid from address' },
      },
    ]);
    activeServer = server;
    const delivery = createResendDelivery({
      deliveryUrl: server.url,
      credential: new SecretBox('t'),
    });
    const result = await delivery.deliver(row());
    expect(result).toEqual({
      ok: false,
      error: 'resend 403 validation_error: invalid from address',
      attempts: 1,
    });
  });

  test('falls back to the raw response text when the body does not parse as Resend error shape', async () => {
    const server = startFakeResendServer([{ status: 403, rawText: 'not json', body: undefined }]);
    activeServer = server;
    const delivery = createResendDelivery({
      deliveryUrl: server.url,
      credential: new SecretBox('t'),
    });
    const result = await delivery.deliver(row());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('resend 403: not json');
  });
});

describe('retry classification', () => {
  test('429 retries, then succeeds — one 500ms delay recorded', async () => {
    const server = startFakeResendServer([
      { status: 429, body: { statusCode: 429, name: 'rate_limit_exceeded', message: 'slow down' } },
      { status: 200, body: { id: 'email_after_retry' } },
    ]);
    activeServer = server;
    const { delays, sleep } = fakeSleep();
    const delivery = createResendDelivery({
      deliveryUrl: server.url,
      credential: new SecretBox('t'),
      retryPolicy: { sleep },
    });
    const result = await delivery.deliver(row());
    expect(result).toEqual({ ok: true, providerMessageId: 'email_after_retry', attempts: 2 });
    expect(delays).toEqual([500]);
  });

  test('5xx exhausts all 3 attempts with the pinned 500ms/2000ms delays', async () => {
    const server = startFakeResendServer([
      { status: 500, body: { statusCode: 500, name: 'internal_server_error', message: 'boom 1' } },
      { status: 502, body: { statusCode: 502, name: 'bad_gateway', message: 'boom 2' } },
      { status: 503, body: { statusCode: 503, name: 'service_unavailable', message: 'boom 3' } },
    ]);
    activeServer = server;
    const { delays, sleep } = fakeSleep();
    const delivery = createResendDelivery({
      deliveryUrl: server.url,
      credential: new SecretBox('t'),
      retryPolicy: { sleep },
    });
    const result = await delivery.deliver(row());
    expect(result).toEqual({
      ok: false,
      error: 'resend 503 service_unavailable: boom 3',
      attempts: 3,
    });
    expect(delays).toEqual([500, 2000]);
  });

  test('a non-429 4xx fails immediately — no retry, no delay', async () => {
    const server = startFakeResendServer([
      { status: 401, body: { statusCode: 401, name: 'unauthorized', message: 'bad key' } },
    ]);
    activeServer = server;
    const { delays, sleep } = fakeSleep();
    const delivery = createResendDelivery({
      deliveryUrl: server.url,
      credential: new SecretBox('t'),
      retryPolicy: { sleep },
    });
    const result = await delivery.deliver(row());
    expect(result.attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  test('409 idempotency conflicts fail immediately with the surfaced error, not masked', async () => {
    const server = startFakeResendServer([
      {
        status: 409,
        body: {
          statusCode: 409,
          name: 'invalid_idempotent_request',
          message: 'idempotency key reused with a different payload',
        },
      },
    ]);
    activeServer = server;
    const delivery = createResendDelivery({
      deliveryUrl: server.url,
      credential: new SecretBox('t'),
    });
    const result = await delivery.deliver(row());
    expect(result).toEqual({
      ok: false,
      error:
        'resend 409 invalid_idempotent_request: idempotency key reused with a different payload',
      attempts: 1,
    });
  });

  test('a network error (nothing listening) retries like any thrown error, up to the max', async () => {
    const { delays, sleep } = fakeSleep();
    const delivery = createResendDelivery({
      // Port 0 never has a listener at request time — connection refused.
      deliveryUrl: 'http://127.0.0.1:1',
      credential: new SecretBox('t'),
      retryPolicy: { sleep },
    });
    const result = await delivery.deliver(row());
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(delays).toEqual([500, 2000]);
  });
});

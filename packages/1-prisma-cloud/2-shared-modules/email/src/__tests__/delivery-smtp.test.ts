/**
 * The SMTP backing (spec §"SMTP backing"): URL→transport option mapping
 * (host/port/secure/user), the row→`sendMail` field mapping, `messageId ??
 * null`, and the retry classification (421/450/451/452 retryable, other
 * codes and connection failures per `delivery.ts`'s policy) — against the
 * loopback fake server in `fake-smtp-server.ts`, never a live relay.
 */
import { describe, expect, test } from 'bun:test';
import { SecretBox } from '@internal/foundation/secret';
import { createSmtpDelivery, toMailOptions, transportOptionsFrom } from '../delivery-smtp.ts';
import type { EmailRow } from '../outbox-store.ts';
import { startFakeSmtpServer } from './fake-smtp-server.ts';

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
    idempotencyKey: crypto.randomUUID(),
    attempts: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('transportOptionsFrom', () => {
  test('smtp:// maps to secure: false and the default port 587 when unset', () => {
    const opts = transportOptionsFrom('smtp://mail.example.com', new SecretBox('pw'));
    expect(opts.host).toBe('mail.example.com');
    expect(opts.port).toBe(587);
    expect(opts.secure).toBe(false);
    expect(opts.auth).toBeUndefined();
  });

  test('smtps:// maps to secure: true and the default port 465 when unset', () => {
    const opts = transportOptionsFrom('smtps://mail.example.com', new SecretBox('pw'));
    expect(opts.secure).toBe(true);
    expect(opts.port).toBe(465);
  });

  test('an explicit port in the URL overrides the scheme default', () => {
    const opts = transportOptionsFrom('smtp://mail.example.com:2525', new SecretBox('pw'));
    expect(opts.port).toBe(2525);
  });

  test('userinfo becomes the auth username; password always comes from the credential', () => {
    const opts = transportOptionsFrom(
      'smtp://relay-user@mail.example.com',
      new SecretBox('secret-pw'),
    );
    expect(opts.auth).toEqual({ user: 'relay-user', pass: 'secret-pw' });
  });

  test('no userinfo means no auth block at all', () => {
    const opts = transportOptionsFrom('smtp://mail.example.com', new SecretBox('pw'));
    expect(opts.auth).toBeUndefined();
  });
});

describe('toMailOptions', () => {
  test('maps the row fields, omitting null replyTo/text rather than sending null', () => {
    const options = toMailOptions(row());
    expect(options).toEqual({
      from: 'noreply@example.com',
      to: ['user@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hi',
      html: '<p>hi</p>',
    });
    expect(options).not.toHaveProperty('replyTo');
    expect(options).not.toHaveProperty('text');
  });

  test('includes replyTo and text when present', () => {
    const options = toMailOptions(row({ replyTo: 'reply@example.com', text: 'hi there' }));
    expect(options.replyTo).toBe('reply@example.com');
    expect(options.text).toBe('hi there');
  });
});

// A no-op sleep skips the policy's real 500ms/2000ms retry delays — those
// exact delays are pinned and tested with fake timers in
// delivery-resend.test.ts; this file only needs the retry *count* to be right.
const NO_DELAY = { sleep: async () => {} };

describe('createSmtpDelivery', () => {
  test('accept: providerMessageId comes from info.messageId', async () => {
    const server = await startFakeSmtpServer({ kind: 'accept', messageId: 'msg-123' });
    try {
      const delivery = createSmtpDelivery({
        deliveryUrl: `smtp://127.0.0.1:${server.port}`,
        credential: new SecretBox('unused'),
        retryPolicy: NO_DELAY,
      });
      const result = await delivery.deliver(row());
      expect(result.ok).toBe(true);
      if (result.ok) {
        // nodemailer computes messageId client-side from its own Message-ID
        // header, independent of the server's "queued as ..." response text.
        expect(typeof result.providerMessageId).toBe('string');
        expect(result.attempts).toBe(1);
      }
    } finally {
      await server.stop();
    }
  });

  test('a permanent rejection (550) fails immediately, no retry', async () => {
    const server = await startFakeSmtpServer({
      kind: 'reject',
      code: 550,
      message: 'mailbox unavailable',
    });
    try {
      const delivery = createSmtpDelivery({
        deliveryUrl: `smtp://127.0.0.1:${server.port}`,
        credential: new SecretBox('unused'),
        retryPolicy: NO_DELAY,
      });
      const result = await delivery.deliver(row());
      expect(result.ok).toBe(false);
      expect(result.attempts).toBe(1);
      if (!result.ok) {
        expect(result.error).toContain('550');
        expect(result.error).toContain('mailbox unavailable');
      }
    } finally {
      await server.stop();
    }
  });

  test('a temporary rejection (452) is retried up to the policy max, then reported', async () => {
    const server = await startFakeSmtpServer({ kind: 'reject', code: 452, message: 'try again' });
    try {
      const delivery = createSmtpDelivery({
        deliveryUrl: `smtp://127.0.0.1:${server.port}`,
        credential: new SecretBox('unused'),
        retryPolicy: NO_DELAY,
      });
      const result = await delivery.deliver(row());
      expect(result.ok).toBe(false);
      expect(result.attempts).toBe(3);
    } finally {
      await server.stop();
    }
  });

  for (const code of [421, 450, 451, 452]) {
    test(`response code ${code} is classified retryable`, async () => {
      const server = await startFakeSmtpServer({ kind: 'reject', code, message: 'temporary' });
      try {
        const delivery = createSmtpDelivery({
          deliveryUrl: `smtp://127.0.0.1:${server.port}`,
          credential: new SecretBox('unused'),
          retryPolicy: NO_DELAY,
        });
        const result = await delivery.deliver(row());
        // Retried at least once means more than one attempt was made.
        expect(result.attempts).toBeGreaterThan(1);
      } finally {
        await server.stop();
      }
    });
  }

  test('a connection failure (refused) is retried like any thrown error', async () => {
    const server = await startFakeSmtpServer({ kind: 'refuse' });
    try {
      const delivery = createSmtpDelivery({
        deliveryUrl: `smtp://127.0.0.1:${server.port}`,
        credential: new SecretBox('unused'),
        retryPolicy: NO_DELAY,
      });
      const result = await delivery.deliver(row());
      expect(result.ok).toBe(false);
      expect(result.attempts).toBe(3);
    } finally {
      await server.stop();
    }
  });
});

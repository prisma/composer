/**
 * Schema bounds on the wire contracts: `to` 1–50 entries, `idempotencyKey`
 * 1–256 chars, `listEmails.limit` an integer 1–200, and the `status` enum.
 *
 * `rpc({ input, output })` (`@internal/service-rpc`) returns the `{ input,
 * output }` pair unchanged at runtime — its declared function-shaped return
 * type is a type-level lie for contract() to build on (see
 * service-rpc/src/rpc.ts and its own contract.test.ts). Reaching through
 * `__cmp.<method>.input`/`.output` to get the raw arktype `Type`s is the
 * established way to test a contract's schemas directly.
 */
import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { emailOutboxContract, emailSendContract } from '../contract.ts';

interface RpcMethodSchemas {
  readonly input: (value: unknown) => unknown;
  readonly output: (value: unknown) => unknown;
}

const sendMethod = emailSendContract.__cmp.send as unknown as RpcMethodSchemas;
const getEmailMethod = emailOutboxContract.__cmp.getEmail as unknown as RpcMethodSchemas;
const listEmailsMethod = emailOutboxContract.__cmp.listEmails as unknown as RpcMethodSchemas;

function isRejected(result: unknown): boolean {
  return result instanceof type.errors;
}

function validSend(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    templateId: 'welcome',
    to: ['user@example.com'],
    subject: 'Hi',
    html: '<p>hi</p>',
    idempotencyKey: 'k',
    ...overrides,
  };
}

describe('sendInput', () => {
  test('accepts a minimal valid send', () => {
    expect(isRejected(sendMethod.input(validSend()))).toBe(false);
  });

  test('"to" rejects an empty array', () => {
    expect(isRejected(sendMethod.input(validSend({ to: [] })))).toBe(true);
  });

  test('"to" accepts exactly 50 entries', () => {
    const to = Array.from({ length: 50 }, (_, i) => `user${i}@example.com`);
    expect(isRejected(sendMethod.input(validSend({ to })))).toBe(false);
  });

  test('"to" rejects 51 entries', () => {
    const to = Array.from({ length: 51 }, (_, i) => `user${i}@example.com`);
    expect(isRejected(sendMethod.input(validSend({ to })))).toBe(true);
  });

  test('idempotencyKey rejects an empty string', () => {
    expect(isRejected(sendMethod.input(validSend({ idempotencyKey: '' })))).toBe(true);
  });

  test('idempotencyKey accepts exactly 256 chars', () => {
    expect(isRejected(sendMethod.input(validSend({ idempotencyKey: 'x'.repeat(256) })))).toBe(
      false,
    );
  });

  test('idempotencyKey rejects 257 chars', () => {
    expect(isRejected(sendMethod.input(validSend({ idempotencyKey: 'x'.repeat(257) })))).toBe(true);
  });

  test('accepts optional cc/bcc/replyTo/text when present', () => {
    expect(
      isRejected(
        sendMethod.input(
          validSend({
            cc: ['a@example.com'],
            bcc: ['b@example.com'],
            replyTo: 'r@example.com',
            text: 'hi',
          }),
        ),
      ),
    ).toBe(false);
  });

  test('rejects a missing required field', () => {
    const { subject: _subject, ...rest } = validSend();
    expect(isRejected(sendMethod.input(rest))).toBe(true);
  });
});

describe('sendResult', () => {
  test('accepts each status value', () => {
    for (const status of ['stored', 'queued', 'sent', 'failed']) {
      expect(isRejected(sendMethod.output({ id: 'x', status }))).toBe(false);
    }
  });

  test('rejects an unknown status', () => {
    expect(isRejected(sendMethod.output({ id: 'x', status: 'bogus' }))).toBe(true);
  });

  test('accepts an optional error message', () => {
    expect(isRejected(sendMethod.output({ id: 'x', status: 'failed', error: 'boom' }))).toBe(false);
  });
});

describe('getEmail', () => {
  test('accepts an id input', () => {
    expect(isRejected(getEmailMethod.input({ id: 'x' }))).toBe(false);
  });

  test('output accepts a null email', () => {
    expect(isRejected(getEmailMethod.output({ email: null }))).toBe(false);
  });

  test('output accepts a full email record', () => {
    const email = {
      id: 'x',
      templateId: 'welcome',
      to: ['a@example.com'],
      cc: [],
      bcc: [],
      replyTo: null,
      from: 'noreply@example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
      text: null,
      status: 'stored',
      providerMessageId: null,
      error: null,
      attempts: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(isRejected(getEmailMethod.output({ email }))).toBe(false);
  });
});

describe('listEmails', () => {
  test('accepts an empty input (all filters optional)', () => {
    expect(isRejected(listEmailsMethod.input({}))).toBe(false);
  });

  test('accepts limit 1 and limit 200', () => {
    expect(isRejected(listEmailsMethod.input({ limit: 1 }))).toBe(false);
    expect(isRejected(listEmailsMethod.input({ limit: 200 }))).toBe(false);
  });

  test('rejects limit 0 and limit 201', () => {
    expect(isRejected(listEmailsMethod.input({ limit: 0 }))).toBe(true);
    expect(isRejected(listEmailsMethod.input({ limit: 201 }))).toBe(true);
  });

  test('rejects a non-integer limit', () => {
    expect(isRejected(listEmailsMethod.input({ limit: 1.5 }))).toBe(true);
  });

  test('rejects an unknown status filter', () => {
    expect(isRejected(listEmailsMethod.input({ status: 'bogus' }))).toBe(true);
  });

  test('accepts to/templateId/status/cursor filters together', () => {
    expect(
      isRejected(
        listEmailsMethod.input({
          to: 'a@example.com',
          templateId: 'welcome',
          status: 'sent',
          cursor: 'abc',
          limit: 10,
        }),
      ),
    ).toBe(false);
  });

  test('output requires "emails" and allows an absent nextCursor', () => {
    expect(isRejected(listEmailsMethod.output({ emails: [] }))).toBe(false);
  });
});

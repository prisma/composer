import { describe, expect, test } from 'bun:test';
import { CliStructuredError } from '@internal/foundation/errors';
import type { DeploymentSummary } from '../deployment-summary.ts';
import type { DevEvent } from '../operations/dev.ts';
import {
  credentialNamedValuesIn,
  KnownSecrets,
  redactDevEvent,
  redactError,
  redactingTransform,
  redactSummary,
  StreamRedactor,
  valuesUnderSecretsKeys,
} from '../redaction.ts';

const knowing = (...values: string[]): KnownSecrets => {
  const known = new KnownSecrets();
  known.add(values);
  return known;
};

async function throughTransform(chunks: readonly string[], values: readonly string[]) {
  const source = new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let text = '';
  const reader = source.pipeThrough(redactingTransform(values)).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += value;
  }
}

describe('KnownSecrets', () => {
  test('KnownSecrets redacts a known value at any length, longest first', () => {
    expect(knowing('a', 'abc').redact('xabcx a')).toBe('x[redacted]x [redacted]');
  });

  test('KnownSecrets skips empty values', () => {
    expect(knowing('').values()).toEqual([]);
  });
});

describe('the values a command learns are secrets', () => {
  test('valuesUnderSecretsKeys takes the value under each secrets key from both, at any length', () => {
    const values = valuesUnderSecretsKeys(
      { STRIPE_KEY: 'sk_live_123456', WEBHOOK: 'w', N: 4 },
      { WEBHOOK: 'w2' },
      ['WEBHOOK'],
    );

    expect(values.sort()).toEqual(['w', 'w2']);
  });

  test('credentialNamedValuesIn takes credential-looking app configuration values of eight characters or more', () => {
    expect(
      credentialNamedValuesIn({ STRIPE_KEY: 'sk_live_123456', API_TOKEN: 'short', N: 4 }),
    ).toEqual(['sk_live_123456']);
  });

  test('a value added by name is redacted but is not a certain secret', () => {
    const known = new KnownSecrets();
    known.addByName(['looks-like-a-credential']);
    known.add(['under-a-secrets-key']);

    expect(known.redact('looks-like-a-credential')).toBe('[redacted]');
    expect([...known.certainValues()]).toEqual(['under-a-secrets-key']);
  });
});

describe('redacting what a command returns', () => {
  test('redactError removes known values from the summary, why, fix and meta, and keeps the code, severity and where', () => {
    const error = new CliStructuredError('CONFIG.ADAPTER_FAILED', 'summary hunter2', {
      severity: 'warn',
      why: 'why hunter2',
      fix: 'fix hunter2',
      where: { path: '/app/prisma.config.ts', line: 3 },
      meta: { nested: { list: ['hunter2 inside'] }, count: 2 },
      cause: new Error('cause hunter2'),
    });

    const redacted = redactError(error, knowing('hunter2'));

    expect(JSON.stringify(redacted.toEnvelope())).not.toContain('hunter2');
    expect(redacted.code).toBe(error.code);
    expect(redacted.severity).toBe(error.severity);
    expect(redacted.where).toEqual(error.where);
    expect(redacted.meta).toEqual({ nested: { list: ['[redacted] inside'] }, count: 2 });
    expect(redacted.cause).toBeUndefined();
  });

  test('redactDevEvent redacts messages and dev server output, and leaves other events as they are', () => {
    const known = knowing('hunter2');
    const events: DevEvent[] = [
      { kind: 'target-warning', message: 'warn hunter2' },
      { kind: 'rebuild-failed', message: 'failed hunter2' },
      { kind: 'watch-error', message: 'watch hunter2' },
      { kind: 'stop-error', message: 'stop hunter2' },
      { kind: 'dev-server-output', address: 'shop.web', line: 'line hunter2' },
    ];
    const untouched: DevEvent = { kind: 'unwatchable', address: 'hunter2' };

    expect(events.map((event) => redactDevEvent(event, known))).toEqual([
      { kind: 'target-warning', message: 'warn [redacted]' },
      { kind: 'rebuild-failed', message: 'failed [redacted]' },
      { kind: 'watch-error', message: 'watch [redacted]' },
      { kind: 'stop-error', message: 'stop [redacted]' },
      { kind: 'dev-server-output', address: 'shop.web', line: 'line [redacted]' },
    ]);
    expect(redactDevEvent(untouched, known)).toBe(untouched);
  });

  test('redactSummary redacts entity ids, urls and details', () => {
    const summary: DeploymentSummary = {
      app: 'shop',
      nodes: [
        {
          address: 'shop.web',
          entities: [
            {
              kind: 'compute-service',
              id: 'id-hunter2',
              url: 'https://hunter2.example',
              details: { note: 'note hunter2' },
            },
            { kind: 'compute-service', id: 'plain' },
          ],
        },
      ],
    };

    expect(redactSummary(summary, knowing('hunter2'))).toEqual({
      app: 'shop',
      nodes: [
        {
          address: 'shop.web',
          entities: [
            {
              kind: 'compute-service',
              id: 'id-[redacted]',
              url: 'https://[redacted].example',
              details: { note: 'note [redacted]' },
            },
            { kind: 'compute-service', id: 'plain' },
          ],
        },
      ],
    });
    expect(redactSummary(undefined, knowing('hunter2'))).toBeUndefined();
  });
});

describe('redacting a stream', () => {
  test('redactingTransform redacts a secret split across two chunks', async () => {
    expect(await throughTransform(['token is s3cr3t-', 'value, done\n'], ['s3cr3t-value'])).toBe(
      'token is [redacted], done\n',
    );
  });

  test('redactingTransform redacts every occurrence at every chunk size', async () => {
    const parts: string[] = [];
    for (let index = 0; index < 2000; index++) {
      if (index % 7 === 0) parts.push('SECRETXYZ');
      else if (index % 50 === 0) parts.push('abc\n');
      else parts.push('abc');
    }
    const text = parts.join('');
    const expected = text.replaceAll('SECRETXYZ', '[redacted]');

    for (const size of [1, 2, 3, 5, 8, 9, 10, 64]) {
      const chunks: string[] = [];
      for (let start = 0; start < text.length; start += size) {
        chunks.push(text.slice(start, start + size));
      }
      expect(await throughTransform(chunks, ['SECRETXYZ', 'SECRET'])).toBe(expected);
    }
  });

  test('StreamRedactor holds back only the end of the text that could start a secret, and end returns the rest', () => {
    const redactor = new StreamRedactor(['abcdef']);

    expect(redactor.push('0123456789')).toBe('0123456789');
    expect(redactor.push('0123abc')).toBe('0123');
    expect(redactor.end()).toBe('abc');
  });

  test('StreamRedactor returns text that cannot start a secret at once, holds a line break secret whole, and with no secret returns each chunk as it comes', () => {
    expect(new StreamRedactor(['abcdef']).push('Creating web\n')).toBe('Creating web\n');

    const multiline = new StreamRedactor(['line1\nline2']);
    expect(multiline.push('x line1\n') + multiline.push('line2 y\n') + multiline.end()).toBe(
      'x [redacted] y\n',
    );

    expect(new StreamRedactor([]).push('abc')).toBe('abc');
  });

  test('StreamRedactor returns a prompt without a line break at once', () => {
    const redactor = new StreamRedactor(['hunter2-secret']);

    expect(redactor.push('Deploy to production? (y/N) ')).toBe('Deploy to production? (y/N) ');
    expect(redactor.end()).toBe('');
  });

  test('StreamRedactor never splits a surrogate pair across two pieces', () => {
    const emoji = '\u{1F680}';
    const redactor = new StreamRedactor([`${emoji}X`]);

    const first = redactor.push(`launch ${emoji}`.slice(0, -1));
    const second = redactor.push(`${emoji.slice(-1)} done`);
    const rest = redactor.end();

    for (const piece of [first, second, rest]) {
      expect(piece).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(piece).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
    expect(first + second + rest).toBe(`launch ${emoji} done`);
  });
});

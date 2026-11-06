import { describe, expect, test } from 'bun:test';
import { CliStructuredError } from '@internal/foundation/errors';
import type { DeploymentSummary } from '../deployment-summary.ts';
import type { DevEvent } from '../operations/dev.ts';
import {
  credentialLookingValues,
  KnownSecrets,
  redactDevEvent,
  redactError,
  redactSummary,
  redactThrown,
  redactValues,
  SecretRedaction,
  StreamRedactor,
  valuesUnderSecretsKeys,
} from '../redaction.ts';

const knowing = (...values: string[]): SecretRedaction => {
  const redaction = new SecretRedaction({});
  redaction.addKnownSecrets(values.map((value) => ({ name: 'S', value })));
  return redaction;
};

function throughRedactor(chunks: readonly string[], values: readonly string[]): string {
  const redactor = new StreamRedactor(values);
  return chunks.map((chunk) => redactor.push(chunk)).join('') + redactor.end();
}

describe('SecretRedaction', () => {
  test('SecretRedaction redacts a known secret at any length, longest first', () => {
    expect(knowing('a', 'abc').redact('xabcx a')).toBe('x[redacted]x [redacted]');
  });

  test('SecretRedaction skips empty values', () => {
    expect(knowing('').allValues()).toEqual([]);
  });

  test('SecretRedaction hides overlapping secrets whole', () => {
    expect(knowing('abc', 'bcdef').redact('xxabcdefyy')).toBe('xx[redacted]yy');
    expect(redactValues('xxabcdefyy', ['abc', 'bcdef'])).toBe('xx[redacted]yy');
  });

  test('SecretRedaction starts with the credential-looking values of the environment it is given, so every output hides the same set', () => {
    const redaction = new SecretRedaction({
      SHELL_API_TOKEN: 'from-the-shell-123',
      HOME: '/home/someone',
    });

    expect(redaction.allValues()).toEqual(['from-the-shell-123']);
    expect(redaction.redact('t=from-the-shell-123')).toBe('t=[redacted]');
    expect(redaction.knownSecrets.values().size).toBe(0);
  });

  test('SecretRedaction keeps the <value> placeholder in a command that sets a variable whose name contains SECRET', () => {
    // Built by setCommands in packages/1-prisma-cloud/1-extensions/target/src/preflight.ts.
    const command =
      "prisma project env add 'AUTH_SIGNING_SECRET=<value>' --project 'proj_1' --role production";

    expect(new SecretRedaction({}).redact(command)).toBe(command);
    expect(new SecretRedaction({}).redact('AUTH_SIGNING_SECRET=sk_live_abc')).toBe(
      'AUTH_SIGNING_SECRET=[redacted]',
    );
  });

  test('SecretRedaction redacts a real value that only starts with the placeholder', () => {
    for (const text of ['SECRET=<value>abc123', 'SECRET=<value>-real', 'password=<value>s3cret']) {
      expect(new SecretRedaction({}).redact(text)).not.toContain('<value>');
    }
  });

  test('SecretRedaction hides a value added after it first redacted', () => {
    const redaction = knowing('first-secret');
    expect(redaction.redact('first-secret later-secret')).toBe('[redacted] later-secret');

    redaction.addKnownSecrets([{ name: 'LATER', value: 'later-secret' }]);

    expect(redaction.redact('first-secret later-secret')).toBe('[redacted] [redacted]');
  });
});

describe('redactThrown', () => {
  test('redactThrown redacts the message and stack of a thrown error and of each error in its cause chain and aggregate', () => {
    const inner = new Error('inner s3cr3t-value');
    const member = new Error('member s3cr3t-value');
    const outer = new Error('outer s3cr3t-value', {
      cause: new AggregateError([member], 'aggregate s3cr3t-value', { cause: inner }),
    });

    redactThrown(outer, knowing('s3cr3t-value'));

    const aggregate = outer.cause as AggregateError;
    for (const error of [outer, aggregate, inner, member]) {
      expect(error.message).not.toContain('s3cr3t-value');
      expect(error.stack ?? '').not.toContain('s3cr3t-value');
    }
  });

  test('redactThrown redacts a DOMException, whose message has no setter, in place', () => {
    for (const name of ['AbortError', 'TimeoutError']) {
      const error = new DOMException('failed with s3cr3t-value', name);

      const thrown = redactThrown(error, knowing('s3cr3t-value'));

      expect(thrown).toBe(error);
      expect(thrown.message).toBe('failed with [redacted]');
      expect(thrown.stack ?? '').not.toContain('s3cr3t-value');
    }
  });

  test('redactThrown replaces a frozen error with a new one that carries the redacted message, stack and cause chain', () => {
    const cause = Object.freeze(new Error('cause s3cr3t-value'));
    const error = Object.freeze(new TypeError('outer s3cr3t-value', { cause }));

    const thrown = redactThrown(error, knowing('s3cr3t-value'));

    expect(thrown).not.toBe(error);
    expect(thrown.name).toBe('TypeError');
    expect(thrown.message).toBe('outer [redacted]');
    expect(thrown.stack ?? '').not.toContain('s3cr3t-value');
    expect(thrown.stack ?? '').toContain('outer [redacted]');
    const thrownCause = thrown.cause as Error;
    expect(thrownCause.message).toBe('cause [redacted]');
    expect(thrownCause.stack ?? '').not.toContain('s3cr3t-value');
  });

  test('redactThrown keeps an error whose cause is a frozen error, and points it at the redacted copy', () => {
    const error = new Error('outer', { cause: Object.freeze(new Error('cause s3cr3t-value')) });

    const thrown = redactThrown(error, knowing('s3cr3t-value'));

    expect(thrown).toBe(error);
    expect((thrown.cause as Error).message).toBe('cause [redacted]');
  });

  test('redactThrown replaces a cause that is text or plain data with a redacted copy', () => {
    const text = new Error('x', { cause: 'cause s3cr3t-value' });
    const data = new Error('x', { cause: { detail: ['s3cr3t-value'] } });

    redactThrown(text, knowing('s3cr3t-value'));
    redactThrown(data, knowing('s3cr3t-value'));

    expect(text.cause).toBe('cause [redacted]');
    expect(data.cause).toEqual({ detail: ['[redacted]'] });
  });
});

describe('redactThrown never throws', () => {
  test('a thrown string, number or plain object becomes an Error whose message is its redacted text', () => {
    const redaction = knowing('s3cr3t-value');

    expect(redactThrown('failed with s3cr3t-value', redaction).message).toBe(
      'failed with [redacted]',
    );
    expect(redactThrown(42, knowing('42')).message).toBe('[redacted]');
    const fromObject = redactThrown({ detail: 's3cr3t-value' }, redaction);
    expect(fromObject).toBeInstanceOf(Error);
    expect(fromObject.message).not.toContain('s3cr3t-value');
  });

  test('a message that is not text is redacted as text', () => {
    const error = new Error('x');
    Object.defineProperty(error, 'message', { value: { toString: () => 'about s3cr3t-value' } });

    expect(redactThrown(error, knowing('s3cr3t-value')).message).toBe('about [redacted]');
  });

  test.each(['message', 'cause', 'stack'])(
    'a %s getter that throws gives a new Error holding no secret',
    (property) => {
      const error = new Error('failed with s3cr3t-value');
      Object.defineProperty(error, property, {
        get: () => {
          throw new Error('getter broke on s3cr3t-value');
        },
      });

      const thrown = redactThrown(error, knowing('s3cr3t-value'));

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.message).not.toContain('s3cr3t-value');
      expect(thrown.stack ?? '').not.toContain('s3cr3t-value');
    },
  );

  test('a revoked proxy as the cause or as the thrown value gives a new Error holding no secret', () => {
    const { proxy, revoke } = Proxy.revocable(new Error('cause s3cr3t-value'), {});
    revoke();
    const error = new Error('failed with s3cr3t-value', { cause: proxy });

    const fromCause = redactThrown(error, knowing('s3cr3t-value'));
    const fromProxy = redactThrown(proxy, knowing('s3cr3t-value'));

    expect(fromCause.message).not.toContain('s3cr3t-value');
    expect(fromProxy.message).toBe('A value was thrown that cannot be turned into text.');
  });
});

describe('the values a command learns are secrets', () => {
  test('valuesUnderSecretsKeys takes the value under each secrets key from both, at any length', () => {
    const values = valuesUnderSecretsKeys(
      { STRIPE_KEY: 'sk_live_123456', WEBHOOK: 'w', N: 4 },
      { WEBHOOK: 'w2' },
      ['WEBHOOK'],
    );

    expect(values).toEqual([
      { name: 'WEBHOOK', value: 'w' },
      { name: 'WEBHOOK', value: 'w2' },
    ]);
  });

  test('a shell value in the app secrets that no secrets key names is not redacted', () => {
    const redaction = new SecretRedaction({});
    redaction.addKnownSecrets(
      valuesUnderSecretsKeys({}, { SHLVL: '1', EMAIL_DELIVERY_CREDENTIAL: 'sk_test_abc123' }, [
        'EMAIL_DELIVERY_CREDENTIAL',
      ]),
    );

    expect(redaction.redact('SHLVL=1 key=sk_test_abc123')).toBe('SHLVL=1 key=[redacted]');
  });

  test('credentialLookingValues takes text of eight characters or more under credential-looking names', () => {
    expect(
      credentialLookingValues({ STRIPE_KEY: 'sk_live_123456', API_TOKEN: 'short', N: 4 }),
    ).toEqual(['sk_live_123456']);
  });

  test('a credential-looking value is redacted but is not a known secret', () => {
    const redaction = new SecretRedaction({});
    redaction.addCredentialLookingValues(['looks-like-a-credential']);
    redaction.addKnownSecrets([{ name: 'S', value: 'under-a-secrets-key' }]);

    expect(redaction.redact('looks-like-a-credential')).toBe('[redacted]');
    expect([...redaction.knownSecrets.values()]).toEqual(['under-a-secrets-key']);
  });

  test('KnownSecrets names a secret of eight characters or more found anywhere in a text', () => {
    const knownSecrets = new KnownSecrets([
      { name: 'DB_PASSWORD', value: 'secret-pw-77' },
      { name: 'EMPTY', value: '' },
    ]);

    expect(knownSecrets.nameIn('postgres://shop:secret-pw-77@db/shop')).toBe('DB_PASSWORD');
    expect(knownSecrets.nameIn('postgres://shop@db/shop')).toBeUndefined();
    expect(new KnownSecrets().nameIn('')).toBeUndefined();
  });

  test('KnownSecrets names a secret of seven characters or fewer only when it is the whole text', () => {
    const knownSecrets = new KnownSecrets([{ name: 'PLACEHOLDER', value: 'dev-pw7' }]);

    expect(knownSecrets.nameIn('dev-pw7')).toBe('PLACEHOLDER');
    expect(knownSecrets.nameIn('dev-pw7@example.com')).toBeUndefined();
  });

  test('a short known secret is still redacted inside a longer text', () => {
    expect(knowing('dev').redact('dev@example.com')).toBe('[redacted]@example.com');
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
  test('StreamRedactor redacts a secret split across two chunks', () => {
    expect(throughRedactor(['token is s3cr3t-', 'value, done\n'], ['s3cr3t-value'])).toBe(
      'token is [redacted], done\n',
    );
  });

  test('StreamRedactor redacts every occurrence at every chunk size', () => {
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
      expect(throughRedactor(chunks, ['SECRETXYZ', 'SECRET'])).toBe(expected);
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

  test('StreamRedactor hides overlapping secrets whole, at every chunk size', () => {
    const text = 'xxabcdefyy and abc and bcdef';
    for (let size = 1; size <= text.length; size++) {
      const chunks: string[] = [];
      for (let start = 0; start < text.length; start += size) {
        chunks.push(text.slice(start, start + size));
      }
      expect(throughRedactor(chunks, ['abc', 'bcdef'])).toBe(
        'xx[redacted]yy and [redacted] and [redacted]',
      );
    }
  });

  test('StreamRedactor gives the same text as whole-text redaction for random chunks and overlapping secrets', () => {
    let seed = 7;
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };
    const word = (length: number) => Array.from({ length }, () => 'abc\n'[next(4)]).join('');
    for (let round = 0; round < 300; round++) {
      const secrets = Array.from({ length: 1 + next(4) }, () => word(1 + next(5)));
      const text = word(next(60));
      const chunks: string[] = [];
      for (let start = 0; start < text.length; ) {
        const size = 1 + next(8);
        chunks.push(text.slice(start, start + size));
        start += size;
      }
      expect(throughRedactor(chunks, secrets)).toBe(redactValues(text, secrets));
    }
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

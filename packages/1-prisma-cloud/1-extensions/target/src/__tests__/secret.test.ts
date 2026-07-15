import { describe, expect, test } from 'bun:test';
import { isSecretSource } from '@internal/core';
import { envSecret, secretName } from '../secret.ts';

describe('envSecret (Prisma Cloud secret source)', () => {
  test('builds an opaque secret source; secretName reads its env-var name back', () => {
    const source = envSecret('STRIPE_SECRET_KEY');
    expect(isSecretSource(source)).toBe(true);
    expect(secretName({ serviceAddress: 'ingest', slot: 'stripeKey', source })).toBe(
      'STRIPE_SECRET_KEY',
    );
  });

  test('rejects empty, COMPOSE_-prefixed, and poisoned names', () => {
    expect(() => envSecret('')).toThrow(/non-empty/);
    expect(() => envSecret('COMPOSE_X')).toThrow(/COMPOSE_/);
    expect(() => envSecret('DATABASE_URL')).toThrow(/reserved/);
    expect(() => envSecret('DATABASE_URL_POOLED')).toThrow(/reserved/);
  });
});

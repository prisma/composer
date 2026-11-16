import { describe, expect, test } from 'bun:test';
import { appRoot, Load, paramSource, valueResource } from '@internal/core';
import type { ExtensionDescriptor, PrismaAppConfig } from '@internal/core/config';
import type { Pointer } from '@internal/foundation/pointer';
import * as Effect from 'effect/Effect';
import { validateRegistryCoverage } from '../validate-coverage.ts';
import fixtureRoot from './fixtures/valid-root.ts';

describe('validateRegistryCoverage()', () => {
  test('a missing extension names the composer section of prisma.config.ts as the fix', () => {
    const config = { extensions: [], state: {} } as unknown as PrismaAppConfig;
    expect(() => validateRegistryCoverage(Load(fixtureRoot), config)).toThrow(
      expect.objectContaining({
        code: 'CONFIG.EXTENSION_MISSING',
        fix: 'Add it to `extensions` in the `composer` section of prisma.config.ts (import its /control entry and list its descriptor).',
      }),
    );
  });

  const greetingRoot = appRoot('shop', ({ provision }) => {
    provision(
      valueResource({
        name: 'greeting',
        extension: 'test/pack',
        type: 'test-value',
        value: paramSource<{ readonly name: string }, Pointer<string>>({ name: 'GREETING' }),
      }),
    );
  });
  const configWith = (nodes: ExtensionDescriptor['nodes']) =>
    ({ extensions: [{ id: 'test/pack', nodes }], state: {} }) as unknown as PrismaAppConfig;

  test('a value resource is looked up in its extension like every other resource', () => {
    const lowering = Object.assign(() => Effect.succeed({ outputs: {}, entities: [] }), {
      kind: 'resource' as const,
    });

    expect(() =>
      validateRegistryCoverage(Load(greetingRoot), configWith({ 'test-value': lowering })),
    ).not.toThrow();
    expect(() => validateRegistryCoverage(Load(greetingRoot), configWith({}))).toThrow(
      expect.objectContaining({ code: 'CONFIG.DESCRIPTOR_MISSING' }),
    );
  });
});

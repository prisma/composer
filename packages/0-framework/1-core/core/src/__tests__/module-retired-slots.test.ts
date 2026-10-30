/**
 * A module takes its configuration only through `input` (ADR-0061): `module()`
 * and `provision()` of a module refuse the retired `params` and `secrets` keys.
 */
import { describe, expect, test } from 'bun:test';
import { blindCast } from '@internal/foundation/casts';
import * as core from '../exports/index.ts';
import { Load, LoadError } from '../graph.ts';
import { module, paramSource, secretSource } from '../node.ts';

const loadError = (run: () => unknown): LoadError => {
  try {
    run();
  } catch (error) {
    if (error instanceof LoadError) return error;
    throw error;
  }
  throw new Error('expected a LoadError');
};

const withRetiredKey = (boundary: object) =>
  blindCast<Record<never, never>, 'injects a retired boundary key to reach the runtime refusal'>(
    boundary,
  );

describe('module() refuses the retired slots', () => {
  test('module() refuses a params key, naming input', () => {
    expect(() => module('relay', withRetiredKey({ params: {} }), () => {})).toThrow(
      'module("relay") declares `params`, which a module no longer takes. Declare each value ' +
        "as a field of the module's `input` schema, and bind it with provision(module, { input: { … } }) (ADR-0061).",
    );
  });

  test('module() refuses a secrets key, naming input', () => {
    expect(() => module('relay', withRetiredKey({ secrets: {} }), () => {})).toThrow(
      'module("relay") declares `secrets`, which a module no longer takes. Declare each secret ' +
        "as a secretString() field of the module's `input` schema, and bind it with provision(module, { input: { … } }) (ADR-0061).",
    );
  });

  test('module() refuses a params key whose value is undefined', () => {
    expect(() => module('relay', withRetiredKey({ params: undefined }), () => {})).toThrow(
      'module("relay") declares `params`, which a module no longer takes.',
    );
  });
});

describe('provision() of a module refuses the retired maps', () => {
  const relay = module('relay', {}, () => {});

  test('provision() of a module refuses a secrets map, naming input', () => {
    const root = module('shop', ({ provision }) => {
      provision(
        relay,
        blindCast<{ id: string }, 'injects a retired secrets map to reach the Load refusal'>({
          id: 'relay',
          secrets: { key: secretSource({ name: 'K' }) },
        }),
      );
    });

    expect(loadError(() => Load(root)).message).toBe(
      'provision("relay") received secrets for a module, which a module no longer takes. A ' +
        'module takes a secret as a secretString() field of its `input` binding (ADR-0061), not a secrets map.',
    );
  });

  test('provision() of a module refuses a params map, naming input', () => {
    const root = module('shop', ({ provision }) => {
      provision(
        relay,
        blindCast<{ id: string }, 'injects a retired params map to reach the Load refusal'>({
          id: 'relay',
          params: { origin: paramSource({ name: 'O' }) },
        }),
      );
    });

    expect(loadError(() => Load(root)).message).toBe(
      'provision("relay") received params for a module, which a module no longer takes. A ' +
        'module takes its values as fields of its `input` binding (ADR-0061), not a params map.',
    );
  });
});

describe('a module has no slots', () => {
  test('a module body receives deps, environment, input and provision, nothing else', () => {
    const seen: string[][] = [];
    const child = module('child', {}, (ctx) => {
      seen.push(Object.keys(ctx).sort());
    });

    Load(
      module('shop', (ctx) => {
        seen.push(Object.keys(ctx).sort());
        ctx.provision(child);
      }),
    );

    expect(seen).toEqual([
      ['deps', 'environment', 'input', 'provision'],
      ['deps', 'environment', 'input', 'provision'],
    ]);
  });

  test('a module node carries no slot fields', () => {
    expect(Object.keys(module('m', {}, () => {})).sort()).toEqual([
      'body',
      'deps',
      'expose',
      'inputSchema',
      'kind',
      'name',
    ]);
  });

  test('the removed names are not exported', () => {
    expect('paramNeed' in core).toBe(false);
    expect('secret' in core).toBe(false);
  });
});

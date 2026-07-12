import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { contract } from '../contract.ts';
import { rpc } from '../rpc.ts';

describe('rpc()', () => {
  test('carries the input/output schemas on the runtime value', () => {
    const input = type({ token: 'string' });
    const output = type({ ok: 'boolean' });

    const verify = rpc({ input, output }) as unknown as { input: unknown; output: unknown };

    expect(verify.input).toBe(input);
    expect(verify.output).toBe(output);
  });
});

describe('contract()', () => {
  test('is branded with kind "rpc" and carries the function map as __cmp', () => {
    const fns = {
      verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
    };

    const authContract = contract(fns);

    expect(authContract.kind).toBe('rpc');
    expect(authContract.__cmp).toBe(fns);
  });

  test('satisfies() is nominal — a contract only satisfies itself', () => {
    const build = () =>
      contract({
        verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
      });
    const authContract = build();
    const structurallyEqual = build();

    expect(authContract.satisfies(authContract)).toBe(true);
    expect(authContract.satisfies(structurallyEqual)).toBe(false);
  });

  test('the returned contract is frozen', () => {
    const authContract = contract({
      verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
    });

    expect(Object.isFrozen(authContract)).toBe(true);
  });
});

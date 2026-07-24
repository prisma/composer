import { describe, expect, test } from 'bun:test';
import { blindCast } from '@internal/foundation/casts';
import { Load } from '../graph.ts';
import type { InputBinding } from '../node.ts';
import { isSecretSource, module, resource, secret, secretSource, service } from '../node.ts';
import { anyInputSchema, providerContract } from './helpers.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

/** A service that declares an input schema (ADR-0042) — its provision requires an `input` binding. */
const svcWithInput = (name: string) =>
  service({
    name,
    extension: 'test/pack',
    type: 'fake/app',
    inputs: {},
    params: {},
    input: anyInputSchema,
    build,
  });

const plainSvc = (name: string) =>
  service({ name, extension: 'test/pack', type: 'fake/app', inputs: {}, params: {}, build });

describe('secret sources', () => {
  test('secretSource builds a secret source; secret() and plain values are not', () => {
    expect(isSecretSource(secretSource('AUTH_KEY'))).toBe(true);
    expect(isSecretSource(secret())).toBe(false);
    expect(isSecretSource({})).toBe(false);
    expect(isSecretSource(undefined)).toBe(false);
  });
});

describe('Load records input bindings (ADR-0042)', () => {
  test('the root binds a service input directly (the leaf case)', () => {
    const auth = svcWithInput('auth');
    const binding = { signingKey: secretSource('AUTH_SIGNING_KEY') };
    const graph = Load(
      module('root', ({ provision }) => {
        provision(auth, { id: 'auth', input: binding });
      }),
    );
    // Core records the binding at the right address as opaque plain data; it
    // never reads a leaf's payload (the target's concern).
    expect(graph.inputBindings).toHaveLength(1);
    expect(graph.inputBindings[0]?.serviceAddress).toBe('auth');
    expect(graph.inputBindings[0]?.binding).toBe(binding);
  });

  test('a module forwards a secret slot into an inner service input binding (the multi-level case)', () => {
    const inner = svcWithInput('inner');
    const authModule = module('auth', { secrets: { key: secret() } }, ({ secrets, provision }) => {
      provision(inner, { id: 'inner', input: { key: secrets.key } });
    });
    const graph = Load(
      module('root', ({ provision }) => {
        provision(authModule, { id: 'auth', secrets: { key: secretSource('AUTH_KEY') } });
      }),
    );
    // The source flows root -> module.secrets.key -> a leaf of inner's input
    // binding; recorded at the inner service's full address.
    expect(graph.inputBindings).toHaveLength(1);
    expect(graph.inputBindings[0]?.serviceAddress).toBe('auth.inner');
    const binding = blindCast<
      Record<string, unknown> | undefined,
      'test reads the recorded plain-object binding by key'
    >(graph.inputBindings[0]?.binding);
    expect(isSecretSource(binding?.['key'])).toBe(true);
  });

  test('a service with no input schema yields no bindings', () => {
    const graph = Load(
      module('root', ({ provision }) => {
        provision(plainSvc('plain'), { id: 'plain' });
      }),
    );
    expect(graph.inputBindings).toEqual([]);
  });
});

describe('Load validates input bindings and secret forwarding', () => {
  test('a module that declares a secret but never forwards it fails', () => {
    const m = module('auth', { secrets: { key: secret() } }, ({ provision }) => {
      provision(plainSvc('plain'), { id: 'plain' }); // never forwards secrets.key
    });
    expect(() =>
      Load(
        module('root', ({ provision }) => {
          provision(m, { id: 'auth', secrets: { key: secretSource('AUTH_KEY') } });
        }),
      ),
    ).toThrow(/declares secret "key" but never forwards/);
  });

  test('a forwarded secret counts as used wherever it nests inside an input binding', () => {
    const inner = svcWithInput('inner');
    const m = module('auth', { secrets: { key: secret() } }, ({ secrets, provision }) => {
      // The forwarded source sits DEEP in the binding — the usage walk must find it.
      provision(inner, { id: 'inner', input: { stripe: { keys: [secrets.key] } } });
    });
    expect(() =>
      Load(
        module('root', ({ provision }) => {
          provision(m, { id: 'auth', secrets: { key: secretSource('AUTH_KEY') } });
        }),
      ),
    ).not.toThrow();
  });

  test('a root module that declares its own secret slot fails — the root binds, it does not declare', () => {
    const root = module('root', { secrets: { key: secret() } }, () => {});
    expect(() => Load(root)).toThrow(/deployed as the root/);
  });

  test('a lone service that declares an input schema is rejected at Load', () => {
    const auth = svcWithInput('auth');
    expect(() => Load(auth)).toThrow(/no enclosing scope to bind its input/);
  });

  test('a declared input schema left unbound in a provision fails at Load', () => {
    const auth = svcWithInput('auth');
    expect(() =>
      Load(
        module('root', ({ provision }) => {
          provision(
            auth,
            blindCast<
              { id: string; input: InputBinding },
              'deliberately omit the binding to exercise the runtime not-bound check'
            >({ id: 'auth' }),
          );
        }),
      ),
    ).toThrow(/Input of provisioned service "auth" is not bound/);
  });

  test('an input binding on a schema-less service fails at Load', () => {
    expect(() =>
      Load(
        module('root', ({ provision }) => {
          provision(
            plainSvc('plain'),
            blindCast<
              { id: string },
              'inject an input binding the overloads reject — exercise the runtime check'
            >({ id: 'plain', input: {} }),
          );
        }),
      ),
    ).toThrow(/declares no input schema/);
  });

  test('a secrets map on a service fails at Load — secrets ride the input binding now', () => {
    const auth = svcWithInput('auth');
    expect(() =>
      Load(
        module('root', ({ provision }) => {
          provision(
            auth,
            blindCast<
              { id: string; input: InputBinding },
              'inject the removed secrets option to exercise the runtime rejection'
            >({ id: 'auth', input: {}, secrets: { key: secretSource('K') } }),
          );
        }),
      ),
    ).toThrow(/received secrets for a service/);
  });

  test('a resource may not receive an input binding', () => {
    const db = resource({
      name: 'db',
      extension: 'test/pack',
      provides: providerContract('fake/db', { url: '' }),
    });
    expect(() =>
      Load(
        module('root', ({ provision }) => {
          provision(
            db,
            blindCast<
              { id: string },
              'a resource takes no input — inject one to hit the runtime check'
            >({ id: 'db', input: {} }),
          );
        }),
      ),
    ).toThrow(/resource declares no input schema/);
  });

  test('a module may not receive an input binding — the service that declares the schema binds it', () => {
    const m = module('child', {}, ({ provision }) => {
      provision(plainSvc('plain'), { id: 'plain' });
    });
    expect(() =>
      Load(
        module('root', ({ provision }) => {
          provision(
            m,
            blindCast<
              { id: string },
              'a module takes no input binding — inject one to hit the runtime check'
            >({ id: 'child', input: {} }),
          );
        }),
      ),
    ).toThrow(/input binding for a module/);
  });

  test('a non-secret value wired into a module secret slot is rejected', () => {
    const m = module('auth', { secrets: { key: secret() } }, ({ secrets, provision }) => {
      provision(svcWithInput('inner'), { id: 'inner', input: { key: secrets.key } });
    });
    expect(() =>
      Load(
        module('root', ({ provision }) => {
          // @ts-expect-error a secret slot must be bound with a secret source
          provision(m, { id: 'auth', secrets: { key: 'not-a-secret' } });
        }),
      ),
    ).toThrow(/non-secret value/);
  });

  test('branded copies keep used-tracking per-slot — the SAME source bound to two slots, forwarding only one, flags the other unused', () => {
    const inner = svcWithInput('inner');
    const m = module('m', { secrets: { a: secret(), b: secret() } }, ({ secrets, provision }) => {
      // Forward only `a`; `b` is never forwarded.
      provision(inner, { id: 'inner', input: { key: secrets.a } });
    });
    // The SAME source object is bound to BOTH a and b. Without the per-slot
    // branded copies, forwarding secrets.a would alias-mark b used too; with
    // them, b is correctly flagged as never forwarded.
    const src = secretSource('SHARED');
    expect(() =>
      Load(
        module('root', ({ provision }) => {
          provision(m, { id: 'm', secrets: { a: src, b: src } });
        }),
      ),
    ).toThrow(/declares secret "b" but never forwards/);
  });
});

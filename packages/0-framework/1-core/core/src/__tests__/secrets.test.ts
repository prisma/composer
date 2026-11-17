import { describe, expect, test } from 'bun:test';
import { blindCast } from '@internal/foundation/casts';
import { Load, secretsKeys } from '../graph.ts';
import { appRoot, isSecretSource, module, resource, secretSource, service } from '../node.ts';
import { anyInputSchema, providerContract, secretValue } from './helpers.ts';

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
  test('secretSource builds a secret source; plain values are not', () => {
    expect(isSecretSource(secretSource('AUTH_KEY'))).toBe(true);
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
    expect(graph.inputBindings[0]?.serviceAddress).toBe('root.auth');
    expect(graph.inputBindings[0]?.binding).toBe(binding);
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
  test('a cyclic service input binding completes Load', () => {
    const cyclic: Record<string, unknown> = { key: secretSource('AUTH_KEY') };
    cyclic['self'] = cyclic;
    const graph = Load(
      module('root', ({ provision }) => {
        provision(svcWithInput('inner'), {
          id: 'inner',
          input: cyclic,
        });
      }),
    );
    expect(graph.inputBindings).toHaveLength(1);
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
              { id: string; input: unknown },
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
              { id: string; input: unknown },
              'inject the removed secrets option to exercise the runtime rejection'
            >({ id: 'auth', input: {}, secrets: { key: secretSource('K') } }),
          );
        }),
      ),
    ).toThrow(
      'provision("auth") received secrets for a service — a service takes its secrets as values bound to secretString() fields of its `input` binding, not a secrets map.',
    );
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

  test('a module that declares no input schema may not receive an input binding', () => {
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
              'a module that declares no input takes no input binding — inject one to hit the runtime check'
            >({ id: 'child', input: {} }),
          );
        }),
      ),
    ).toThrow(/received an input binding, but the module declares no input schema/);
  });
});

describe("a secret value resource is in the graph's secret sources", () => {
  test('named by the node itself when the root provisions it and binds it nowhere', () => {
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        provision(secretValue('API_KEY'), { id: 'apiKey' });
      }),
    );

    expect(graph.secretSources.map(({ address, nodeKind }) => ({ address, nodeKind }))).toEqual([
      { address: 'shop.apiKey', nodeKind: 'resource' },
    ]);
    expect(secretsKeys(graph)).toEqual(['API_KEY']);
  });

  test('named by the node itself when a module receives it and no service reads it', () => {
    const mailer = module('mailer', { input: anyInputSchema }, () => {});
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        const key = provision(secretValue('API_KEY'), { id: 'apiKey' });
        provision(mailer, { input: { key } });
      }),
    );

    expect(graph.secretSources.map(({ address, nodeKind }) => ({ address, nodeKind }))).toEqual([
      { address: 'shop.apiKey', nodeKind: 'resource' },
    ]);
    expect(secretsKeys(graph)).toEqual(['API_KEY']);
  });

  test('named by the service whose binding holds it, once', () => {
    const mailer = module('mailer', { input: anyInputSchema }, ({ input, provision }) => {
      provision(svcWithInput('send'), { input: { key: (input as never)['key'] } });
    });
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        const key = provision(secretValue('API_KEY'), { id: 'apiKey' });
        provision(mailer, { input: { key } });
      }),
    );

    expect(graph.secretSources.map(({ address, nodeKind }) => ({ address, nodeKind }))).toEqual([
      { address: 'shop.mailer.send', nodeKind: 'service' },
    ]);
  });
});

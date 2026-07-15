/**
 * Provision-time param binding: a param may be bound to a literal (schema-
 * validated when config is built, see lowering.test.ts's buildConfig suite)
 * or to an opaque `ParamSource` (core forwards it, never inspects it) — the
 * non-secret sibling of ADR-0029's secret need/source split. `Load` records
 * every bound param and lets a module forward a `ParamSource` down to a
 * child through a nameless `paramNeed()` slot, the same rail secrets ride on.
 */
import { describe, expect, test } from 'bun:test';
import { blindCast } from '@internal/foundation/casts';
import { string } from '../config.ts';
import { Load } from '../graph.ts';
import type { ParamSource } from '../node.ts';
import { isParamSource, module, paramNeed, paramSource, resource, service } from '../node.ts';
import { providerContract } from './helpers.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const svc = () =>
  service({
    name: 'app',
    extension: 'test/pack',
    type: 'fake/app',
    inputs: {},
    params: { origin: string() },
    build,
  });

describe('param sources', () => {
  test('paramSource builds a param source; paramNeed() and plain values are not', () => {
    expect(isParamSource(paramSource('APP_ORIGIN'))).toBe(true);
    expect(isParamSource(paramNeed())).toBe(false);
    expect(isParamSource({})).toBe(false);
    expect(isParamSource(undefined)).toBe(false);
  });
});

describe('Load records param bindings', () => {
  test('a literal bound at provision is recorded at the service address/slot', () => {
    const app = svc();
    const graph = Load(
      module('root', ({ provision }) => {
        provision(app, { id: 'app', params: { origin: 'https://example.com' } });
      }),
    );

    expect(graph.params).toEqual([
      { serviceAddress: 'app', slot: 'origin', binding: 'https://example.com' },
    ]);
  });

  test('a ParamSource bound at provision is recorded opaquely — core never inspects the payload', () => {
    const app = svc();
    const graph = Load(
      module('root', ({ provision }) => {
        provision(app, { id: 'app', params: { origin: paramSource('APP_ORIGIN') } });
      }),
    );

    expect(graph.params).toHaveLength(1);
    expect(graph.params[0]?.serviceAddress).toBe('app');
    expect(graph.params[0]?.slot).toBe('origin');
    expect(isParamSource(graph.params[0]?.binding)).toBe(true);
  });

  test('an unbound param yields no binding — it falls back to its default at buildConfig', () => {
    const graph = Load(
      module('root', ({ provision }) => {
        provision(svc(), { id: 'app' });
      }),
    );

    expect(graph.params).toEqual([]);
  });

  test('a module forwards a param source to an inner service (the multi-level case)', () => {
    const inner = svc();
    const wrapper = module(
      'wrapper',
      { params: { origin: paramNeed() } },
      ({ params, provision }) => {
        provision(inner, { id: 'inner', params: { origin: params.origin } });
      },
    );
    const graph = Load(
      module('root', ({ provision }) => {
        provision(wrapper, { id: 'wrapper', params: { origin: paramSource('APP_ORIGIN') } });
      }),
    );

    expect(graph.params).toHaveLength(1);
    expect(graph.params[0]?.serviceAddress).toBe('wrapper.inner');
    expect(graph.params[0]?.slot).toBe('origin');
    expect(isParamSource(graph.params[0]?.binding)).toBe(true);
  });
});

describe('Load validates param wiring', () => {
  test('a module that declares a param-forwarding slot but never forwards it fails', () => {
    const m = module('wrapper', { params: { origin: paramNeed() } }, ({ provision }) => {
      provision(svc(), { id: 'app' }); // never forwards params.origin
    });
    expect(() =>
      Load(
        module('root', ({ provision }) => {
          provision(m, { id: 'wrapper', params: { origin: paramSource('APP_ORIGIN') } });
        }),
      ),
    ).toThrow(/declares param "origin" but never forwards/);
  });

  test('a root module that declares its own param-forwarding slot fails — the root binds, it does not declare', () => {
    const root = module('root', { params: { origin: paramNeed() } }, () => {});
    expect(() => Load(root)).toThrow(/no enclosing scope to bind them/);
  });

  test('a param binding naming something other than a declared param fails', () => {
    expect(() =>
      Load(
        module('root', ({ provision }) => {
          provision(
            svc(),
            blindCast<
              { id: string; params: { origin: string; bogus: string } },
              'inject an extra non-param key alongside a real one to exercise the runtime extra-key check'
            >({ id: 'app', params: { origin: 'https://example.com', bogus: 'nope' } }),
          );
        }),
      ),
    ).toThrow(/"bogus", which is not a param/);
  });

  test('a declared module param-forwarding slot left unbound in a provision fails at Load', () => {
    const m = module('wrapper', { params: { origin: paramNeed() } }, ({ provision }) => {
      provision(svc(), { id: 'app' });
    });
    expect(() =>
      Load(
        module('root', ({ provision }) => {
          provision(
            m,
            blindCast<
              { id: string; params: { origin: ParamSource } },
              'deliberately omit the binding to exercise the runtime not-bound check'
            >({ id: 'wrapper', params: {} }),
          );
        }),
      ),
    ).toThrow(/is not bound/);
  });

  test('a non-source value wired into a module param-forwarding slot is rejected', () => {
    const m = module('wrapper', { params: { origin: paramNeed() } }, ({ provision }) => {
      provision(svc(), { id: 'app' });
    });
    expect(() =>
      Load(
        module('root', ({ provision }) => {
          provision(
            m,
            blindCast<
              { id: string; params: { origin: ParamSource } },
              'inject a non-source value to exercise the runtime type check'
            >({ id: 'wrapper', params: { origin: 'not-a-source' } }),
          );
        }),
      ),
    ).toThrow(/non-source value/);
  });

  test('an extra param key naming a non-slot fails at Load on a module target', () => {
    const inner = svc();
    const m = module('wrapper', { params: { origin: paramNeed() } }, ({ params, provision }) => {
      provision(inner, { id: 'inner', params: { origin: params.origin } });
    });
    expect(() =>
      Load(
        module('root', ({ provision }) => {
          provision(
            m,
            blindCast<
              { id: string; params: { origin: ParamSource; bogus: ParamSource } },
              'inject an extra non-slot key to exercise the runtime extra-key check'
            >({
              id: 'wrapper',
              params: { origin: paramSource('APP_ORIGIN'), bogus: paramSource('BOGUS') },
            }),
          );
        }),
      ),
    ).toThrow(/"bogus", which is not a param slot/);
  });

  test('a resource may not receive params', () => {
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
              'a resource takes no params — inject one to hit the runtime check'
            >({ id: 'db', params: { origin: 'nope' } }),
          );
        }),
      ),
    ).toThrow(/resource has no params/);
  });

  test('branded copies keep used-tracking per-slot — the SAME source bound to two slots, forwarding only one, flags the other unused', () => {
    const inner = svc();
    const m = module(
      'm',
      { params: { a: paramNeed(), b: paramNeed() } },
      ({ params, provision }) => {
        // Forward only `a`; `b` is never forwarded.
        provision(inner, { id: 'inner', params: { origin: params.a } });
      },
    );
    // The SAME source object is bound to BOTH a and b. Without the per-slot
    // branded copies, forwarding a would falsely mark b used too.
    const src = paramSource('SHARED');
    expect(() =>
      Load(
        module('root', ({ provision }) => {
          provision(m, { id: 'm', params: { a: src, b: src } });
        }),
      ),
    ).toThrow(/declares param "b" but never forwards/);
  });
});

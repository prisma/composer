/**
 * Provision-time param binding: a param may be bound to a literal (schema-
 * validated when config is built, see lowering.test.ts's buildConfig suite)
 * or to an opaque `ParamSource` (core forwards it, never inspects it) — the
 * non-secret sibling of ADR-0029's secret need/source split.
 */
import { describe, expect, test } from 'bun:test';
import { blindCast } from '@internal/foundation/casts';
import { string } from '../config.ts';
import { Load } from '../graph.ts';
import { isParamSource, module, paramSource, resource, service } from '../node.ts';
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
  test('paramSource builds a param source; plain values are not', () => {
    expect(isParamSource(paramSource('APP_ORIGIN'))).toBe(true);
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
      { serviceAddress: 'root.app', slot: 'origin', binding: 'https://example.com' },
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
    expect(graph.params[0]?.serviceAddress).toBe('root.app');
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
});

describe('Load validates param wiring', () => {
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
});

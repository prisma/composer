/**
 * Type-level rules for provision-time param binding (the spec's "env-sourced
 * config params" slice, D1): `paramSource()` is a `ParamSource`, `paramNeed()`
 * is a nameless `ParamNeed`, and `provision()` accepts a literal typed by the
 * param's own schema OR a `ParamSource` — never a value the schema doesn't
 * produce. Type-only (vitest `--typecheck`, never executed).
 */
import { expectTypeOf, test } from 'vitest';
import { number, string } from '../config.ts';
import type { BuildAdapter, ParamNeed, ParamSource } from '../node.ts';
import { module, paramNeed, paramSource, service } from '../node.ts';

const build: BuildAdapter = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

test('paramSource() is a ParamSource; paramNeed() is a ParamNeed', () => {
  expectTypeOf(paramSource('APP_ORIGIN')).toEqualTypeOf<ParamSource<string>>();
  expectTypeOf(paramNeed()).toEqualTypeOf<ParamNeed>();
});

test('provisioning a service accepts a literal typed by the param schema, or a ParamSource — never an unrelated value', () => {
  const svc = service({
    name: 'app',
    extension: 'test/pack',
    type: 'fake/app',
    inputs: {},
    params: { origin: string(), port: number({ default: 3000 }) },
    build,
  });

  module('root', ({ provision }) => {
    // Unbound is fine — origin has no default, so this defers to buildConfig
    // to fail loudly at deploy, not a compile-time requirement (default
    // fallback / optionality make binding genuinely optional per param).
    provision(svc, { id: 'app' });
    provision(svc, { id: 'app', params: { origin: 'https://example.com' } });
    provision(svc, { id: 'app', params: { origin: paramSource('APP_ORIGIN') } });
    provision(svc, { id: 'app', params: { port: 8080 } });
    // @ts-expect-error a string param rejects a number literal
    provision(svc, { id: 'app', params: { origin: 123 } });
    // @ts-expect-error a number param rejects a string literal
    provision(svc, { id: 'app', params: { port: 'nope' } });
  });
});

test('a module param-forwarding slot accepts only a ParamSource, never a literal — it carries no schema to validate one against', () => {
  const inner = service({
    name: 'inner',
    extension: 'test/pack',
    type: 'fake/app',
    inputs: {},
    params: { origin: string() },
    build,
  });
  const wrapper = module(
    'wrapper',
    { params: { origin: paramNeed() } },
    ({ params, provision }) => {
      provision(inner, { id: 'inner', params: { origin: params.origin } });
    },
  );

  module('root', ({ provision }) => {
    provision(wrapper, { id: 'wrapper', params: { origin: paramSource('APP_ORIGIN') } });
    // @ts-expect-error a module param-forwarding slot must be bound with a ParamSource, not a literal
    provision(wrapper, { id: 'wrapper', params: { origin: 'https://example.com' } });
  });
});

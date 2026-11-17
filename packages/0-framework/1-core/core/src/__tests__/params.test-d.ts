import { expectTypeOf, test } from 'vitest';
import { number, string } from '../config.ts';
import type { BuildAdapter, ParamSource } from '../node.ts';
import { module, paramSource, service } from '../node.ts';
import type { Value } from '../value.ts';

const build: BuildAdapter = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

test('paramSource() is a ParamSource and a value', () => {
  expectTypeOf(paramSource('APP_ORIGIN')).toEqualTypeOf<ParamSource<string> & Value<unknown>>();
});

test('provisioning a service accepts a literal typed by the param schema, and refuses a source or an unrelated value', () => {
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
    // @ts-expect-error a param takes a literal or a deploy-time value, never a source
    provision(svc, { id: 'app', params: { origin: paramSource('APP_ORIGIN') } });
    provision(svc, { id: 'app', params: { port: 8080 } });
    // @ts-expect-error a string param rejects a number literal
    provision(svc, { id: 'app', params: { origin: 123 } });
    // @ts-expect-error a number param rejects a string literal
    provision(svc, { id: 'app', params: { port: 'nope' } });
  });
});

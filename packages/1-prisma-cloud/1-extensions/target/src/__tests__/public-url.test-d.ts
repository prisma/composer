import { module, resolve } from '@internal/core';
import { rawHttpContract } from '@internal/http';
import { contract, rpc } from '@internal/service-rpc';
import { type } from 'arktype';
import { expectTypeOf, test } from 'vitest';
import type { PublicUrlNode } from '../exports/index.ts';
import { compute, publicUrl, rawPostgresContract } from '../exports/index.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};
const adminContract = contract({
  ping: rpc({ input: type({}), output: type({ ok: 'boolean' }) }),
});

test('an exposed HTTP interface is a target; an RPC, a Postgres or a bare ref is not', () => {
  module('shop', ({ environment, provision }) => {
    const web = provision(
      compute({
        name: 'web',
        deps: {},
        build,
        expose: { http: rawHttpContract, admin: adminContract, db: rawPostgresContract },
      }),
    );
    expectTypeOf(
      publicUrl({ name: 'site', url: 'shop.com', target: web.http }),
    ).toEqualTypeOf<PublicUrlNode>();
    publicUrl({
      name: 'site',
      url: resolve([environment.name], ([name]) =>
        name === 'production' ? 'shop.com' : publicUrl.prismaBuild(),
      ),
      target: web.http,
    });
    // @ts-expect-error an RPC interface is not HTTP
    publicUrl({ name: 'site', url: 'shop.com', target: web.admin });
    // @ts-expect-error a Postgres interface is not HTTP
    publicUrl({ name: 'site', url: 'shop.com', target: web.db });
    // @ts-expect-error a whole provisioned ref is not an exposed interface
    publicUrl({ name: 'site', url: 'shop.com', target: web });
  });
});

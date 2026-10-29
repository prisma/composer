import { describe, expect, test } from 'bun:test';
import { dependency, Load, module, provisionNeed, resource, string } from '@internal/core';
import { compute } from '../exports/index.ts';
import { provisionedEdges } from '../provisioned-edges.ts';

const BRAND: unique symbol = Symbol('provisioned-edges.test.ts/brand');

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const tokenSlot = () =>
  dependency({
    type: 'test/rpc',
    connection: {
      params: { token: string({ provision: provisionNeed(BRAND) }) },
      hydrate: (v) => v,
    },
  });

describe('provisionedEdges', () => {
  test("lists a resource consumer's provisioned edge, as core's minting loop does", () => {
    const graph = Load(
      module('shop', ({ provision }) => {
        const auth = provision(compute({ name: 'auth', deps: {}, build }), { id: 'auth' });
        provision(
          resource({
            name: 'site',
            extension: '@prisma/composer-prisma-cloud',
            provides: { kind: 'test/url', __cmp: {}, satisfies: () => false },
            inputs: { auth: tokenSlot() },
            deps: { auth },
          }),
          { id: 'site' },
        );
      }),
    );

    expect(provisionedEdges(graph)).toEqual([
      {
        edgeId: 'shop.site.auth',
        consumerAddress: 'shop.site',
        input: 'auth',
        providerAddress: 'shop.auth',
        brand: BRAND,
      },
    ]);
  });
});

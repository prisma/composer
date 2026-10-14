import type { DependencyEnd, Hydrated } from '@internal/core';
import { module } from '@internal/core';
import { expectTypeOf, test } from 'vitest';
import {
  compute,
  type HttpClient,
  http,
  httpContract,
  rawPostgresContract,
} from '../exports/index.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};
const gateway = compute({ name: 'gateway', deps: { site: http() }, build });

test('http() requires an HTTP contract and hydrates a standard fetch client', () => {
  expectTypeOf(http()).toEqualTypeOf<DependencyEnd<HttpClient, typeof httpContract>>();
  expectTypeOf<Hydrated<ReturnType<typeof http>>>().toEqualTypeOf<HttpClient>();
  expectTypeOf(gateway.load().site).toEqualTypeOf<HttpClient>();
});

test('HTTP ports wire directly and through an exposed module port', () => {
  const website = module('website', { expose: { http: httpContract } }, ({ provision }) => ({
    http: provision(compute({ name: 'site', deps: {}, build, expose: { http: httpContract } }))
      .http,
  }));
  module('web', ({ provision }) => {
    const site = provision(website);
    provision(gateway, { deps: { site: site.http } });
  });
});

test('a bare service ref or a different transport cannot fill an HTTP slot', () => {
  module('bad', ({ provision }) => {
    const bare = provision(compute({ name: 'bare', deps: {}, build }));
    // @ts-expect-error an HTTP dependency needs an exposed httpContract port
    provision(gateway, { deps: { site: bare } });
    const other = provision(
      compute({ name: 'other', deps: {}, build, expose: { db: rawPostgresContract } }),
    );
    // @ts-expect-error a Postgres port cannot satisfy an HTTP dependency
    provision(gateway, { deps: { site: other.db } });
  });
});

test('the named overload keeps its original untyped binding', () => {
  expectTypeOf(http({ name: 'legacy' })).toEqualTypeOf<DependencyEnd<HttpClient>>();
});

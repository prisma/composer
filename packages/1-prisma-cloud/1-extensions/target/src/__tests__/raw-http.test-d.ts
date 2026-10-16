import { module } from '@internal/core';
import { type RawHttpClient, rawHttp, rawHttpContract } from '@internal/http';
import { expectTypeOf, test } from 'vitest';
import { compute, rawPostgresContract } from '../exports/index.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};
const gateway = compute({ name: 'gateway', deps: { site: rawHttp() }, build });

test("a compute service's rawHttp() dependency loads as RawHttpClient", () => {
  expectTypeOf(gateway.load().site).toEqualTypeOf<RawHttpClient>();
});

test('a compute http port fills the slot; a bare ref and a Postgres port do not', () => {
  module('web', ({ provision }) => {
    const site = provision(
      compute({ name: 'site', deps: {}, build, expose: { http: rawHttpContract } }),
    );
    provision(gateway, { deps: { site: site.http } });

    const bare = provision(compute({ name: 'bare', deps: {}, build }));
    // @ts-expect-error a rawHttp() slot needs a rawHttpContract port
    provision(gateway, { deps: { site: bare } });
    const db = provision(
      compute({ name: 'db', deps: {}, build, expose: { db: rawPostgresContract } }),
    );
    // @ts-expect-error a Postgres port cannot fill a rawHttp() slot
    provision(gateway, { deps: { site: db.db } });
  });
});

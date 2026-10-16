/**
 * Compile-time wiring of `rawHttp()` slots. Type-only (vitest --typecheck,
 * never executed): the rejected wirings would also fail Load.
 */
import type { DependencyEnd, Hydrated } from '@internal/core';
import { module } from '@internal/core';
import { expectTypeOf, test } from 'vitest';
import { type RawHttpClient, rawHttp, rawHttpContract } from '../exports/index.ts';
import { consumer, otherContract, provider } from './fixtures.ts';

const gateway = consumer('gateway', { site: rawHttp() });

test('rawHttp() requires rawHttpContract and hydrates RawHttpClient', () => {
  expectTypeOf(rawHttp()).toEqualTypeOf<DependencyEnd<RawHttpClient, typeof rawHttpContract>>();
  expectTypeOf<Hydrated<ReturnType<typeof rawHttp>>>().toEqualTypeOf<RawHttpClient>();
});

test('an http port wires directly and through a module', () => {
  module('direct', ({ provision }) => {
    const site = provision(provider('site', { http: rawHttpContract }));
    provision(gateway, { deps: { site: site.http } });
  });

  const website = module('website', { expose: { http: rawHttpContract } }, ({ provision }) => ({
    http: provision(provider('server', { http: rawHttpContract })).http,
  }));
  module('forwarded', ({ provision }) => {
    const site = provision(website);
    provision(gateway, { deps: { site: site.http } });
  });
});

test('a bare service ref or a port of another kind cannot fill a rawHttp() slot', () => {
  module('bad', ({ provision }) => {
    const bare = provision(provider('bare'));
    // @ts-expect-error a rawHttp() slot needs a rawHttpContract port
    provision(gateway, { deps: { site: bare } });
    const other = provision(provider('other', { db: otherContract }));
    // @ts-expect-error a port of another kind cannot fill a rawHttp() slot
    provision(gateway, { deps: { site: other.db } });
  });
});

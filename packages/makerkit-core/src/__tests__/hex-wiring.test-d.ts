/**
 * The accept/reject matrix for dependency wiring, checked on the real hex:
 * `HexBuilder.provision` wiring a provisioned ref into a consumer's slot —
 * ONE mechanism, the contract determines validity — and the Deps constraint
 * that keeps bare ResourceNodes out of a service's inputs.
 *
 * Type-only (vitest `--typecheck`, never executed at runtime): the reject
 * cases are exactly what Load's runtime backstop throws on (see hex.test.ts),
 * so running the calls would throw. Positive cases use `expectTypeOf`
 * matchers; the negative call/argument shapes keep a `// @ts-expect-error` on
 * the offending line — the idiomatic form for "this must not compile".
 */
import { expectTypeOf, test } from 'vitest';
import type { Contract } from '../contract.ts';
import type { BuildAdapter, HexBuilder, RefPort } from '../node.ts';
import { dependency, resource, service } from '../node.ts';
import { conn, providerContract } from './helpers.ts';

const build: BuildAdapter = {
  kind: 'node',
  pack: '@makerkit/node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const pgContract = providerContract('fake/postgres', { url: '' });
const cacheContract = providerContract('fake/cache', {});

const pgNode = resource({ name: 'db', pack: 'test/pack', provides: pgContract });
const cacheNode = resource({ name: 'cache', pack: 'test/pack', provides: cacheContract });

const pgDep = dependency({
  name: 'db',
  type: 'fake/postgres',
  connection: conn({ url: { type: 'string', secret: true } }, (v) => ({ url: v.url })),
  required: pgContract,
});

const untypedDep = dependency({
  type: 'fake/http',
  connection: conn({ url: { type: 'string' } }, (v) => ({ url: v.url })),
});

const consumer = service({
  name: 'test-service',
  pack: 'test/pack',
  type: 'fake/compute',
  inputs: { db: pgDep },
  params: {},
  build,
});

const untypedConsumer = service({
  name: 'test-service',
  pack: 'test/pack',
  type: 'fake/compute',
  inputs: { anything: untypedDep },
  params: {},
  build,
});

const producer = service({
  name: 'test-service',
  pack: 'test/pack',
  type: 'fake/compute',
  inputs: {},
  params: {},
  build,
});

declare const h: HexBuilder;

const pgRef = h.provision('pg', pgNode);
const cacheRef = h.provision('cache', cacheNode);
const producerRef = h.provision('producer', producer);

test('provisioning a resource returns its provided contract as the ref, tagged with the id', () => {
  expectTypeOf(pgRef).toEqualTypeOf<{ readonly id: string } & RefPort<typeof pgContract>>();
  expectTypeOf(pgRef).toExtend<Contract<'fake/postgres', { url: string }>>();
});

test('a ref whose contract matches the slot requirement is accepted; the untyped slot accepts any ref', () => {
  expectTypeOf(h.provision).toBeCallableWith('c1', consumer, { db: pgRef });
  // The untyped slot (Req = unknown) is the escape hatch — a resource ref or
  // a bare service ref both pass, uniformly.
  expectTypeOf(h.provision).toBeCallableWith('c2', untypedConsumer, { anything: pgRef });
  expectTypeOf(h.provision).toBeCallableWith('c3', untypedConsumer, { anything: producerRef });
});

test('a wrong-contract ref, a bare service ref for a typed slot, and a ResourceNode in deps are rejected', () => {
  // @ts-expect-error the cache contract's kind cannot satisfy the postgres-requiring slot
  h.provision('c4', consumer, { db: cacheRef });
  // @ts-expect-error a bare service ref carries no contract for a typed slot
  h.provision('c5', consumer, { db: producerRef });
  // @ts-expect-error a dependency-only end (no identity) is not provisionable
  h.provision('c6', pgDep);

  // A concrete ResourceNode can never sit in deps — only declarations.
  service({
    name: 'test-service',
    pack: 'test/pack',
    type: 'fake/compute',
    // @ts-expect-error a ResourceNode is not a dependency declaration
    inputs: { db: pgNode },
    params: {},
    build,
  });
});

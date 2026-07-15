/**
 * The `storage()` module Loads into a wired graph: it owns a Postgres `db`
 * resource, a minted `credentials` resource, and the `s3-store` service wired to
 * both, and a consumer's `s3()` slot resolves to the service's `store` port.
 * Mirrors cron's module.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { Load, module } from '@internal/core';
import node from '@internal/node';
import { compute } from '@internal/prisma-cloud';
import { s3 } from '../contract.ts';
import { storage } from '../storage-module.ts';

const build = node({ module: import.meta.url, entry: '../dist/x.mjs' });
const consumer = () => compute({ name: 'consumer', deps: { store: s3() }, build });

describe('storage()', () => {
  test('Loads the db + credentials resources and the s3-store service, wired to each other', () => {
    const root = module('root', {}, ({ provision }) => {
      provision(storage(), { id: 'storage' });
      return {};
    });

    const graph = Load(root);
    const byId = new Map(graph.nodes.map((n) => [n.id, n.node]));
    const typeOf = (id: string): string | undefined => {
      const n = byId.get(id);
      return n !== undefined && 'type' in n ? n.type : undefined;
    };

    expect(typeOf('storage.db')).toBe('postgres');
    expect(typeOf('storage.credentials')).toBe('credentials');
    expect(typeOf('storage.service')).toBe('s3-store');

    expect(graph.edges).toContainEqual({
      from: 'storage.db',
      to: 'storage.service',
      input: 'db',
      kind: 'dependency',
    });
    expect(graph.edges).toContainEqual({
      from: 'storage.credentials',
      to: 'storage.service',
      input: 'credentials',
      kind: 'dependency',
    });
  });

  test("a consumer's s3() slot resolves to the module's store port (the service)", () => {
    const root = module('root', {}, ({ provision }) => {
      const store = provision(storage(), { id: 'storage' });
      provision(consumer(), { id: 'consumer', deps: { store: store.store } });
      return {};
    });

    const graph = Load(root);

    // The exposed `store` port resolves to the underlying s3-store service.
    expect(graph.edges).toContainEqual({
      from: 'storage.service',
      to: 'consumer',
      input: 'store',
      kind: 'dependency',
    });
  });

  test('opts.name and opts.bucket customize the module', () => {
    const root = module('root', {}, ({ provision }) => {
      provision(storage({ name: 'blobs', bucket: 'photos' }), { id: 'blobs' });
      return {};
    });

    const graph = Load(root);
    const byId = new Map(graph.nodes.map((n) => [n.id, n.node]));
    expect([...byId.keys()]).toContain('blobs.service');
    expect([...byId.keys()]).toContain('blobs.db');

    // opts.bucket reaches the s3-store service's `bucket` param default.
    const service = byId.get('blobs.service');
    const bucketDefault =
      service !== undefined && 'params' in service ? service.params['bucket']?.default : undefined;
    expect(bucketDefault).toBe('photos');
  });
});

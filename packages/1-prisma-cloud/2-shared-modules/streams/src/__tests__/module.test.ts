/**
 * The `streams()` module Loads into a wired graph: its `store` boundary dep
 * forwards into the compute service, and a consumer's `durableStreams()` slot
 * resolves to the service's `streams` port carrying the provisioning need for
 * the bearer key. Mirrors storage's module.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { Load, module } from '@internal/core';
import node from '@internal/node';
import { compute, STREAMS_API_KEY } from '@internal/prisma-cloud';
import { storage } from '@internal/storage';
import { durableStreams } from '../contract.ts';
import { streams } from '../streams-module.ts';

const build = node({ module: import.meta.url, entry: '../dist/x.mjs' });
const consumer = () => compute({ name: 'consumer', deps: { events: durableStreams() }, build });

const root = () =>
  module('root', {}, ({ provision }) => {
    const store = provision(storage(), { id: 'storage' });
    const events = provision(streams(), {
      id: 'streams',
      deps: { store: store.store },
    });
    provision(consumer(), { id: 'consumer', deps: { events: events.streams } });
    return {};
  });

describe('streams()', () => {
  test('Loads the compute service with the storage module wired as its durable tier', () => {
    const graph = Load(root());
    const byId = new Map(graph.nodes.map((n) => [n.id, n.node]));
    const typeOf = (id: string): string | undefined => {
      const n = byId.get(id);
      return n !== undefined && 'type' in n ? n.type : undefined;
    };

    expect(typeOf('streams.service')).toBe('compute');
    expect(graph.edges).toContainEqual({
      from: 'storage.service',
      to: 'streams.service',
      input: 'store',
      kind: 'dependency',
    });
  });

  test("the consumer's apiKey param carries the streams provisioning need — nothing is wired for it", () => {
    const graph = Load(root());
    const consumerNode = graph.nodes.find((n) => n.id === 'consumer')?.node;
    if (consumerNode === undefined || consumerNode.kind !== 'service') {
      throw new Error('expected the consumer service');
    }
    const apiKey = consumerNode.inputs['events']?.connection.params['apiKey'];
    expect(apiKey?.provision?.brand).toBe(STREAMS_API_KEY);
    // The module owns no credentials resource — the key is the target's to mint.
    expect(graph.nodes.map((n) => n.id)).not.toContain('streams.credentials');
  });

  test("a consumer's durableStreams() slot resolves to the module's streams port (the service)", () => {
    const graph = Load(root());
    expect(graph.edges).toContainEqual({
      from: 'streams.service',
      to: 'consumer',
      input: 'events',
      kind: 'dependency',
    });
  });

  test('no secret slot remains anywhere in the graph', () => {
    const graph = Load(root());
    expect(graph.secrets).toEqual([]);
  });

  test('opts.name customizes the module', () => {
    const named = module('root', {}, ({ provision }) => {
      const store = provision(storage(), { id: 'storage' });
      provision(streams({ name: 'events' }), {
        id: 'events',
        deps: { store: store.store },
      });
      return {};
    });
    const graph = Load(named);
    expect(graph.nodes.map((n) => n.id)).toContain('events.service');
  });
});

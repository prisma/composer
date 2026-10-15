import { describe, expect, test } from 'bun:test';
import { isNode, Load, module, string } from '@internal/core';
import { rawHttp, rawHttpContract } from '../raw-http.ts';
import { consumer, otherContract, provider } from './fixtures.ts';

describe('rawHttpContract', () => {
  test('has kind http and declares no style', () => {
    expect(rawHttpContract.kind).toBe('http');
    expect(rawHttpContract.style).toBeUndefined();
    expect(Object.isFrozen(rawHttpContract)).toBe(true);
  });

  test('compares by kind, so an independent copy satisfies it and another kind does not', () => {
    expect(rawHttpContract.satisfies({ ...rawHttpContract })).toBe(true);
    expect(rawHttpContract.satisfies(otherContract as never)).toBe(false);
  });
});

describe('rawHttp()', () => {
  test('is an http dependency requiring rawHttpContract with a url param', () => {
    const end = rawHttp();

    expect(isNode(end)).toBe(true);
    expect(end.type).toBe('http');
    expect(end.required).toBe(rawHttpContract);
    expect(end.connection.params).toEqual({ url: string() });
  });

  test('hydrates a client whose fetch resolves the path against the url', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) => new Response(new URL(request.url).pathname + new URL(request.url).search),
    });
    try {
      const client = await rawHttp().connection.hydrate({ url: `${server.url.origin}/base/` });

      expect(client.url).toBe(`${server.url.origin}/base/`);
      expect(await (await client.fetch('items?a=1')).text()).toBe('/base/items?a=1');
      expect(await (await client.fetch('/root')).text()).toBe('/root');
    } finally {
      server.stop(true);
    }
  });
});

describe('Load', () => {
  test('wires an http port into a rawHttp() slot as a dependency edge', () => {
    const graph = Load(
      module('web', ({ provision }) => {
        const docs = provision(provider('docs', { http: rawHttpContract }));
        provision(consumer('gateway', { docs: rawHttp() }), { deps: { docs: docs.http } });
      }),
    );

    expect(graph.edges).toContainEqual({
      from: 'docs',
      to: 'gateway',
      input: 'docs',
      kind: 'dependency',
    });
  });

  test('rejects a bare service ref', () => {
    expect(() =>
      Load(
        module('bad', ({ provision }) => {
          const backend = provision(provider('backend'));
          provision(consumer('gateway', { backend: rawHttp() }), {
            deps: { backend: backend as never },
          });
        }),
      ),
    ).toThrow('do not satisfy');
  });

  test('rejects a port of another kind', () => {
    expect(() =>
      Load(
        module('bad', ({ provision }) => {
          const backend = provision(provider('backend', { db: otherContract }));
          provision(consumer('gateway', { backend: rawHttp() }), {
            deps: { backend: backend.db as never },
          });
        }),
      ),
    ).toThrow('do not satisfy');
  });

  test('keeps the edge when a module forwards an http port', () => {
    const website = module('website', { expose: { http: rawHttpContract } }, ({ provision }) => ({
      http: provision(provider('server', { http: rawHttpContract })).http,
    }));
    const graph = Load(
      module('web', ({ provision }) => {
        const docs = provision(website, { id: 'docs' });
        provision(consumer('gateway', { docs: rawHttp() }), { deps: { docs: docs.http } });
      }),
    );

    expect(graph.edges).toContainEqual({
      from: 'docs.server',
      to: 'gateway',
      input: 'docs',
      kind: 'dependency',
    });
    expect(graph.authoredEdges).toEqual([
      {
        from: { node: 'docs.server', direction: 'out', name: 'http' },
        to: { node: 'docs', direction: 'out', name: 'http' },
      },
      {
        from: { node: 'docs', direction: 'out', name: 'http' },
        to: { node: 'gateway', direction: 'in', name: 'docs' },
      },
    ]);
  });
});

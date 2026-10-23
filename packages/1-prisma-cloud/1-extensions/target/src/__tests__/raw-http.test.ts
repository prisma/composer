/**
 * Raw HTTP connections on Prisma Cloud: a reverse proxy declaring each
 * upstream as a `rawHttp()` dependency exports one communication edge per
 * upstream, with no style, and its lowered config hydrates clients that send
 * real requests. A real service RPC contract, beside it, still exports as
 * request-response.
 */
import { describe, expect, test } from 'bun:test';
import { type DependencyEnd, Load, module } from '@internal/core';
import { buildConfig } from '@internal/core/deploy';
import { type RawHttpClient, rawHttp, rawHttpContract } from '@internal/http';
import { composeApplicationTopology } from '@internal/lowering/builds';
import { contract, rpc } from '@internal/service-rpc';
import { type } from 'arktype';
import { compute } from '../compute.ts';
import { bootstrapService } from '../testing.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const upstreamNames = [
  'site',
  'docs',
  'blog',
  'handbook',
  'eclipse',
  'blogmedia0',
  'blogmedia1',
  'blogmedia2',
  'blogmedia3',
] as const;
type UpstreamName = (typeof upstreamNames)[number];

/** A gateway reverse-proxying five websites and four media shards. */
function webGraph() {
  const gateway = compute({
    name: 'gateway',
    deps: Object.fromEntries(upstreamNames.map((name) => [name, rawHttp()])) as Record<
      UpstreamName,
      DependencyEnd<RawHttpClient, typeof rawHttpContract>
    >,
    build,
  });
  const graph = Load(
    module('web', ({ provision }) => {
      const deps = Object.fromEntries(
        upstreamNames.map((name) => [
          name,
          provision(compute({ name, deps: {}, build, expose: { http: rawHttpContract } })).http,
        ]),
      );
      provision(gateway, { deps: deps as unknown as Record<UpstreamName, typeof rawHttpContract> });
    }),
  );
  return { gateway, graph };
}

describe('raw HTTP connections', () => {
  test('a gateway exports one communication edge per upstream, with no style', () => {
    const { graph } = webGraph();
    const topology = composeApplicationTopology(graph);

    expect(topology.nodes.filter((node) => node.kind === 'service')).toHaveLength(10);
    expect(topology.edges).toHaveLength(9);
    for (const name of upstreamNames) {
      expect(topology.edges).toContainEqual({
        from: { logicalId: `web.${name}`, direction: 'out', name: 'http' },
        to: { logicalId: 'web.gateway', direction: 'in', name },
        family: 'communication',
      });
      expect(topology.ports).toContainEqual({
        logicalId: `web.${name}`,
        direction: 'out',
        name: 'http',
        contractKind: 'http',
      });
    }
  });

  test('an http port forwarded through a module keeps its edges', () => {
    const website = module('website', { expose: { http: rawHttpContract } }, ({ provision }) => ({
      http: provision(
        compute({ name: 'server', deps: {}, build, expose: { http: rawHttpContract } }),
      ).http,
    }));
    const graph = Load(
      module('web', ({ provision }) => {
        const docs = provision(website, { id: 'docs' });
        provision(compute({ name: 'gateway', deps: { docs: rawHttp() }, build }), {
          deps: { docs: docs.http },
        });
      }),
    );

    expect(composeApplicationTopology(graph).edges).toEqual([
      {
        from: { logicalId: 'web.docs.server', direction: 'out', name: 'http' },
        to: { logicalId: 'web.docs', direction: 'out', name: 'http' },
        family: 'communication',
      },
      {
        from: { logicalId: 'web.docs', direction: 'out', name: 'http' },
        to: { logicalId: 'web.gateway', direction: 'in', name: 'docs' },
        family: 'communication',
      },
    ]);
  });

  test("the gateway's lowered config hydrates clients that send real HTTP requests", async () => {
    const upstream = Bun.serve({
      port: 0,
      async fetch(request) {
        return Response.json(
          {
            method: request.method,
            query: new URL(request.url).search,
            cookie: request.headers.get('cookie'),
            body: await request.text(),
          },
          { status: 201, headers: { 'x-upstream': 'site' } },
        );
      },
    });
    try {
      const { gateway, graph } = webGraph();
      const lowered = new Map(
        upstreamNames.map((name) => [
          `web.${name}`,
          { url: name === 'site' ? upstream.url.origin : `https://${name}.example` },
        ]),
      );
      const config = buildConfig(gateway, 'web.gateway', graph, lowered, new Map());
      for (const name of upstreamNames) {
        expect(config.inputs[name]?.['url']).toBe(lowered.get(`web.${name}`)?.url);
      }

      await bootstrapService(gateway, config, async () => {
        const clients = gateway.load();
        for (const name of upstreamNames) {
          expect(clients[name].url).toBe(lowered.get(`web.${name}`)?.url ?? '');
        }
        const response = await clients.site.fetch('/upload?tag=a&tag=b', {
          method: 'POST',
          body: 'original bytes',
          headers: { cookie: 'session=test' },
        });

        expect(response.status).toBe(201);
        expect(response.headers.get('x-upstream')).toBe('site');
        expect(await response.json()).toEqual({
          method: 'POST',
          query: '?tag=a&tag=b',
          cookie: 'session=test',
          body: 'original bytes',
        });
      });
    } finally {
      upstream.stop(true);
    }
  });
});

describe('service RPC beside raw HTTP', () => {
  test('a real service RPC contract exports request-response edges through a module boundary', () => {
    const verifyContract = contract({
      verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
    });
    const identity = module(
      'identity',
      { expose: { verify: verifyContract } },
      ({ provision }) => ({
        verify: provision(
          compute({ name: 'server', deps: {}, build, expose: { verify: verifyContract } }),
        ).verify,
      }),
    );
    const graph = Load(
      module('web', ({ provision }) => {
        const auth = provision(identity, { id: 'auth' });
        provision(compute({ name: 'app', deps: { verify: rpc(verifyContract) }, build }), {
          deps: { verify: auth.verify },
        });
      }),
    );

    expect(composeApplicationTopology(graph).edges).toEqual([
      {
        from: { logicalId: 'web.auth.server', direction: 'out', name: 'verify' },
        to: { logicalId: 'web.auth', direction: 'out', name: 'verify' },
        family: 'communication',
        style: 'request-response',
      },
      {
        from: { logicalId: 'web.auth', direction: 'out', name: 'verify' },
        to: { logicalId: 'web.app', direction: 'in', name: 'verify' },
        family: 'communication',
        style: 'request-response',
      },
    ]);
  });
});

import { describe, expect, test } from 'bun:test';
import { type DependencyEnd, Load, module } from '@internal/core';
import { buildConfig } from '@internal/core/deploy';
import { composeApplicationTopology } from '@internal/lowering/builds';
import { compute } from '../compute.ts';
import { type HttpClient, http, httpContract } from '../http.ts';
import { rawPostgresContract } from '../raw-postgres.ts';
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

/** The real Web shape: a reverse proxy calling five websites and four media shards. */
function webGraph() {
  const gateway = compute({
    name: 'gateway',
    deps: Object.fromEntries(upstreamNames.map((name) => [name, http()])) as Record<
      UpstreamName,
      DependencyEnd<HttpClient, typeof httpContract>
    >,
    build,
  });
  const graph = Load(
    module('web', ({ provision }) => {
      const deps = Object.fromEntries(
        upstreamNames.map((name) => [
          name,
          provision(compute({ name, deps: {}, build, expose: { http: httpContract } })).http,
        ]),
      );
      // fromEntries loses the literal keys; the loop above fills every upstream.
      provision(gateway, { deps: deps as unknown as Record<UpstreamName, typeof httpContract> });
    }),
  );
  return { gateway, graph };
}

describe('HTTP ports', () => {
  test('compares transport kind across independent copies', () => {
    expect(httpContract.satisfies({ ...httpContract })).toBe(true);
    expect(httpContract.satisfies(rawPostgresContract as never)).toBe(false);
    expect(http().required).toBe(httpContract);
  });

  test('refuses a bare service ref and a non-HTTP port at Load', () => {
    for (const expose of [undefined, { db: rawPostgresContract }]) {
      expect(() =>
        Load(
          module('bad', ({ provision }) => {
            const backend = provision(
              compute({
                name: 'backend',
                deps: {},
                build,
                ...(expose === undefined ? {} : { expose }),
              }),
            );
            provision(compute({ name: 'gateway', deps: { backend: http() }, build }), {
              deps: { backend: (expose ? backend['db'] : backend) as never },
            });
          }),
        ),
      ).toThrow('do not satisfy');
    }
  });

  test('retains the original named, untyped dependency', () => {
    const end = http({ name: 'legacy' });
    expect(end.name).toBe('legacy');
    expect(end.required).toBeUndefined();
    const graph = Load(
      module('legacy', ({ provision }) => {
        const backend = provision(compute({ name: 'backend', deps: {}, build }));
        provision(compute({ name: 'gateway', deps: { backend: end }, build }), {
          deps: { backend },
        });
      }),
    );
    expect(graph.edges).toContainEqual({
      from: 'backend',
      to: 'gateway',
      input: 'backend',
      kind: 'dependency',
    });
  });

  test('exports all nine Web proxy connections; gateway is the sole inferred entrypoint', () => {
    const { graph } = webGraph();
    const topology = composeApplicationTopology(graph);
    expect(topology.nodes.filter((node) => node.kind === 'service')).toHaveLength(10);
    expect(topology.edges).toHaveLength(9);
    for (const name of upstreamNames) {
      expect(topology.edges).toContainEqual({
        from: { logicalId: name, direction: 'out', name: 'http' },
        to: { logicalId: 'gateway', direction: 'in', name },
        family: 'communication',
        style: 'request-response',
      });
    }
    // Console infers Internet ingress by excluding service providers of declared edges.
    const providers = new Set(topology.edges.map((edge) => edge.from.logicalId));
    expect(
      topology.nodes
        .filter((node) => node.kind === 'service' && !providers.has(node.logicalId))
        .map((node) => node.logicalId),
    ).toEqual(['gateway']);
  });

  test('keeps HTTP ports and request-response style through module boundaries', () => {
    const website = module('website', { expose: { http: httpContract } }, ({ provision }) => ({
      http: provision(compute({ name: 'server', deps: {}, build, expose: { http: httpContract } }))
        .http,
    }));
    const graph = Load(
      module('web', ({ provision }) => {
        const docs = provision(website, { id: 'docs' });
        provision(compute({ name: 'gateway', deps: { docs: http() }, build }), {
          deps: { docs: docs.http },
        });
      }),
    );
    expect(composeApplicationTopology(graph).edges).toEqual([
      {
        from: { logicalId: 'docs.server', direction: 'out', name: 'http' },
        to: { logicalId: 'docs', direction: 'out', name: 'http' },
        family: 'communication',
        style: 'request-response',
      },
      {
        from: { logicalId: 'docs', direction: 'out', name: 'http' },
        to: { logicalId: 'gateway', direction: 'in', name: 'docs' },
        family: 'communication',
        style: 'request-response',
      },
    ]);
  });

  test('the declared connections lower to runtime clients that send real HTTP requests', async () => {
    const backend = Bun.serve({
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
          name,
          {
            url: name === 'site' ? backend.url.origin : `https://${name}.example`,
          },
        ]),
      );
      const config = buildConfig(gateway, 'gateway', graph, lowered, new Map());
      for (const name of upstreamNames)
        expect(config.inputs[name]?.['url']).toBe(lowered.get(name)?.url);
      await bootstrapService(gateway, config, async () => {
        const clients = gateway.load();
        for (const name of upstreamNames) expect(lowered.get(name)?.url).toBe(clients[name].url);
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
      backend.stop(true);
    }
  });
});

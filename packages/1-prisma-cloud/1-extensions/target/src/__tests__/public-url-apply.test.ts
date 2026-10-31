/** A hostname public URL under the real Alchemy apply engine and the real `Prisma.CustomDomain` provider, against a fake Management API. */
import { describe, expect, mock, test } from 'bun:test';
import * as Prisma from '@alchemy.run/prisma';
import type { CustomDomain } from '@alchemy.run/prisma/Types';
import { Load, module } from '@internal/core';
import type { LowerContext } from '@internal/core/deploy';
import { rawHttpContract } from '@internal/http';
import { runScratch, scratchStack } from '@internal/lowering/scratch-stack';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { compute } from '../compute.ts';
import { publicUrlDescriptor } from '../descriptors/public-url.ts';
import { publicUrl } from '../public-url.ts';

// The provider waits for the hostname's CNAME on its authoritative nameservers before it registers a domain. No nameservers means no wait and no network.
const realDns = await import('node:dns/promises');
mock.module('node:dns/promises', () => ({
  ...realDns,
  resolveNs: () => Promise.reject(new Error('no DNS in this test')),
  resolve4: () => Promise.reject(new Error('no DNS in this test')),
}));

const APP_ID = 'app_1';
const OTHER_APP_ID = 'app_2';
const BRANCH_ID = 'br_default';

interface FakePlatform {
  readonly requests: string[];
  readonly domains: Map<string, CustomDomain>;
  readonly refuse: Set<string>;
}

function customDomain(id: string, hostname: string): CustomDomain {
  return {
    id,
    type: 'custom-domain',
    url: `https://api.prisma.test/v1/domains/${id}`,
    hostname,
    appId: APP_ID,
    status: 'pending_dns',
    foundryStatus: 'pending',
    failureReason: null,
    failureCategory: null,
    certExpiresAt: null,
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    dnsRecords: [],
  };
}

function respond(platform: FakePlatform, method: string, path: string, body: unknown): Response {
  const page = (data: unknown[]) =>
    Response.json({ data, pagination: { hasMore: false, nextCursor: null } });
  if (method === 'GET' && path === `/v1/apps/${APP_ID}/domains`) {
    return page([...platform.domains.values()]);
  }
  if (method === 'GET' && path === `/v1/apps/${APP_ID}`) {
    return Response.json({
      data: {
        id: APP_ID,
        type: 'app',
        url: `https://api.prisma.test/v1/apps/${APP_ID}`,
        name: 'shop.web',
        region: { id: 'eu-west-3', name: 'Paris' },
        projectId: 'proj_1',
        branchId: BRANCH_ID,
        latestDeploymentId: 'dep_1',
        appEndpointDomain: 'https://app_1.cdg.prisma.build',
        createdAt: '2026-10-29T00:00:00.000Z',
      },
    });
  }
  if (method === 'GET' && path === `/v1/branches/${BRANCH_ID}`) {
    return Response.json({
      data: {
        id: BRANCH_ID,
        type: 'branch',
        url: `https://api.prisma.test/v1/branches/${BRANCH_ID}`,
        gitName: 'main',
        isDefault: true,
        role: 'production',
        createdAt: '2026-10-29T00:00:00.000Z',
        updatedAt: '2026-10-29T00:00:00.000Z',
        project: { id: 'proj_1', url: 'https://api.prisma.test/v1/projects/proj_1', name: 'shop' },
      },
    });
  }
  if (method === 'POST' && path === `/v1/apps/${APP_ID}/domains`) {
    const hostname =
      typeof body === 'object' && body !== null && 'hostname' in body ? String(body.hostname) : '';
    if (platform.refuse.has(hostname)) {
      return Response.json(
        {
          error: {
            code: 'domain-ownership-required',
            message: `Publish the TXT record that proves ownership of ${hostname}.`,
          },
        },
        { status: 422 },
      );
    }
    const domain = customDomain(`dom_${platform.domains.size + 1}`, hostname);
    platform.domains.set(domain.id, domain);
    return Response.json({ data: domain }, { status: 201 });
  }
  const id = path.match(/^\/v1\/domains\/([^/]+)$/)?.[1];
  const domain = id === undefined ? undefined : platform.domains.get(id);
  if (method === 'GET' && domain !== undefined) return Response.json({ data: domain });
  if (method === 'DELETE' && id !== undefined) {
    platform.domains.delete(id);
    return new Response(null, { status: 204 });
  }
  return Response.json(
    { error: { code: 'unhandled', message: `${method} ${path}` } },
    { status: 400 },
  );
}

function fakePlatform(refuse: readonly string[]) {
  const platform: FakePlatform = { requests: [], domains: new Map(), refuse: new Set(refuse) };
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const sent = request.body;
      const text = sent._tag === 'Uint8Array' ? new TextDecoder().decode(sent.body) : '';
      platform.requests.push(`${request.method} ${url.pathname}`);
      const response = respond(
        platform,
        request.method,
        url.pathname,
        text ? JSON.parse(text) : undefined,
      );
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  const providers = Layer.effect(Prisma.Providers, Provider.collection([Prisma.CustomDomain])).pipe(
    Layer.provideMerge(Prisma.CustomDomainProvider()),
    Layer.provideMerge(Prisma.PrismaClientLive),
    Layer.provideMerge(
      Layer.succeed(Prisma.PrismaEnvironment, {
        type: 'serviceToken',
        serviceToken: Redacted.make('fake-token'),
        source: { type: 'env' },
        baseUrl: 'https://api.prisma.test',
      }),
    ),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
  );
  return { platform, options: { providers, dev: false } };
}

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};
const web = compute({ name: 'web', deps: {}, build, expose: { http: rawHttpContract } });

/** The public URL's lowering, as core runs it after the target service's deploy. */
function program(hostname: string, serviceId = APP_ID) {
  const graph = Load(
    module('shop', ({ provision }) => {
      const svc = provision(web);
      provision(publicUrl({ name: 'site', url: hostname, target: svc.http }));
    }),
  );
  const site = graph.nodes.find((n) => n.id === 'shop.site');
  const ctx = {
    id: 'shop.site',
    address: 'shop.site',
    node: site?.node,
    graph,
    lowered: new Map([['shop.web', { serviceId, url: `https://${serviceId}.cdg.prisma.build` }]]),
  } as unknown as LowerContext;
  const lowering = publicUrlDescriptor();
  if (lowering.kind !== 'resource') throw new Error('expected a resource descriptor');
  return lowering(ctx) as Effect.Effect<unknown>;
}

function failureText(exit: Exit.Exit<unknown, unknown>): string {
  return Exit.isFailure(exit) ? String(exit.cause) : '';
}

describe('a hostname public URL under the Alchemy apply engine', () => {
  test('a hostname the platform refuses fails the deploy with the upstream error unchanged', async () => {
    const { platform, options } = fakePlatform(['shop.com']);
    const stack = scratchStack(options, 'public-url-refused');

    const exit = await runScratch(Effect.exit(stack.deploy(program('shop.com'))));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureText(exit)).toContain(
      'Prisma Management API request failed (domain-ownership-required)',
    );
    expect(platform.requests).toContain(`POST /v1/apps/${APP_ID}/domains`);
    expect(platform.domains.size).toBe(0);
  });

  test('changing to a hostname the platform refuses fails and never deletes the serving custom domain', async () => {
    const { platform, options } = fakePlatform(['new.shop.com']);
    const stack = scratchStack(options, 'public-url-change');

    const first = await runScratch(Effect.exit(stack.deploy(program('shop.com'))));
    expect(Exit.isSuccess(first)).toBe(true);
    expect([...platform.domains.values()].map((d) => d.hostname)).toEqual(['shop.com']);
    platform.requests.length = 0;

    const second = await runScratch(Effect.exit(stack.deploy(program('new.shop.com'))));

    expect(Exit.isFailure(second)).toBe(true);
    expect(failureText(second)).toContain(
      'Prisma Management API request failed (domain-ownership-required)',
    );
    expect(platform.requests).toContain(`POST /v1/apps/${APP_ID}/domains`);
    expect(platform.requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
    expect([...platform.domains.values()].map((d) => d.hostname)).toEqual(['shop.com']);
  });

  test('changing to a hostname the platform accepts creates the new custom domain, then deletes the old', async () => {
    const { platform, options } = fakePlatform([]);
    const stack = scratchStack(options, 'public-url-replace');

    await runScratch(stack.deploy(program('shop.com')));
    platform.requests.length = 0;
    await runScratch(stack.deploy(program('new.shop.com')));

    const create = platform.requests.indexOf(`POST /v1/apps/${APP_ID}/domains`);
    const remove = platform.requests.indexOf('DELETE /v1/domains/dom_1');
    expect(create).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(create);
    expect([...platform.domains.values()].map((d) => d.hostname)).toEqual(['new.shop.com']);
  });

  test('moving a hostname to another service is refused and leaves the serving custom domain alone', async () => {
    const { platform, options } = fakePlatform([]);
    const stack = scratchStack(options, 'public-url-move');

    await runScratch(stack.deploy(program('shop.com')));
    platform.requests.length = 0;
    const moved = await runScratch(Effect.exit(stack.deploy(program('shop.com', OTHER_APP_ID))));

    expect(Exit.isFailure(moved)).toBe(true);
    expect(failureText(moved)).toContain(
      "Prisma cannot atomically replace custom domain 'shop.com'",
    );
    expect(platform.requests.filter((r) => !r.startsWith('GET'))).toEqual([]);
    expect([...platform.domains.values()].map((d) => [d.hostname, d.appId])).toEqual([
      ['shop.com', APP_ID],
    ]);
  });
});

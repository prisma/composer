/**
 * A deploy cancelled while it creates the app's rows leaves `creating` rows with no recorded ID,
 * while the platform already holds the rows. The next deploy must resume them (ADR-0051), not
 * refuse them as someone else's. Runs the real Alchemy plan engine and the real upstream
 * `Prisma.App` / `Prisma.EnvironmentVariable` providers against a fake Management API.
 */
import { describe, expect, test } from 'bun:test';
import * as Prisma from '@alchemy.run/prisma';
import { Credentials, Retry } from '@distilled.cloud/prisma';
import type { Contract } from '@internal/core';
import type { LowerContext } from '@internal/core/deploy';
import { runScratch, scratchStack } from '@internal/lowering/scratch-stack';
import * as Provider from 'alchemy/Provider';
import { State } from 'alchemy/State';
import { type } from 'arktype';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { compute } from '../compute.ts';
import { computeDescriptor } from '../descriptors/compute.ts';
import type { CloudApplication, ResolvedCloudOptions } from '../descriptors/shared.ts';

const PROJECT_ID = 'proj_1';
const BRANCH_ID = 'br_preview';
const APP_ID = 'app_1';
const VAR_ID = 'var_1';
const VAR_KEY = 'COMPOSER_SHOP_WEB_PORT';
const INSTANCE_ID = '852f6ec2e19b66589825efe14dca2971';

/** The rows the cancelled deploy created before it could record their IDs. */
const createdApp = {
  id: APP_ID,
  type: 'app',
  url: `https://api.prisma.test/v1/services/${APP_ID}`,
  name: 'shop.web',
  region: { id: 'eu-west-3', name: 'Paris' },
  projectId: PROJECT_ID,
  branchId: BRANCH_ID,
  latestDeploymentId: null,
  appEndpointDomain: 'https://app_1.cdg.prisma.build',
  createdAt: '2026-11-13T00:00:00.000Z',
  logicalId: 'shop.web',
};
const createdVariable = {
  id: VAR_ID,
  type: 'environment-variable',
  url: `https://api.prisma.test/v1/environment-variables/${VAR_ID}`,
  projectId: PROJECT_ID,
  branchId: BRANCH_ID,
  class: 'preview',
  key: VAR_KEY,
  valueKid: 'kid_1',
  isManagedBySystem: false,
  createdAt: '2026-11-13T00:00:00.000Z',
  updatedAt: '2026-11-13T00:00:00.000Z',
};

function fakePlatform() {
  const requests: string[] = [];
  const page = (data: unknown[]) =>
    Response.json({ data, pagination: { hasMore: false, nextCursor: null } });
  const respond = (method: string, url: URL): Response => {
    const q = url.searchParams;
    if (method === 'GET' && url.pathname === '/v1/services') {
      const match =
        q.get('projectId') === PROJECT_ID &&
        (q.get('logicalId') ?? createdApp.logicalId) === createdApp.logicalId &&
        (q.get('branchId') ?? BRANCH_ID) === BRANCH_ID;
      return page(match ? [createdApp] : []);
    }
    if (method === 'GET' && url.pathname === '/v1/environment-variables') {
      const match = q.get('projectId') === PROJECT_ID && q.get('key') === VAR_KEY;
      return page(match ? [createdVariable] : []);
    }
    return Response.json(
      { error: { code: 'unhandled', message: `${method} ${url.pathname}` } },
      { status: 400 },
    );
  };
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      return HttpClientResponse.fromWeb(request, respond(request.method, url));
    }),
  );
  const providers = Layer.effect(
    Prisma.Providers,
    Provider.collection([Prisma.App, Prisma.EnvironmentVariable]),
  ).pipe(
    Layer.provideMerge(Prisma.AppProvider()),
    Layer.provideMerge(Prisma.EnvironmentVariableProvider()),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, http),
        Layer.succeed(
          Credentials,
          Effect.succeed({
            apiToken: Redacted.make('fake-token'),
            apiBaseUrl: 'https://api.prisma.test',
          }),
        ),
        Layer.succeed(Retry.Retry, Retry.makeDefault),
      ),
    ),
  );
  return { requests, options: { providers, dev: false } };
}

const portParam = Symbol('interrupted-create-test/port');
const cloudOptions: ResolvedCloudOptions = {
  workspaceId: 'ws_1',
  providerParams: new Map([
    [portParam, { name: 'PORT', schema: type('string'), brand: portParam, value: () => '3000' }],
  ]),
  preflight: { pointerVersion: () => undefined, absentSecrets: new Set() },
};
const application: CloudApplication = {
  projectId: PROJECT_ID,
  branchId: BRANCH_ID,
  defaultBranchId: undefined,
  branchless: false,
};
const anyContract: Contract<'rpc', Record<never, never>> = {
  kind: 'rpc',
  __cmp: {},
  satisfies: () => true,
};
const web = compute({
  name: 'web',
  deps: {},
  build: {
    extension: '@prisma/composer/node',
    type: 'node',
    module: 'file:///test/service.ts',
    entry: 'server.js',
  },
  expose: { any: anyContract },
});

/** Composer's own declarations for the service `shop.web`: its App, then its variables. */
function program() {
  const descriptor = computeDescriptor(() => cloudOptions);
  const graph = { root: { id: 'shop' }, inputBindings: [], edges: [] };
  const ctx = {
    id: 'shop.web',
    address: 'shop.web',
    node: web,
    graph,
    application,
    provisioned: new Map(),
    opts: {},
  } as unknown as LowerContext;
  return Effect.gen(function* () {
    const provisioned = yield* descriptor.provision(ctx);
    yield* descriptor.serialize(ctx, provisioned, { service: {}, inputs: {} });
  }) as Effect.Effect<void>;
}

/** The state a cancelled create leaves: `creating`, with the props it sent and no attributes. */
const creatingRow = (fqn: string, resourceType: string, props: Record<string, unknown>) => ({
  status: 'creating' as const,
  fqn,
  logicalId: fqn,
  instanceId: INSTANCE_ID,
  namespace: undefined,
  resourceType,
  props,
  attr: undefined,
  providerVersion: 0,
  downstream: [],
  bindings: [],
});

const appProps = {
  project: PROJECT_ID,
  displayName: 'shop.web',
  branchId: BRANCH_ID,
  logicalId: 'shop.web',
};
const variableProps = {
  project: PROJECT_ID,
  key: VAR_KEY,
  value: '"3000"',
  class: 'preview',
  branchId: BRANCH_ID,
};

function seed(
  stack: ReturnType<typeof scratchStack>,
  rows: readonly ReturnType<typeof creatingRow>[],
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* yield* State;
      for (const value of rows) {
        yield* state.set({ stack: stack.name, stage: stack.stage, fqn: value.fqn, value });
      }
    }).pipe(Effect.provide(stack.state)),
  );
}

function failureText(exit: Exit.Exit<unknown, unknown>): string {
  return Exit.isFailure(exit) ? String(exit.cause) : '';
}

describe('a deploy cancelled while it created the rows of a service', () => {
  test('without declaring the rows as its own, the next plan refuses them as owned by someone else', async () => {
    const { options } = fakePlatform();
    const stack = scratchStack(options, 'interrupted-unowned');
    await seed(stack, [creatingRow('shop.web', 'Prisma.App', appProps)]);

    // How Composer declared the App before 0.33: no `asOwnRow`.
    const declaredWithoutAdopt = Prisma.App('shop.web', appProps) as unknown as Effect.Effect<void>;
    const exit = await runScratch(Effect.exit(stack.plan(declaredWithoutAdopt)), options);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureText(exit)).toContain("Cannot resume creating resource 'shop.web' (Prisma.App)");
  });

  test('resumes the App and the variable the cancelled deploy created', async () => {
    const { requests, options } = fakePlatform();
    const stack = scratchStack(options, 'interrupted-resume');
    await seed(stack, [
      creatingRow('shop.web', 'Prisma.App', appProps),
      creatingRow(`shop.web.env.${VAR_KEY}`, 'Prisma.EnvironmentVariable', variableProps),
    ]);

    const exit = await runScratch(Effect.exit(stack.plan(program())), options);

    expect(failureText(exit)).toBe('');
    if (!Exit.isSuccess(exit)) return;
    const app = exit.value.resources['shop.web'];
    const variable = exit.value.resources[`shop.web.env.${VAR_KEY}`];
    // The plan carries the row it found, so apply reconciles that row instead of creating another.
    expect((app?.state as { attr?: { appId?: string } } | undefined)?.attr?.appId).toBe(APP_ID);
    expect(
      (variable?.state as { attr?: { environmentVariableId?: string } } | undefined)?.attr
        ?.environmentVariableId,
    ).toBe(VAR_ID);
    expect(requests.filter((r) => !r.startsWith('GET'))).toEqual([]);
  });

  test('resumes rows a 0.30-era deploy left under their legacy resource IDs', async () => {
    const { options } = fakePlatform();
    const stack = scratchStack(options, 'interrupted-legacy');
    // `web-svc` and `COMPOSER_WEB_PORT-var` are the IDs Composer used before addresses carried the app name.
    await seed(stack, [
      creatingRow('web-svc', 'Prisma.App', appProps),
      creatingRow('COMPOSER_WEB_PORT-var', 'Prisma.EnvironmentVariable', variableProps),
    ]);

    const exit = await runScratch(Effect.exit(stack.plan(program())), options);

    expect(failureText(exit)).toBe('');
    if (!Exit.isSuccess(exit)) return;
    const app = exit.value.resources['shop.web'];
    const variable = exit.value.resources[`shop.web.env.${VAR_KEY}`];
    expect(app?.renamedFrom).toEqual(['web-svc']);
    expect(variable?.renamedFrom).toEqual(['COMPOSER_WEB_PORT-var']);
    expect((app?.state as { attr?: { appId?: string } } | undefined)?.attr?.appId).toBe(APP_ID);
    expect(
      (variable?.state as { attr?: { environmentVariableId?: string } } | undefined)?.attr
        ?.environmentVariableId,
    ).toBe(VAR_ID);
  });
});

import { describe, expect, test } from 'bun:test';
import type { BuildResourceAction, BuildResourceType, BuildsApi } from '../builds/api.ts';
import { reportableResource, resourceReporter } from '../builds/resources.ts';

const state = (over: Record<string, unknown>) => ({
  resourceType: 'Prisma.Database',
  status: 'created',
  attr: { id: 'db_1' },
  ...over,
});

interface Reported {
  buildId: string;
  type: BuildResourceType;
  id: string;
  action: BuildResourceAction;
}

function fakeApi(): { api: BuildsApi; reported: Reported[]; settle: () => void } {
  const reported: Reported[] = [];
  const pending: (() => void)[] = [];
  return {
    reported,
    settle: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
    api: {
      create: async () => undefined,
      update: async () => true,
      reportResource: (buildId, type, id, action) => {
        reported.push({ buildId, type, id, action });
        return new Promise<boolean>((resolve) => pending.push(() => resolve(true)));
      },
    },
  };
}

describe('reportableResource', () => {
  test('maps each Prisma Cloud resource onto its platform type', () => {
    const cases: readonly [string, string, BuildResourceType][] = [
      ['Prisma.Project', 'id', 'project'],
      ['Prisma.Database', 'id', 'database'],
      ['Prisma.Connection', 'id', 'service_key'],
      ['Prisma.Bucket', 'id', 'bucket'],
      ['Prisma.ComputeService', 'id', 'app'],
      ['Prisma.EnvironmentVariable', 'id', 'config_variable'],
    ];

    for (const [resourceType, idField, expected] of cases) {
      expect(reportableResource(state({ resourceType, attr: { [idField]: 'x_1' } }))).toEqual({
        type: expected,
        id: 'x_1',
        action: 'created',
      });
    }
  });

  test('a deployment keys its platform id as deploymentId, not id', () => {
    expect(
      reportableResource(
        state({ resourceType: 'Prisma.Deployment', attr: { deploymentId: 'dep_1' } }),
      ),
    ).toEqual({ type: 'deployment', id: 'dep_1', action: 'created' });

    // An `id` on a deployment is some other identifier and must not be reported as one.
    expect(
      reportableResource(state({ resourceType: 'Prisma.Deployment', attr: { id: 'wrong' } })),
    ).toBeUndefined();
  });

  test('a reconcile that changed nothing is still an action on the resource', () => {
    expect(reportableResource(state({ status: 'updated' }))?.action).toBe('acted_on');
  });

  test('a resource being removed is reported as deleted', () => {
    expect(reportableResource(state({ status: 'deleting' }))?.action).toBe('deleted');
  });

  test('an in-progress status is not reported — the terminal write follows it', () => {
    for (const status of ['creating', 'updating', 'replacing', 'replaced']) {
      expect(reportableResource(state({ status }))).toBeUndefined();
    }
  });

  test('an adopted resource is not reported: this run resolved it, it did not act on it', () => {
    expect(reportableResource(state({ status: 'updated', adopting: true }))).toBeUndefined();
  });

  test('resources with no platform type are not reported', () => {
    for (const resourceType of ['Prisma.BucketKey', 'PrismaCloud.ServiceKey', 'PgWarm']) {
      expect(reportableResource(state({ resourceType }))).toBeUndefined();
    }
  });

  test('tasks, malformed records, and missing ids are not reported', () => {
    expect(reportableResource(state({ kind: 'action' }))).toBeUndefined();
    expect(reportableResource(state({ attr: undefined }))).toBeUndefined();
    expect(reportableResource(state({ attr: { id: '' } }))).toBeUndefined();
    expect(reportableResource(state({ resourceType: 42 }))).toBeUndefined();
    expect(reportableResource(undefined)).toBeUndefined();
    expect(reportableResource('nonsense')).toBeUndefined();
  });
});

describe('resourceReporter', () => {
  test('reports each resource once, however often its state is written', () => {
    const { api, reported, settle } = fakeApi();
    const reporter = resourceReporter(api, 'bld_1');

    reporter.observe(state({}));
    reporter.observe(state({}));
    reporter.observe(state({ status: 'updated' }));

    settle();
    expect(reported).toEqual([
      { buildId: 'bld_1', type: 'database', id: 'db_1', action: 'created' },
      // A different action on the same resource is a different claim, so it is sent.
      { buildId: 'bld_1', type: 'database', id: 'db_1', action: 'acted_on' },
    ]);
  });

  test('observing does not wait for the report — an apply never blocks on the Console', () => {
    const { api, reported, settle } = fakeApi();
    const reporter = resourceReporter(api, 'bld_1');

    reporter.observe(state({}));
    // The request is already away while nothing has resolved it.
    expect(reported).toHaveLength(1);
    settle();
  });

  test('drain waits for every report already started', async () => {
    const { api, settle } = fakeApi();
    const reporter = resourceReporter(api, 'bld_1');

    reporter.observe(state({}));
    let drained = false;
    const draining = reporter.drain().then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(drained).toBe(false);

    settle();
    await draining;
    expect(drained).toBe(true);
  });

  test('a report that fails does not make drain reject', async () => {
    const failing: BuildsApi = {
      create: async () => undefined,
      update: async () => true,
      reportResource: () => Promise.reject(new Error('platform is down')),
    };
    const reporter = resourceReporter(failing, 'bld_1');

    reporter.observe(state({}));
    await reporter.drain();
  });
});

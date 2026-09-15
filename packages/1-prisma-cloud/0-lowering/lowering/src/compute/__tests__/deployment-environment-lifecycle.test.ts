import { expect, test } from 'bun:test';
import * as Output from 'alchemy/Output';
import * as Prisma from 'alchemy/Prisma';
import * as Provider from 'alchemy/Provider';
import { inMemoryState } from 'alchemy/State/InMemoryState';
import * as Core from 'alchemy/Test/Core';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { appAfterEnvironment } from '../deployment-edge.ts';

const scenarios: {
  name: string;
  input: string;
  addVariable?: boolean;
  repairDrift?: boolean;
  failUpdate?: boolean;
}[] = [
  { name: 'changed existing input', input: '{"required":"new"}' },
  { name: 'new required field', input: '{"required":"old","added":"new"}' },
  { name: 'unchanged input repaired after drift', input: '{"required":"old"}', repairDrift: true },
  { name: 'changed, unchanged, and new variables', input: '{"required":"new"}', addVariable: true },
  { name: 'failed input update', input: '{"required":"new"}', failUpdate: true },
];

test.each(scenarios)(
  'deployment snapshots completed environment writes: $name',
  async ({ input, addVariable = false, repairDrift = false, failUpdate = false }) => {
    const variables = new Map<string, Prisma.Types.EnvironmentVariable>();
    const values = new Map<string, string>();
    const deployments = new Map<string, Prisma.Types.Deployment>();
    const snapshots: Record<string, string>[] = [];
    const events: string[] = [];
    const updateStarted = Deferred.makeUnsafe<void>();
    const releaseUpdate = Deferred.makeUnsafe<void>();
    let generation = 0;

    const client = {
      listEnvironmentVariables: ({ key } = {}) =>
        Effect.sync(() =>
          [...variables.values()].filter((variable) => !key || variable.key === key),
        ),
      getEnvironmentVariable: (id) => Effect.sync(() => variables.get(id)!),
      createEnvironmentVariable: (props) =>
        Effect.sync(() => {
          const variable: Prisma.Types.EnvironmentVariable = {
            id: `var-${props.key}`,
            type: 'environment-variable',
            url: `https://api.example.test/environment-variables/${props.key}`,
            projectId: props.projectId,
            branchId: props.branchId ?? null,
            class: props.class,
            key: props.key,
            valueKid: 'test-key',
            isManagedBySystem: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          };
          variables.set(variable.id, variable);
          values.set(variable.key, props.value);
          events.push(`write:${variable.key}`);
          return variable;
        }),
      updateEnvironmentVariable: (id, props) =>
        Effect.gen(function* () {
          const variable = variables.get(id)!;
          if (variable.key === 'COMPOSER_INPUT') {
            events.push('input-update-started');
            yield* Deferred.succeed(updateStarted, undefined);
            yield* Deferred.await(releaseUpdate);
            if (failUpdate) {
              events.push('input-update-failed');
              return yield* Effect.die(new Error('input update failed'));
            }
          }
          const updated = { ...variable, updatedAt: '2026-01-02T00:00:00.000Z' };
          variables.set(id, updated);
          values.set(variable.key, props.value);
          events.push(`write:${variable.key}`);
          return updated;
        }),
      listAppDeployments: () => Effect.sync(() => [...deployments.values()]),
      getDeployment: (id) => Effect.sync(() => deployments.get(id)!),
      createAppDeployment: () =>
        Effect.sync(() => {
          const id = `deployment-${++generation}`;
          const deployment: Prisma.Types.Deployment = {
            id,
            type: 'deployment',
            url: `https://api.example.test/deployments/${id}`,
            foundryVersionId: `version-${generation}`,
            status: 'new',
            previewDomain: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          };
          deployments.set(id, deployment);
          snapshots.push(Object.fromEntries(values));
          events.push('deployment-snapshot');
          return { ...deployment, uploadUrl: null };
        }),
      deleteDeployment: (id) =>
        Effect.sync(() => {
          events.push(`delete:${id}`);
          deployments.delete(id);
        }),
    } satisfies Pick<
      Prisma.PrismaManagementClient,
      | 'listEnvironmentVariables'
      | 'getEnvironmentVariable'
      | 'createEnvironmentVariable'
      | 'updateEnvironmentVariable'
      | 'listAppDeployments'
      | 'getDeployment'
      | 'createAppDeployment'
      | 'deleteDeployment'
    >;

    const providers = Layer.effect(
      Prisma.Providers,
      Provider.collection([Prisma.EnvironmentVariable, Prisma.Deployment]),
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(Prisma.EnvironmentVariableProvider(), Prisma.DeploymentProvider()),
      ),
      Layer.provide(
        Layer.succeed(Prisma.PrismaClient, client as unknown as Prisma.PrismaManagementClient),
      ),
    );
    const options = { providers, state: inMemoryState(), dev: false };
    const stack = Core.scratchStack(options, 'deployment-input-order');

    const program = (inputValue: string, release: number, includeNewVariable: boolean) =>
      Effect.gen(function* () {
        const desired = {
          COMPOSER_INPUT: inputValue,
          UNCHANGED: 'keep-me',
          ...(includeNewVariable ? { NEW_VARIABLE: 'new-value' } : {}),
        };
        const environment: Prisma.EnvironmentVariable[] = [];
        for (const [key, value] of Object.entries(desired)) {
          environment.push(
            yield* Prisma.EnvironmentVariable(key, {
              project: 'project-1',
              class: 'preview',
              branchId: 'branch-1',
              key,
              value: Redacted.make(value),
            }),
          );
        }
        const deployment = yield* Prisma.Deployment('deployment', {
          app: appAfterEnvironment(Output.asOutput('app-1'), environment),
          skipCodeUpload: true,
          start: false,
          // Environment values alone must replace the deployment. The drift case
          // models a separate replacement reason while the desired input is unchanged.
          triggers: {
            ...Object.fromEntries(
              Object.entries(desired).map(([key, value]) => [key, Redacted.make(value)]),
            ),
            ...(repairDrift ? { release } : {}),
          },
        });
        return { deployment };
      });

    await Core.run(
      Effect.gen(function* () {
        yield* stack.deploy(program('{"required":"old"}', 1, false));
        if (repairDrift) values.set('COMPOSER_INPUT', 'out-of-band-drift');
        events.length = 0;

        const plan = yield* stack.plan(program(input, 2, addVariable));
        const deploymentPlan = plan.resources['deployment']!;
        expect(deploymentPlan.action).toBe('replace');
        if (deploymentPlan.action !== 'replace') throw new Error('Expected deployment replacement');
        expect(plan.resources['COMPOSER_INPUT']!.action).toBe('update');
        expect(plan.resources['UNCHANGED']!.action).toBe('update');
        if (addVariable) expect(plan.resources['NEW_VARIABLE']!.action).toBe('create');

        const deploymentFiber = yield* Effect.forkChild(
          stack.deploy(program(input, 2, addVariable)),
        );
        yield* Deferred.await(updateStarted);

        expect(snapshots).toHaveLength(1);
        expect(deployments.has('deployment-1')).toBe(true);

        yield* Deferred.succeed(releaseUpdate, undefined);
        const result = yield* Effect.exit(Fiber.join(deploymentFiber));

        if (failUpdate) {
          expect(Exit.isFailure(result)).toBe(true);
          expect(events).toContain('input-update-failed');
          expect(snapshots).toHaveLength(1);
          expect([...deployments.keys()]).toEqual(['deployment-1']);
          expect(events.some((event) => event.startsWith('delete:'))).toBe(false);
          return;
        }

        expect(Exit.isSuccess(result)).toBe(true);
        expect(snapshots).toHaveLength(2);

        expect(snapshots[1]).toEqual({
          COMPOSER_INPUT: input,
          UNCHANGED: 'keep-me',
          ...(addVariable ? { NEW_VARIABLE: 'new-value' } : {}),
        });
        expect(Object.keys(Output.upstreamAny(deploymentPlan.props)).sort()).toEqual(
          ['COMPOSER_INPUT', 'UNCHANGED', ...(addVariable ? ['NEW_VARIABLE'] : [])].sort(),
        );
        expect(events.indexOf('input-update-started')).toBeLessThan(
          events.indexOf('write:COMPOSER_INPUT'),
        );
        for (const key of [
          'COMPOSER_INPUT',
          'UNCHANGED',
          ...(addVariable ? ['NEW_VARIABLE'] : []),
        ]) {
          expect(events).toContain(`write:${key}`);
          expect(events.indexOf(`write:${key}`)).toBeLessThan(
            events.indexOf('deployment-snapshot'),
          );
        }

        yield* stack.deploy(program(input, 2, addVariable));
        expect(snapshots).toHaveLength(2);
      }),
      options,
    );
  },
);

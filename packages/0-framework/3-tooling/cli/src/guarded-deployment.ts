import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type {
  DeploymentScope,
  DestructiveChange,
  DestructivePlan,
  PrismaAppConfig,
} from '@internal/core/config';
import { deserializeContainers } from '@internal/core/config';
import * as Stacks from 'alchemy/Alchemist/routes/stack';
import { AlchemyContextLive } from 'alchemy/AlchemyContext';
import { CredentialsStoreLive } from 'alchemy/Auth/Credentials';
import { ProfileStoreLive } from 'alchemy/Auth/Profile';
import { layerNonInteractive } from 'alchemy/Interaction';
import * as Output from 'alchemy/Output';
import type * as Plan from 'alchemy/Plan';
import { Progress } from 'alchemy/Report';
import { isResource } from 'alchemy/Resource';
import { PlatformServices, runMain } from 'alchemy/Util/PlatformServices';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Redacted from 'effect/Redacted';

/** Canonicalize persisted data and plan inputs without exposing them in the approval report. */
function fingerprint(value: unknown, ancestors = new Set<object>()): string {
  if (Output.isExpr(value)) return fingerprint(Reflect.get(value, Output.ExprSymbol), ancestors);
  if (isResource(value)) return fingerprint({ resource: value.FQN, type: value.Type }, ancestors);
  if (Redacted.isRedacted(value)) return fingerprint(Redacted.value(value), ancestors);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'function') return String(value);
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? String(value);
  if (ancestors.has(value)) return '[cycle]';
  ancestors.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => fingerprint(item, ancestors)).join(',')}]`
    : `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${fingerprint(Reflect.get(value, key), ancestors)}`)
        .join(',')}}`;
  ancestors.delete(value);
  return result;
}

/** One approval covers the destructive actions, their prior state, and their resolved target. */
export function destructivePlan(
  plan: Plan.Plan,
  scopes: readonly DeploymentScope[],
  safeReplacementTypes: readonly string[],
  target: { readonly name: string; readonly stage: string },
): DestructivePlan | undefined {
  const nodes = [...Object.values(plan.resources), ...Object.values(plan.deletions)]
    .filter((node) => node !== undefined)
    .sort((a, b) => a.resource.FQN.localeCompare(b.resource.FQN));
  const changes: DestructiveChange[] = [];
  for (const node of nodes) {
    const deleting = node.action === 'delete' || node.action === 'orphaned';
    const replacing =
      node.action === 'replace' ||
      node.state?.status === 'replacing' ||
      node.state?.status === 'replaced';
    if (!deleting && !replacing) continue;
    if (!deleting && safeReplacementTypes.includes(node.resource.Type)) continue;
    const hostname = node.state?.props?.['hostname'];
    changes.push({
      resource: node.resource.FQN,
      type: node.resource.Type,
      action: deleting ? 'delete' : 'replace',
      consequence:
        typeof hostname === 'string'
          ? `Disconnect ${hostname}; traffic to this hostname can stop.`
          : 'Remove this resource and any platform-owned children, including data and domain bindings managed outside Composer.',
    });
  }
  if (plan.destroy) {
    for (const scope of scopes)
      changes.push({
        resource: scope.id,
        type: 'deployment-container',
        action: 'delete',
        consequence: scope.removalConsequence,
      });
  }
  if (changes.length === 0) return undefined;
  const hash = createHash('sha256')
    .update(
      fingerprint({
        target,
        scopes,
        changes,
        destroy: plan.destroy ?? false,
        nodes: nodes.map((node) => ({
          resource: node.resource.FQN,
          type: node.resource.Type,
          action: node.action,
          state: node.state,
          ...('props' in node ? { props: node.props } : {}),
        })),
      }),
    )
    .digest('hex');
  return { token: `remove-${hash}`, scopes, changes };
}

/** Apply the same in-memory snapshot that was checked; no resource mutation precedes approval. */
export function applyGuardedPlan<A>(
  snapshot: Stacks.PlanSnapshot<A>,
  options: {
    readonly scopes: readonly DeploymentScope[];
    readonly safeReplacementTypes: readonly string[];
    readonly approval?: string | undefined;
    readonly onRefused: (plan: DestructivePlan) => void;
  },
) {
  return Effect.gen(function* () {
    const plan = destructivePlan(
      snapshot.native,
      options.scopes,
      options.safeReplacementTypes,
      snapshot.stack,
    );
    if (plan !== undefined && plan.token !== options.approval) {
      options.onRefused(plan);
      return false;
    }
    yield* Stacks.apply(snapshot);
    return true;
  });
}

/** Entry point for Composer's guarded deploy child. Alchemy still owns planning and resource lifecycle. */
export function runDeployment(options: {
  readonly entrypoint: string;
  readonly stage: string;
  readonly operation: 'deploy' | 'destroy';
  readonly config: PrismaAppConfig;
  readonly planFile: string;
  readonly approval?: string | undefined;
}): void {
  const program = Effect.gen(function* () {
    const snapshot = yield* Stacks.plan({
      target: { entrypoint: options.entrypoint, stage: options.stage },
      operation: options.operation,
      updateStateStore: true,
    });
    const containers = deserializeContainers(options.config.extensions, process.env);
    const scopes: DeploymentScope[] = [];
    const safeReplacementTypes: string[] = [];
    for (const extension of options.config.extensions) {
      safeReplacementTypes.push(...(extension.deploymentSafety?.safeReplacementTypes ?? []));
    }
    if (
      snapshot.native.destroy ||
      destructivePlan(snapshot.native, [], safeReplacementTypes, snapshot.stack) !== undefined
    ) {
      for (const extension of options.config.extensions) {
        const safety = extension.deploymentSafety;
        const container = containers.get(extension.id);
        if (safety !== undefined)
          scopes.push(yield* Effect.promise(() => safety.describe(container)));
        else if (container !== undefined)
          scopes.push({
            id: `${extension.id}/${container.alchemyStage ?? options.stage}`,
            label: `${extension.id}: ${container.alchemyStage ?? options.stage}`,
            removalConsequence:
              'Delete this deployment container and every resource it contains, including resources managed outside Composer.',
          });
      }
    }
    const applied = yield* applyGuardedPlan(snapshot, {
      scopes,
      safeReplacementTypes,
      approval: options.approval,
      onRefused: (plan) =>
        fs.writeFileSync(options.planFile, JSON.stringify(plan), { mode: 0o600 }),
    });
    if (!applied) process.exitCode = 42;
  });
  runMain(
    program.pipe(
      Effect.provide(layerNonInteractive({ stdout: process.stderr })),
      Effect.provideService(Progress, (event) =>
        Effect.sync(() => {
          if (event._tag === 'apply.resource.status') {
            console.error(`${event.status} ${event.type} ${event.fqn}`);
          }
        }),
      ),
      Effect.provide(AlchemyContextLive),
      Effect.provide(ProfileStoreLive),
      Effect.provide(CredentialsStoreLive),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
      Effect.scoped,
    ),
  );
}

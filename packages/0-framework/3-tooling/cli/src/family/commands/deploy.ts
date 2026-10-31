/**
 * `deploy` — a result command that runs Alchemy's plan and apply in this
 * process and reports its progress as step events.
 *
 * `--production` is gone. It was accepted and then always errored ("only
 * valid with destroy"), so no invocation using it could ever have succeeded;
 * deploy targets the environment production when no `--environment` is given.
 */
import { CliStructuredError } from '@internal/foundation/errors';
import type { EngineEvent } from '@prisma/cli-engine';
import { defineCommand, flag, SERVICE_TOKEN_ENV_VAR } from '@prisma/cli-engine';
import { notOk, ok } from '@prisma/cli-engine/protocol';
import {
  DEFAULT_DEPLOY_ENVIRONMENT,
  type DeployEvent,
  type DeployStep,
} from '../../operations/deploy.ts';
import { dataLine } from '../data-lines.ts';
import type { ComposerOperations } from '../family.ts';
import { composerSection } from '../section.ts';
import { toEngineError } from '../translate-error.ts';
import { workspaceIdOf } from '../workspace.ts';

const STEP_LABELS = {
  prepare: 'load config and app',
  assemble: 'assemble services',
  connect: 'connect to project and branch',
  preflight: 'check environment variables',
  apply: 'plan and apply',
  record: 'record result',
} as const;

function stepLabel(step: DeployStep): string {
  switch (step.name) {
    case 'assemble-service':
      return `assemble ${step.address}`;
    case 'apply-resource':
      return `${step.status} ${step.fqn}`;
    default:
      return STEP_LABELS[step.name];
  }
}

function stepId(step: DeployStep): string {
  switch (step.name) {
    case 'assemble-service':
      return `deploy.assemble.${step.address}`;
    case 'apply-resource':
      return `deploy.apply.${step.fqn}`;
    default:
      return `deploy.${step.name}`;
  }
}

function parentId(step: DeployStep): string | undefined {
  switch (step.name) {
    case 'assemble-service':
      return 'deploy.assemble';
    case 'apply-resource':
      return 'deploy.apply';
    default:
      return undefined;
  }
}

/** `850ms`, `12.3s`, `9m 35s`. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
}

/** The operation's step events as engine events. The engine prints only `step`, so a finished step carries its duration in the text too. */
function toEngineEvent(event: DeployEvent): EngineEvent {
  if (event.kind === 'message') {
    return { kind: 'message', severity: event.severity, text: event.text };
  }
  const id = stepId(event.step);
  if (event.kind === 'step-started') {
    const parent = parentId(event.step);
    return {
      kind: 'step-started',
      step: stepLabel(event.step),
      id,
      ...(parent === undefined ? {} : { parentId: parent }),
      ...(event.step.name === 'apply-resource'
        ? { data: { resourceType: event.step.resourceType } }
        : {}),
    };
  }
  return {
    kind: 'step-finished',
    step: `${stepLabel(event.step)} (${formatDuration(event.durationMs)})`,
    id,
    outcome: event.outcome,
    data: { ...event.data, durationMs: event.durationMs },
  };
}

export const createDeployCommand = (operations: ComposerOperations) =>
  defineCommand({
    help: {
      summary: "Deploy the application whose root node is the entry module's default export.",
      examples: [
        '{bin} deploy',
        '{bin} deploy --environment staging',
        '{bin} deploy --entry other-module.ts',
      ],
    },
    args: {
      flags: {
        entry: flag.string({
          brief:
            'The file whose default export is the application root module, built with ' +
            'module(...). Overrides `entry` in the `composer` section of prisma.config.ts.',
          placeholder: 'path',
        }),
        name: flag.string({
          brief:
            'Deploy the app under this name instead of the name its root module declares. A ' +
            'different name is a separate app on Prisma Cloud, with its own services, databases ' +
            "and buckets (default: the root module's name).",
          placeholder: 'name',
        }),
        environment: flag.string({
          brief:
            'The environment to deploy to. Any name other than production is a complete, ' +
            'isolated copy of the app, such as staging or one per pull request.',
          placeholder: 'name',
          default: DEFAULT_DEPLOY_ENVIRONMENT,
        }),
        report: flag.string({
          brief:
            "Write the deploy's outcome as JSON to this path — resources, preview URLs, and " +
            'the failure cause. Also settable as PRISMA_COMPOSER_REPORT_FILE.',
          placeholder: 'path',
        }),
        // Named for what a user reads in their target's console — a build —
        // not for this CLI's own `build` (a service's build adapter,
        // ADR-0005). Nothing else on this surface takes a build id.
        buildId: flag.string({
          brief:
            'Join the deploy record your CI already created rather than letting the target ' +
            'create one. Each target also reads its own environment variable for this; the ' +
            'flag wins.',
          placeholder: 'id',
        }),
      },
    },
    needs: { config: composerSection, credentials: true },
    handler: async (args, ctx) => {
      const token = ctx.env[SERVICE_TOKEN_ENV_VAR];
      if (token === undefined || token.length === 0) {
        return notOk(toEngineError(serviceTokenRequired()));
      }
      const workspaceId = await workspaceIdOf(ctx);
      const result = await operations.deploy(
        {
          entry: args.flags.entry,
          config: ctx.config,
          name: args.flags.name,
          environment: args.flags.environment,
          cwd: ctx.cwd,
          reportPath: args.flags.report,
          reportId: args.flags.buildId,
          onEvent: (event) => ctx.report(toEngineEvent(event)),
          signal: ctx.signal,
        },
        {
          credentials: { workspaceId, client: ctx.api },
          convergeEnv: {
            [SERVICE_TOKEN_ENV_VAR]: token,
            ...(workspaceId === undefined ? {} : { PRISMA_WORKSPACE_ID: workspaceId }),
          },
        },
      );
      if (!result.ok) return notOk(toEngineError(result.failure));

      const { summary, durationMs } = result.value;
      const target = `to ${args.flags.environment ?? DEFAULT_DEPLOY_ENVIRONMENT} in ${formatDuration(durationMs)}`;
      for (const node of summary?.nodes ?? []) {
        for (const entity of node.entities) {
          if (entity.url !== undefined) {
            ctx.report({ kind: 'endpoint', name: node.address, url: entity.url });
          }
        }
      }
      return ok(
        ctx.present(
          { data: { summary: summary ?? null, durationMs } },
          {
            human: (ui) =>
              summary === undefined
                ? [{ kind: 'summary', status: 'ok', text: `Deployed ${target}.` }]
                : [
                    {
                      kind: 'summary',
                      status: 'ok',
                      text: `Deployed ${ui.emphasize(summary.app)} ${target}.`,
                    },
                    {
                      kind: 'table',
                      columns: ['Address', 'Deployed'],
                      rows: summary.nodes.map((node) => [
                        node.address,
                        node.entities.map((entity) => `${entity.kind} ${entity.id}`).join(', '),
                      ]),
                    },
                  ],
            stdout: () =>
              (summary?.nodes ?? []).flatMap((node) =>
                node.entities.map((entity) =>
                  dataLine([node.address, entity.kind, entity.id, entity.url]),
                ),
              ),
            json: () => ({ summary: summary ?? null, durationMs }),
            next: () => [],
          },
        ),
      );
    },
  });

/**
 * Alchemy runs in this process and reads its Prisma credential only from the
 * environment, and the engine gives a command no way to read a `prisma login`
 * session's token. So deploy needs the service token in the environment.
 */
function serviceTokenRequired(): CliStructuredError {
  return new CliStructuredError(
    'DEPLOY.SERVICE_TOKEN_REQUIRED',
    `\`prisma deploy\` needs ${SERVICE_TOKEN_ENV_VAR} in the environment.`,
    {
      why: 'Alchemy applies the deploy in this process and reads its Prisma credential from the environment. A `prisma login` session cannot reach it yet.',
      fix: `Create a service token for the workspace in the Prisma Console and set ${SERVICE_TOKEN_ENV_VAR} to it, then deploy again.`,
    },
  );
}

/**
 * `deploy` — a result command that hands the terminal to alchemy.
 *
 * `--production` is gone. It was accepted and then always errored ("only
 * valid with destroy"), so no invocation using it could ever have succeeded;
 * deploy targets production by default when no `--stage` is given.
 */
import type { EngineEvent } from '@prisma/cli-engine';
import { defineCommand, flag } from '@prisma/cli-engine';
import type { DeployEvent, DeployStep } from '../../operations/deploy.ts';
import { convergeSpawn, operationDeps, settleConverge } from '../converge.ts';
import { dataLine } from '../data-lines.ts';
import type { ComposerOperations } from '../family.ts';
import { composerSection } from '../section.ts';
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
  return step.name === 'assemble-service' ? `assemble ${step.address}` : STEP_LABELS[step.name];
}

function stepId(step: DeployStep): string {
  return step.name === 'assemble-service'
    ? `deploy.assemble.${step.address}`
    : `deploy.${step.name}`;
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
  const id = stepId(event.step);
  if (event.kind === 'step-started') {
    return {
      kind: 'step-started',
      step: stepLabel(event.step),
      id,
      ...(event.step.name === 'assemble-service' ? { parentId: 'deploy.assemble' } : {}),
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
        '{bin} deploy --stage feat-auth',
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
        stage: flag.string({
          brief:
            'Deploy a complete, isolated copy of the app under this name instead of production, ' +
            'such as staging or one per pull request (default: production).',
          placeholder: 'stage',
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
    needs: { config: composerSection, credentials: 'child' },
    maySpawn: true,
    handler: async (args, ctx) => {
      const alchemy = convergeSpawn(ctx);
      const result = await operations.deploy(
        {
          entry: args.flags.entry,
          config: ctx.config,
          name: args.flags.name,
          stage: args.flags.stage,
          cwd: ctx.cwd,
          reportPath: args.flags.report,
          reportId: args.flags.buildId,
          onEvent: (event) => ctx.report(toEngineEvent(event)),
        },
        operationDeps({
          alchemy,
          workspaceId: await workspaceIdOf(ctx),
          client: ctx.api,
        }),
      );

      return settleConverge(result, ctx, ({ summary, durationMs }) => {
        const target = `to ${args.flags.stage ?? 'production'} in ${formatDuration(durationMs)}`;
        for (const node of summary?.nodes ?? []) {
          for (const entity of node.entities) {
            if (entity.url !== undefined) {
              ctx.report({ kind: 'endpoint', name: node.address, url: entity.url });
            }
          }
        }
        return ctx.present(
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
        );
      });
    },
  });

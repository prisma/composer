/**
 * `deploy <entry>` — a result command that hands the terminal to alchemy.
 *
 * `--production` is gone. It was accepted and then always errored ("only
 * valid with destroy"), so no invocation using it could ever have succeeded;
 * deploy targets production by default when no `--stage` is given.
 */
import { defineCommand, flag, positional } from '@prisma/cli-engine';
import { convergeSpawn, operationDeps, settleConverge } from '../converge.ts';
import type { ComposerOperations } from '../family.ts';
import { composerSection } from '../section.ts';
import { workspaceIdOf } from '../workspace.ts';

export const createDeployCommand = (operations: ComposerOperations) =>
  defineCommand({
    help: {
      summary: "Deploy the application whose root node is <entry>'s default export.",
      examples: ['{bin} deploy src/service.ts', '{bin} deploy src/service.ts --stage feat-auth'],
    },
    args: {
      positionals: {
        entry: positional.string({
          brief: 'The module whose default export is the application root.',
          placeholder: 'entry',
        }),
      },
      flags: {
        name: flag.string({
          brief: "Override the root node's name — the deploy's application name.",
          placeholder: 'name',
        }),
        stage: flag.string({
          brief: 'Deploy scope to target; omit for production.',
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
          entry: args.positionals.entry,
          name: args.flags.name,
          stage: args.flags.stage,
          cwd: ctx.cwd,
          reportPath: args.flags.report,
          reportId: args.flags.buildId,
        },
        operationDeps({
          alchemy,
          configPath: ctx.config.configPath,
          workspaceId: await workspaceIdOf(ctx),
          client: ctx.api,
        }),
      );

      return settleConverge(result, ctx, ({ summary }) =>
        ctx.present(
          { data: { summary: summary ?? null } },
          {
            human: (ui) =>
              summary === undefined
                ? [{ kind: 'summary', status: 'ok', text: 'Deployed.' }]
                : [
                    {
                      kind: 'summary',
                      status: 'ok',
                      text: `Deployed ${ui.emphasize(summary.app)}.`,
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
            stdout: () => [],
            json: () => ({ summary: summary ?? null }),
            next: () => [],
          },
        ),
      );
    },
  });

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
import { reportConfigDiagnostics, selectComposerConfig } from '../select-config.ts';
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
      },
    },
    needs: { credentials: 'child' },
    maySpawn: true,
    handler: async (args, ctx) => {
      const selectedConfig = await selectComposerConfig(args.positionals.entry, ctx.cwd);
      if (!selectedConfig.ok) return selectedConfig;
      reportConfigDiagnostics(selectedConfig.value.diagnostics, ctx.report);
      const alchemy = convergeSpawn(ctx);
      const result = await operations.deploy(
        {
          entry: args.positionals.entry,
          name: args.flags.name,
          stage: args.flags.stage,
          cwd: ctx.cwd,
        },
        operationDeps({
          alchemy,
          configPath: selectedConfig.value.configPath,
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
            json: () => ({ summary: summary ?? null }),
          },
        ),
      );
    },
  });

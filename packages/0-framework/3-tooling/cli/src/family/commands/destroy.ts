/**
 * `destroy <entry>` — deploy's mirror: same derivation, alchemy destroy.
 *
 * No confirmation prompt, matching the CLI this replaces. The front door
 * cannot know what the child will tear down, so a consent step here would be
 * asking the user to approve a list nobody has computed yet; if destroy
 * deserves one it belongs in composer's own operation, not in the grammar.
 */
import { defineCommand, flag, positional } from '@prisma/cli-engine';
import type { DestroyTarget } from '../../operations/destroy.ts';
import { convergeSpawn, operationDeps, settleConverge } from '../converge.ts';
import type { ComposerOperations } from '../family.ts';
import { composerSection } from '../section.ts';
import { targetOf } from '../target.ts';
import { workspaceIdOf } from '../workspace.ts';

export const createDestroyCommand = (operations: ComposerOperations) =>
  defineCommand({
    help: {
      summary: "Tear down the application whose root node is <entry>'s default export.",
      description:
        'Same derivation as deploy. Requires an explicit target: --stage <name> for a branch ' +
        'environment, or --production for the production environment.',
      examples: [
        '{bin} destroy src/service.ts --stage feat-auth',
        '{bin} destroy src/service.ts --production',
      ],
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
          brief: "Override the root node's name — the application name to tear down.",
          placeholder: 'name',
        }),
        stage: flag.string({
          brief: 'Tear down this branch environment.',
          placeholder: 'stage',
        }),
        production: flag.boolean({
          brief: 'Tear down the project-level production environment.',
        }),
      },
    },
    needs: { config: composerSection, credentials: 'child' },
    maySpawn: true,
    handler: async (args, ctx) => {
      const target = targetOf(args.flags.stage, args.flags.production);
      if (!target.ok) return target;

      const alchemy = convergeSpawn(ctx);
      const result = await operations.destroy(
        {
          entry: args.positionals.entry,
          name: args.flags.name,
          target: target.value satisfies DestroyTarget,
          cwd: ctx.cwd,
          onEvent: (event) => {
            if (event.kind !== 'no-local-deploy-state') return;
            ctx.report({
              kind: 'message',
              severity: 'warn',
              text:
                `No prior deploy state under ${event.cwd} — if you deployed from a different ` +
                'directory, run destroy from there; otherwise this is a no-op.',
            });
          },
        },
        operationDeps({
          alchemy,
          configPath: ctx.config.configPath,
          workspaceId: await workspaceIdOf(ctx),
          client: ctx.api,
        }),
      );

      return settleConverge(result, ctx, () =>
        ctx.present(
          { data: undefined },
          { human: () => [{ kind: 'summary', tone: 'ok', text: 'Destroyed.' }] },
        ),
      );
    },
  });

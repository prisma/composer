/**
 * `dev stop` — stops the app's local copy in one environment, as ending
 * `prisma dev` would: its service processes and database servers. For an
 * app whose `prisma dev` was killed without the chance to stop it.
 */
import { defineCommand, flag } from '@prisma/cli-engine';
import { notOk, ok } from '@prisma/cli-engine/protocol';
import { DEV_ENVIRONMENT } from '../../operations/shared.ts';
import { dataLine } from '../data-lines.ts';
import type { ComposerOperations } from '../family.ts';
import { composerSection } from '../section.ts';
import { toEngineError } from '../translate-error.ts';

export const createDevStopCommand = (operations: ComposerOperations) =>
  defineCommand({
    help: {
      summary:
        "Stop the app's local copy in an environment: its service processes and local " +
        'database servers. Data and ports are kept for the next `prisma dev`.',
      description:
        'The app is the root module of the entry, or --name, as for `prisma dev`, and the ' +
        'environment is dev unless --environment names another. Other apps and environments ' +
        'keep running. Ending `prisma dev` with Ctrl-C does the same. Run this when ' +
        '`prisma dev` was killed without a chance to stop the app, or before deleting the ' +
        'directory. The emulators keep running; other directories may be using them.',
      examples: ['{bin} dev stop', '{bin} dev stop --environment test'],
    },
    args: {
      flags: {
        entry: flag.string({
          brief:
            'The file whose default export is the application root module. Overrides `entry` ' +
            'in the `composer` section of prisma.config.ts.',
          placeholder: 'path',
        }),
        name: flag.string({
          brief: "Stop the app run under this name instead of the root module's name.",
          placeholder: 'name',
        }),
        environment: flag.string({
          brief: 'The environment whose local copy to stop.',
          placeholder: 'name',
          default: DEV_ENVIRONMENT,
        }),
      },
    },
    needs: { config: composerSection },
    handler: async (args, ctx) => {
      const result = await operations.devStop({
        config: ctx.config,
        entry: args.flags.entry,
        name: args.flags.name,
        environment: args.flags.environment,
        cwd: ctx.cwd,
      });
      if (!result.ok) return notOk(toEngineError(result.failure));
      const { app, environment, stopped } = result.value;
      return ok(
        ctx.present(
          { data: result.value },
          {
            human: (ui) =>
              stopped.length === 0
                ? [
                    {
                      kind: 'summary',
                      status: 'info',
                      text: `Nothing of ${ui.emphasize(app)} was running in the environment ${environment}.`,
                    },
                  ]
                : [
                    {
                      kind: 'summary',
                      status: 'ok',
                      text: `Stopped ${ui.emphasize(app)} in the environment ${environment}. Its data and ports are kept for the next \`prisma dev\`.`,
                    },
                    {
                      kind: 'table',
                      columns: ['Address', 'Kind'],
                      rows: stopped.map(({ address, kind }) => [address, kind]),
                    },
                  ],
            stdout: () => stopped.map(({ address, kind }) => dataLine([address, kind])),
            json: () => result.value,
            next: () => [],
          },
        ),
      );
    },
  });

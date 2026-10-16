/**
 * `dev stop` — stops the app `prisma dev` last ran from this directory, as
 * ending `prisma dev` would: its service processes and database servers.
 * For an app whose `prisma dev` was killed without the chance to stop it.
 */
import { defineCommand } from '@prisma/cli-engine';
import { notOk, ok } from '@prisma/cli-engine/protocol';
import type { ComposerOperations } from '../family.ts';
import { composerSection } from '../section.ts';
import { toEngineError } from '../translate-error.ts';

export const createDevStopCommand = (operations: ComposerOperations) =>
  defineCommand({
    help: {
      summary:
        'Stop the app `prisma dev` last ran from this directory: its service processes and ' +
        'local database servers. Data and ports are kept for the next `prisma dev`.',
      description:
        'Ending `prisma dev` with Ctrl-C does the same. Run this when `prisma dev` was ' +
        'killed without a chance to stop the app, or before deleting the directory. The ' +
        'emulators keep running; other directories may be using them.',
      examples: ['{bin} dev stop'],
    },
    args: {},
    needs: { config: composerSection },
    handler: async (_args, ctx) => {
      const result = await operations.devStop({ config: ctx.config, cwd: ctx.cwd });
      if (!result.ok) return notOk(toEngineError(result.failure));
      const { app, stopped } = result.value;
      return ok(
        ctx.present(
          { data: result.value },
          {
            human: (ui) => [
              {
                kind: 'summary',
                status: 'ok',
                text: `Stopped ${ui.emphasize(app)}. Its data and ports are kept for the next \`prisma dev\`.`,
              },
              ...(stopped.length === 0
                ? []
                : [
                    {
                      kind: 'table' as const,
                      columns: ['Address', 'Kind'],
                      rows: stopped.map(({ address, kind }) => [address, kind]),
                    },
                  ]),
            ],
            stdout: () => [],
            json: () => result.value,
            next: () => [],
          },
        ),
      );
    },
  });

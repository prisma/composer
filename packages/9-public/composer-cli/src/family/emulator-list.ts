/**
 * `emulator list` — every local emulator on this machine and every
 * instance it holds. It needs no project and no config. The listing comes
 * from the Prisma Cloud domain, so the command is assembled into the
 * family here, where both domains may be imported.
 */

import { toEngineError } from '@internal/cli/family';
import type { EmulatorList } from '@internal/dev-emulators';
import type { CliStructuredError as ComposerError } from '@internal/foundation/errors';
import type { Result } from '@internal/foundation/result';
import { defineCommand } from '@prisma/cli-engine';
import { notOk, ok } from '@prisma/cli-engine/protocol';

export type ListEmulators = () => Promise<Result<EmulatorList, ComposerError>>;

/** Loaded on first use, so nothing of the emulators' clients loads with the family. */
export const listEmulators: ListEmulators = async () =>
  (await import('@internal/dev-emulators')).listEmulators();

const EMULATOR_NAMES = {
  service: 'Service emulator',
  database: 'Database emulator',
  bucket: 'Bucket emulator',
} as const;

/** The node and directory that started an instance, when Composer's labels say. */
function startedBy(labels: Readonly<Record<string, string>>): string | undefined {
  const address = labels['composer.address'];
  const directory = labels['composer.directory'];
  if (address === undefined) return undefined;
  return directory === undefined ? address : `${address} in ${directory}`;
}

export const createEmulatorListCommand = (list: ListEmulators) =>
  defineCommand({
    help: {
      summary:
        'List the local emulators on this machine — the programs `prisma dev` starts to run ' +
        'services, databases and S3-compatible buckets without Prisma Cloud — with every ' +
        'instance each one holds.',
      description:
        'Needs no project: it shows every directory’s instances. An emulator that is not ' +
        'running is listed with no instances. Each instance’s labels say which directory, ' +
        'app and node started it. A stopped instance keeps its port and data until it is ' +
        'deleted.',
      examples: ['{bin} emulator list', '{bin} emulator list --json'],
    },
    args: {},
    handler: async (_args, ctx) => {
      const result = await list();
      if (!result.ok) return notOk(toEngineError(result.failure));
      const { emulators } = result.value;
      return ok(
        ctx.present(
          { data: result.value },
          {
            human: (ui) => [
              {
                kind: 'tree',
                roots: emulators.map((emulator) => ({
                  label: emulator.running
                    ? `${EMULATOR_NAMES[emulator.kind]} at ${emulator.url ?? ''}`
                    : `${EMULATOR_NAMES[emulator.kind]} ${ui.dim('(not running)')}`,
                  status: emulator.running ? ('ok' as const) : ('info' as const),
                  children: emulator.instances.map((instance) => {
                    const by = startedBy(instance.labels);
                    return {
                      label: [
                        instance.id,
                        instance.url,
                        instance.state,
                        ...(by ? [ui.dim(by)] : []),
                      ].join('  '),
                    };
                  }),
                })),
              },
            ],
            stdout: () => [],
            json: () => result.value,
            next: () => [],
          },
        ),
      );
    },
  });

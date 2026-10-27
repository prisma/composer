/**
 * `deploy list` — every node an app has deployed on a stage, with the
 * platform row each one deployed to. It reads the stage's application
 * topology and the Branch's rows on Prisma Cloud, so the command is
 * assembled into the family here, where both domains may be imported.
 */

import { composerSection, dataLine, toEngineError } from '@internal/cli/family';
import type { CliStructuredError as ComposerError } from '@internal/foundation/errors';
import type { Result } from '@internal/foundation/result';
import { defineCommand, flag } from '@prisma/cli-engine';
import { notOk, ok } from '@prisma/cli-engine/protocol';
import type { DeployedNode } from './deployed-nodes.ts';
import type { ListDeployedInput } from './list-deployed.ts';

export type ListDeployed = (
  input: ListDeployedInput,
) => Promise<Result<readonly DeployedNode[], ComposerError>>;

/** Loaded on first use, so nothing of the Management API reads loads with the family. */
export const listDeployed: ListDeployed = async (input) =>
  (await import('./list-deployed.ts')).listDeployed(input);

export const createDeployListCommand = (list: ListDeployed) =>
  defineCommand({
    help: {
      summary: 'List every node the app has deployed on a stage, with its platform ID and URL.',
      description:
        'Reads the application topology the last deploy recorded for the stage, and finds ' +
        'each node’s service, database or bucket on Prisma Cloud. The root node is the ' +
        'Project. A node with nothing on the platform, such as a module, has no platform ID.',
      examples: [
        '{bin} deploy list',
        '{bin} deploy list --stage feat-auth',
        '{bin} deploy list --json',
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
            'List the app deployed under this name instead of the name its root module ' +
            "declares (default: the root module's name).",
          placeholder: 'name',
        }),
        stage: flag.string({
          brief: 'List this stage instead of production (default: production).',
          placeholder: 'stage',
        }),
      },
    },
    needs: { config: composerSection, credentials: true },
    handler: async (args, ctx) => {
      const credential = await ctx.activeCredential();
      const result = await list({
        config: ctx.config,
        entry: args.flags.entry,
        name: args.flags.name,
        stage: args.flags.stage,
        cwd: ctx.cwd,
        workspaceId: credential?.workspaceId,
        client: ctx.api,
      });
      if (!result.ok) return notOk(toEngineError(result.failure));
      const nodes = result.value;
      return ok(
        ctx.present(
          { data: nodes },
          {
            human: () => [
              {
                kind: 'table',
                columns: ['Address', 'Kind', 'Platform ID', 'URL'],
                rows: nodes.map((node) => [
                  node.address,
                  node.kind,
                  node.platformId ?? '',
                  node.url ?? '',
                ]),
              },
            ],
            stdout: () =>
              nodes.map((node) => dataLine([node.address, node.kind, node.platformId, node.url])),
            json: () => nodes,
            next: () => [],
          },
        ),
      );
    },
  });

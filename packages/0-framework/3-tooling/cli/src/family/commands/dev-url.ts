/**
 * `dev url <address>` — where a node that `prisma dev` runs from this
 * directory answers locally, in the environment named. A data command: the
 * URL is its stdout line, so `$(prisma dev url shop.gateway)` is the URL alone.
 */
import { defineCommand, flag, positional } from '@prisma/cli-engine';
import { notOk, ok } from '@prisma/cli-engine/protocol';
import { DEV_ENVIRONMENT } from '../../operations/shared.ts';
import { dataLine } from '../data-lines.ts';
import type { ComposerOperations } from '../family.ts';
import { composerSection } from '../section.ts';
import { toEngineError } from '../translate-error.ts';

export const createDevUrlCommand = (operations: ComposerOperations) =>
  defineCommand({
    help: {
      summary:
        'Print the local URL of a node (a service, database or bucket in your app) that ' +
        "`prisma dev` runs from this directory: a service's HTTP URL, a database's connection " +
        "string, or a bucket's S3 address.",
      description:
        'The app is the first name of the address, and the environment is dev unless ' +
        '--environment names another. Reads what `prisma dev` recorded for that app and ' +
        'environment in this directory and starts nothing, so run it while `prisma dev` is ' +
        'running; a node that is not running is an error. ' +
        'The URL alone goes to stdout, so a script can use it directly: ' +
        'curl "$(prisma dev url shop.gateway)". With --json, stdout carries the full result instead.',
      examples: [
        '{bin} dev url shop.gateway',
        '{bin} dev url shop.gateway --environment test',
        '{bin} dev url shop.catalog.database --json',
      ],
    },
    args: {
      positionals: {
        address: positional.string({
          brief:
            "The node's address: the app name, then the names down to the node, with dots " +
            'between them, such as shop.catalog.database.',
          placeholder: 'address',
        }),
      },
      flags: {
        environment: flag.string({
          brief: 'The environment whose local copy to read.',
          placeholder: 'name',
          default: DEV_ENVIRONMENT,
        }),
      },
    },
    needs: { config: composerSection },
    handler: async (args, ctx) => {
      const result = await operations.devUrl({
        config: ctx.config,
        address: args.positionals.address,
        environment: args.flags.environment,
        cwd: ctx.cwd,
      });
      if (!result.ok) return notOk(toEngineError(result.failure));
      const node = result.value;
      return ok(
        ctx.present(
          { data: node },
          {
            human: (ui) => [
              {
                kind: 'summary',
                status: 'ok',
                text: `The ${node.kind} ${ui.emphasize(node.address)} is ${node.state} at ${node.url}`,
              },
            ],
            stdout: () => [dataLine([node.url])],
            json: () => node,
            next: () => [],
          },
        ),
      );
    },
  });

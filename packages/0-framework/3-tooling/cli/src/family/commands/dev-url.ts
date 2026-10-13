/**
 * `dev url <address>` — where a node of the app `prisma dev` runs from this
 * directory answers locally. A data command: the URL is its stdout line, so
 * `$(prisma dev url gateway --format human)` is the URL alone.
 */
import { defineCommand, positional } from '@prisma/cli-engine';
import { notOk, ok } from '@prisma/cli-engine/protocol';
import type { ComposerOperations } from '../family.ts';
import { composerSection } from '../section.ts';
import { toEngineError } from '../translate-error.ts';

export const createDevUrlCommand = (operations: ComposerOperations) =>
  defineCommand({
    help: {
      summary:
        'Print the local URL of a node of the app `prisma dev` runs from this directory: a ' +
        "service's HTTP URL, a database's connection string, or a bucket's S3 address.",
      description:
        'Reads what the last `prisma dev` in this directory recorded and starts nothing, so ' +
        'run it while `prisma dev` is running; a node that is not running is an error. With ' +
        '--format human the URL alone goes to stdout. In a script, the JSON result holds it: ' +
        `prisma dev url gateway | jq -r 'select(.kind=="result").envelope.result.url'.`,
      examples: ['{bin} dev url gateway', '{bin} dev url catalog.database --json'],
    },
    args: {
      positionals: {
        address: positional.string({
          brief:
            "The node's address: its name in the app, dotted for a node inside a module, such " +
            'as catalog.database.',
          placeholder: 'address',
        }),
      },
    },
    needs: { config: composerSection },
    handler: async (args, ctx) => {
      const result = await operations.devUrl({
        config: ctx.config,
        address: args.positionals.address,
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
            stdout: () => [node.url],
            json: () => node,
            next: () => [],
          },
        ),
      );
    },
  });

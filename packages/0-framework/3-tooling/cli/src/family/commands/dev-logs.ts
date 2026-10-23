/**
 * `dev logs [address]` — what the services of the app `prisma dev` runs from
 * this directory write to stdout and stderr. A data command: each log line is
 * a stdout line, so it pipes and greps; with --json each line is one output
 * frame carrying its service's address.
 */
import type { EngineEvent } from '@prisma/cli-engine';
import { defineSessionCommand, flag, positional } from '@prisma/cli-engine';
import { notOk, ok } from '@prisma/cli-engine/protocol';
import { DEV_LOGS_DEFAULT_TAIL } from '../../operations/dev-current.ts';
import type { LogEvent } from '../../operations/log.ts';
import type { ComposerOperations } from '../family.ts';
import { composerSection } from '../section.ts';
import { toEngineError } from '../translate-error.ts';

function reportLogEvent(report: (event: EngineEvent) => void): (event: LogEvent) => void {
  return (event) => {
    switch (event.kind) {
      case 'stream-failed':
        report({
          kind: 'message',
          severity: 'warn',
          text: `A service's log stream failed; the others continue: ${event.message}`,
        });
        return;
      case 'lines-dropped':
        report({
          kind: 'message',
          severity: 'warn',
          text: `${String(event.count)} log lines were dropped because output fell behind.`,
        });
        return;
    }
  };
}

export const createDevLogsCommand = (operations: ComposerOperations) =>
  defineSessionCommand({
    help: {
      summary:
        'Print what the services of the app `prisma dev` runs from this directory write to ' +
        'stdout and stderr: their console.log output, errors and crashes.',
      description:
        `Prints the last ${String(DEV_LOGS_DEFAULT_TAIL)} lines of every service's log and ` +
        'exits; --follow keeps printing new lines until Ctrl-C. Pass an address for one ' +
        'service. Without one, each line starts with its service in brackets, such as ' +
        '[gateway]. A service holds the log of its current run only: each start, including ' +
        'a rebuild, clears it. Log lines go to stdout and everything else to stderr, so ' +
        "`prisma dev logs gateway | grep error` searches the gateway's log. With --json, " +
        'each line is one JSON object on stdout carrying the service in data.service.',
      examples: ['{bin} dev logs', '{bin} dev logs gateway --tail 20', '{bin} dev logs --follow'],
    },
    args: {
      positionals: {
        address: positional.optionalString({
          brief: "A service's address: its name in the app, with dots for a nested service.",
          placeholder: 'address',
        }),
      },
      flags: {
        tail: flag.number({
          brief: `Start with each service's last N lines (default ${String(DEV_LOGS_DEFAULT_TAIL)})`,
          placeholder: 'n',
        }),
        follow: flag.boolean({
          brief: 'Keep printing new lines, including from services a rebuild adds, until Ctrl-C',
        }),
      },
    },
    needs: { config: composerSection },
    handler: async (args, ctx) => {
      const { address } = args.positionals;
      const result = await operations.devLogs({
        config: ctx.config,
        address,
        tail: args.flags.tail,
        follow: args.flags.follow,
        cwd: ctx.cwd,
        signal: ctx.signal,
        onEvent: reportLogEvent(ctx.report),
      });
      if (!result.ok) return notOk(toEngineError(result.failure));
      const { app, services, lines } = result.value;

      if (services.length === 0) {
        ctx.report({
          kind: 'message',
          severity: 'info',
          text: `${app} has no services, so there are no logs to show.`,
        });
        return ok(undefined);
      }
      // One service named on the command line needs no label; otherwise every
      // line carries one, whether one service or many answered — a script
      // reading the lines sees the same shape either way.
      const label = address === undefined;
      for await (const { service, line } of lines) {
        ctx.report({
          kind: 'output',
          source: 'logs',
          channel: 'data',
          line: label ? `[${service}] ${line}` : line,
          data: { service, line },
        });
      }
      // A followed stream ends only when Ctrl-C aborts it; the engine settles
      // that run from its own record of the signal.
      return ok(undefined);
    },
  });

/**
 * `log <entry> [address]` — a session command that tails the merged logs of
 * the app running locally on this machine.
 *
 * It reads the LOCAL dev-emulator daemon, not the platform's logs surface, so
 * it is credential-free. It hands the terminal to nothing, which is why it
 * does not declare `maySpawn` and keeps json support: the log lines ARE its
 * json surface.
 *
 * Windows is refused inside the operation itself (LOG.PLATFORM_UNSUPPORTED),
 * which is why nothing here reads the platform.
 */
import { defineSessionCommand, flag, positional } from '@prisma/cli-engine';
import { notOk, ok } from '@prisma/cli-engine/protocol';
import type { LogEvent } from '../../operations/log.ts';
import type { ComposerOperations } from '../family.ts';
import { reportConfigDiagnostics, selectComposerConfig } from '../select-config.ts';
import { toEngineError } from '../translate-error.ts';

/** An empty screen reads as broken, so show a little recent history before going live. */
const DEFAULT_TAIL = 20;

export const createLogCommand = (operations: ComposerOperations) =>
  defineSessionCommand({
    help: {
      summary:
        "Tail the merged logs of the locally-running application whose root node is <entry>'s " +
        'default export.',
      examples: ['{bin} log src/service.ts', '{bin} log src/service.ts catalog.service'],
    },
    args: {
      positionals: {
        entry: positional.string({
          brief: 'The module whose default export is the application root.',
          placeholder: 'entry',
        }),
        address: positional.optionalString({
          brief:
            "Only this service's lines, by its dotted address (catalog.service); every service " +
            'when absent.',
          placeholder: 'address',
        }),
      },
      flags: {
        name: flag.string({
          brief: "Override the root node's name — the dev instance's application name.",
          placeholder: 'name',
        }),
        tail: flag.number({
          brief: `How many trailing history lines to show before live output (default ${String(DEFAULT_TAIL)}).`,
          placeholder: 'lines',
          default: DEFAULT_TAIL,
        }),
      },
    },
    handler: async (args, ctx) => {
      const selectedConfig = await selectComposerConfig(args.positionals.entry, ctx.cwd);
      if (!selectedConfig.ok) return selectedConfig;
      reportConfigDiagnostics(selectedConfig.value.diagnostics, ctx.report);
      const reportLogEvent = (event: LogEvent): void => {
        ctx.report({
          kind: 'message',
          severity: 'warn',
          text:
            event.kind === 'stream-failed'
              ? `Stream failed: ${event.message}`
              : `Falling behind — dropped the ${String(event.count)} oldest lines.`,
        });
      };

      const result = await operations.log(
        {
          entry: args.positionals.entry,
          name: args.flags.name,
          address: args.positionals.address,
          tail: args.flags.tail ?? DEFAULT_TAIL,
          cwd: ctx.cwd,
          signal: ctx.signal,
          onEvent: reportLogEvent,
        },
        { configPath: selectedConfig.value.configPath },
      );

      if (!result.ok) return notOk(toEngineError(result.failure));

      const attached = result.value;
      if (attached.services.length === 0) {
        ctx.report({
          kind: 'message',
          severity: 'warn',
          text: `No running services for "${attached.appName}" — start it first with \`dev ${args.positionals.entry}\`.`,
        });
        return ok(undefined);
      }

      // The engine renders an `output` event as its `line` alone, so the
      // service prefix a merged tail needs has to be part of the line. The
      // structured `source` still carries it for json consumers.
      for await (const { service, line } of attached.lines) {
        ctx.report({
          kind: 'output',
          source: service,
          channel: 'data',
          line: `[${service}] ${line}`,
        });
      }
      return ok(undefined);
    },
  });

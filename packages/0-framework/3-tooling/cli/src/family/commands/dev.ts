/**
 * `dev <entry>` — a session command that runs the local dev loop until the
 * user interrupts it.
 *
 * The watch loop, the emulators and the live attachments stay the operation's
 * state. What the handler owns is the boundary: the converge child goes out
 * through `ctx.spawn`, so the terminal reaches alchemy natively and the engine
 * owns signal policy; the operation's events become engine events; and the
 * session settles on how it actually ended.
 *
 * Windows is refused inside the operation itself (DEV.PLATFORM_UNSUPPORTED),
 * which is why nothing here reads the platform.
 *
 * `dev` is credential-free: everything it starts runs on this machine.
 */
import type { ChildResult, EngineEvent } from '@prisma/cli-engine';
import { defineSessionCommand, exitWithChildStatus, flag, positional } from '@prisma/cli-engine';
import { notOk, ok } from '@prisma/cli-engine/protocol';
import type { DevEvent } from '../../operations/dev.ts';
import type { ServiceEndpoint } from '../../operations/shared.ts';
import type { AlchemyInvocation, AlchemyOutcome, RunAlchemy } from '../../run-alchemy.ts';
import { convergeSpawn, reproduceHint } from '../converge.ts';
import type { ComposerOperations } from '../family.ts';
import { composerSection } from '../section.ts';
import { toEngineError } from '../translate-error.ts';

const STOP_STEP = "Stopping the app's services — emulators and data stay up";

/** Resolves when the run is asked to stop. */
function stopRequested(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * One converge at a time. `ctx.spawn` refuses a second live child, and the
 * watch loop can well fire a rebuild while the previous converge is still
 * running — so a request that arrives during a live converge joins the single
 * queued follow-up instead of starting its own. That extends the coalescing
 * the watcher already does across a burst of edits to cover the converge
 * itself, and it is sound because every dev converge is the SAME invocation:
 * one stack file at one fixed path, rewritten in place before each request.
 */
function coalescedConverge(run: RunAlchemy): RunAlchemy {
  let live: Promise<void> | undefined;
  let queued: Promise<AlchemyOutcome> | undefined;

  const start = (invocation: AlchemyInvocation): Promise<AlchemyOutcome> => {
    const outcome = run(invocation);
    const settled = outcome.then(
      () => undefined,
      () => undefined,
    );
    live = settled;
    void settled.then(() => {
      if (live === settled) live = undefined;
    });
    return outcome;
  };

  return (invocation) => {
    const running = live;
    if (running === undefined) return start(invocation);
    queued ??= running.then(() => {
      queued = undefined;
      return start(invocation);
    });
    return queued;
  };
}

/** The front door, ordered by address depth (fewest dots first) then lexicographically. */
function frontDoorOrder(endpoints: readonly ServiceEndpoint[]): readonly ServiceEndpoint[] {
  return [...endpoints].sort((a, b) => {
    const depth = a.address.split('.').length - b.address.split('.').length;
    if (depth !== 0) return depth;
    return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
  });
}

/**
 * The operation's events as engine events. The legacy `[dev]` console prefix
 * is gone: these are commentary the engine renders and frames.
 */
function reportDevEvent(
  report: (event: EngineEvent) => void,
  lastChild: () => ChildResult | undefined,
): (event: DevEvent) => void {
  let stopFailed = false;

  return (event) => {
    switch (event.kind) {
      case 'ready':
        report({ kind: 'status', subject: 'dev', status: 'ready' });
        for (const endpoint of frontDoorOrder(event.endpoints)) {
          report({ kind: 'endpoint', name: endpoint.address, url: endpoint.url });
        }
        return;

      case 'unwatchable':
        // A warning rather than a note: edits under that address will not
        // rebuild anything, and nothing later says so again.
        report({
          kind: 'message',
          severity: 'warn',
          text: `${event.address} has no watchable inputs.`,
        });
        return;

      case 'rebuild-failed':
        report({ kind: 'message', severity: 'warn', text: `Rebuild failed: ${event.message}` });
        return;

      case 'watch-error':
        report({ kind: 'message', severity: 'warn', text: `Watch error: ${event.message}` });
        return;

      case 'converge-failed': {
        const child = lastChild();
        // A signal-killed converge is the user shutting the session down, not
        // a converge that failed — the engine replays that signal into
        // ctx.signal the moment the child ends, and the teardown below is what
        // reports it.
        if (child !== undefined && child.signal !== null) return;
        report({
          kind: 'message',
          severity: 'warn',
          text:
            'Converge failed — the running app is untouched; still watching.\n' +
            `Generated stack file: ${event.stackFilePath}\n` +
            `Run \`${event.reproduceCommand}\` from ${event.cwd} to reproduce this directly.`,
        });
        report({
          kind: 'remediation',
          action: {
            kind: 'run-command',
            label: `Run the converge directly from ${event.cwd} to reproduce this`,
            command: event.reproduceCommand,
            reason: `Generated stack file: ${event.stackFilePath}`,
          },
        });
        return;
      }

      case 'stopping':
        report({ kind: 'step-started', step: STOP_STEP, id: 'dev-stop' });
        return;

      case 'stop-error':
        stopFailed = true;
        report({
          kind: 'message',
          severity: 'warn',
          text: `A service refused to stop: ${event.message}`,
        });
        return;

      case 'stopped':
        report({
          kind: 'step-finished',
          step: STOP_STEP,
          id: 'dev-stop',
          outcome: stopFailed ? 'warning' : 'ok',
        });
        return;
    }
  };
}

export const createDevCommand = (operations: ComposerOperations) =>
  defineSessionCommand({
    help: {
      summary:
        "Bring up the application whose root node is <entry>'s default export, entirely on " +
        'this machine.',
      description:
        'Runs credential-free and watches the app for changes, reconverging on every edit. ' +
        'Logs are a separate command; run `log <entry>` to tail them.',
      examples: ['{bin} dev src/service.ts', '{bin} dev src/service.ts --fresh'],
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
          brief: "Override the root node's name — the dev instance's application name.",
          placeholder: 'name',
        }),
        fresh: flag.boolean({
          brief: 'Destroy the dev stack and wipe the dev state directory before starting.',
        }),
      },
    },
    needs: { config: composerSection },
    maySpawn: true,
    handler: async (args, ctx) => {
      const alchemy = convergeSpawn(ctx);
      const result = await operations.dev(
        {
          entry: args.positionals.entry,
          name: args.flags.name,
          fresh: args.flags.fresh,
          cwd: ctx.cwd,
          onEvent: reportDevEvent(ctx.report, ctx.lastChild),
        },
        { alchemy: coalescedConverge(alchemy), configPath: ctx.config.configPath },
      );

      // Nothing is live yet, so the ending is the converge's — read the way
      // deploy and destroy read it, which is the operation's own verdict and
      // nothing else. A signal-killed converge needs no branch: the engine
      // settles the run from its own record of the signal.
      if (!result.ok) {
        const child = ctx.lastChild();
        if (child !== undefined && child.exitCode !== 0) {
          return ok(exitWithChildStatus({ nextActions: reproduceHint(result.failure) }));
        }
        return notOk(toEngineError(result.failure));
      }

      await stopRequested(ctx.signal);
      await result.value.stop();
      // Ctrl-C settles 130 because the engine records the signal that fired and
      // settles at 128 + it, including for a handler that cleaned up and
      // returned. Reporting the termination is not this handler's to do.
      return ok(undefined);
    },
  });

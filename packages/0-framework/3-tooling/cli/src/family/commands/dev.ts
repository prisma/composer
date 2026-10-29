/**
 * `dev` — a session command that runs the local dev loop until the
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
import * as path from 'node:path';
import type { ChildResult, EngineEvent } from '@prisma/cli-engine';
import { defineSessionCommand, flag } from '@prisma/cli-engine';
import { ok } from '@prisma/cli-engine/protocol';
import type { DevEvent, DevInput } from '../../operations/dev.ts';
import { DEV_ENVIRONMENT, type ServiceEndpoint } from '../../operations/shared.ts';
import type { AlchemyInvocation, AlchemyOutcome, RunAlchemy } from '../../run-alchemy.ts';
import { convergeSpawn, settleConvergeFailure } from '../converge.ts';
import type { ComposerOperations } from '../family.ts';
import { composerSection } from '../section.ts';

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
  cwd: string,
): (event: DevEvent) => void {
  let stopFailed = false;

  return (event) => {
    switch (event.kind) {
      case 'ready':
        report({ kind: 'status', subject: 'dev', status: 'ready' });
        for (const endpoint of frontDoorOrder(event.endpoints)) {
          report({
            kind: 'endpoint',
            name: endpoint.address,
            url: endpoint.url,
            ...(endpoint.devServer !== undefined
              ? { data: { devServer: endpoint.devServer } }
              : {}),
          });
        }
        return;

      case 'dev-server':
        report({
          kind: 'message',
          severity: 'info',
          text: `${event.address}: runs \`${event.command}\` in ${path.relative(cwd, event.cwd) || '.'}`,
        });
        return;

      case 'dev-server-restarted':
        report({
          kind: 'message',
          severity: 'info',
          text: `${event.address}: its environment changed; \`${event.command}\` restarted`,
        });
        return;

      case 'dev-server-output':
        report({ kind: 'message', severity: 'info', text: `[${event.address}] ${event.line}` });
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

      case 'target-warning':
        report({ kind: 'message', severity: 'warn', text: event.message });
        return;

      case 'rebuild-failed':
        report({ kind: 'message', severity: 'warn', text: `Rebuild failed: ${event.message}` });
        return;

      case 'config-changed':
        report({
          kind: 'message',
          severity: 'warn',
          text: `${event.file} changed. Restart dev to apply it; rebuilds are paused until then.`,
        });
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

/** A detached session owns nothing to stop, so a Ctrl-C before it was ready stops the app the way `prisma dev stop` does. */
async function stopDetachedApp(
  operations: ComposerOperations,
  app: Pick<DevInput, 'entry' | 'name' | 'environment'>,
  ctx: {
    readonly config: DevInput['config'];
    readonly cwd: string;
    readonly report: (event: EngineEvent) => void;
  },
): Promise<void> {
  const stopped = await operations.devStop({ ...app, config: ctx.config, cwd: ctx.cwd });
  if (stopped.ok) return;
  ctx.report({
    kind: 'message',
    severity: 'warn',
    text: `The app could not be stopped: ${stopped.failure.message} Run \`prisma dev stop\`.`,
  });
}

export const createDevCommand = (operations: ComposerOperations) =>
  defineSessionCommand({
    help: {
      summary:
        "Bring up the application whose root node is the entry module's default export, entirely on " +
        'this machine.',
      description:
        'Runs credential-free and watches the app for changes, reconverging on every edit. ' +
        "A service whose build adapter declares a dev server (Next.js's `next dev`, or the " +
        '`dev` command written on node()) runs that instead of its build, and its output is ' +
        'shown here, prefixed with its address. ' +
        'A node is one service, database or bucket in the app. Each node runs on a local ' +
        'emulator: a program on this machine that stands in for Prisma Cloud and runs ' +
        "services, databases or S3-compatible buckets. A node's address is its path from the app " +
        'name, with dots between names (shop.catalog.database). ' +
        'Each environment is a complete local copy of the app, with its own services, ' +
        'databases, buckets and ports; the default is dev, and copies of other environments ' +
        'run alongside it. Where each node runs is recorded in this directory: ' +
        '`prisma dev url` works from here while `prisma dev` runs, and `prisma dev stop` also ' +
        'works after `prisma dev` was killed. ' +
        'Ending `prisma dev` stops its services and database servers; data and ports are kept. ' +
        'With --detach it returns once every service answers and leaves the app running ' +
        'without watching for changes, until `prisma dev stop`.',
      examples: [
        '{bin} dev',
        '{bin} dev --fresh',
        '{bin} dev --environment test --fresh',
        '{bin} dev --detach',
        '{bin} dev --entry other-module.ts',
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
            'Run the app under this name instead of the name its root module declares. A ' +
            'different name gets its own local services, databases and buckets (default: the ' +
            "root module's name).",
          placeholder: 'name',
        }),
        environment: flag.string({
          brief:
            'The environment to run as. Each environment is a separate local copy of the app, ' +
            'so a second one, such as test, runs alongside dev and leaves its data alone.',
          placeholder: 'name',
          default: DEV_ENVIRONMENT,
        }),
        fresh: flag.boolean({
          brief:
            "Delete this app's local services, databases and buckets in the environment, and " +
            'their data, before starting. Other environments are untouched.',
        }),
        detach: flag.boolean({
          brief:
            'Return once every service answers and leave the app running without watching for ' +
            'changes. Use it in scripts, agents and CI. `prisma dev stop` stops the app.',
        }),
      },
    },
    needs: { config: composerSection },
    maySpawn: true,
    handler: async (args, ctx) => {
      const alchemy = convergeSpawn(ctx);
      const result = await operations.dev(
        {
          entry: args.flags.entry,
          config: ctx.config,
          name: args.flags.name,
          environment: args.flags.environment,
          fresh: args.flags.fresh,
          detach: args.flags.detach,
          cwd: ctx.cwd,
          onEvent: reportDevEvent(ctx.report, ctx.lastChild, ctx.cwd),
        },
        { alchemy: coalescedConverge(alchemy) },
      );

      // Nothing is live yet, so the ending is the converge's — settled by the
      // same decision deploy and destroy settle by, which is what keeps the
      // three from drifting. A signal-killed converge needs no branch: the
      // engine settles the run from its own record of the signal.
      if (!result.ok) return settleConvergeFailure(result.failure, ctx);

      if (args.flags.detach) {
        if (ctx.signal.aborted) {
          await stopDetachedApp(
            operations,
            {
              entry: args.flags.entry,
              name: args.flags.name,
              environment: args.flags.environment,
            },
            ctx,
          );
        }
        return ok(undefined);
      }

      await stopRequested(ctx.signal);
      await result.value.stop();
      // Ctrl-C settles 130 because the engine records the signal that fired and
      // settles at 128 + it, including for a handler that cleaned up and
      // returned. Reporting the termination is not this handler's to do.
      return ok(undefined);
    },
  });

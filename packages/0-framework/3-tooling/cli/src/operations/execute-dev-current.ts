/**
 * The `devUrl` and `devStop` executor: config → each extension's local
 * target → the app it recorded in the directory's dev state. Reached only by
 * lazy import from dev-current.ts — resolving the local targets loads their
 * descriptors, whose graphs reach alchemy's provider tree.
 */
import * as path from 'node:path';
import type { LocalNodeLocation, LocalTargetCurrentApp } from '@internal/core/local-target';
import { DEV_DIR, resolveLocalTargets } from '@internal/core/local-target';
import { CliStructuredError, InternalError } from '@internal/foundation/errors';
import { notOk, ok, type Result } from '@internal/foundation/result';
import { checkConfigSource } from '../pipeline.ts';
import type { DevStopInput, DevStopped, DevUrl, DevUrlInput } from './dev-current.ts';
import { toStructured } from './shared.ts';

const RUN_DEV = 'Run `prisma dev` in this directory.';

function platformUnsupported(): CliStructuredError {
  return new CliStructuredError(
    'DEV.PLATFORM_UNSUPPORTED',
    'local dev is not supported on Windows yet.',
  );
}

/** A call into an extension's local target; its failures that carry no code are the emulator's. */
async function fromTarget<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toStructured('DEV.EMULATOR_FAILED', error);
  }
}

/** Every extension's record of the app `prisma dev` last ran from `cwd`; fails when none recorded one. */
async function currentApps(
  input: { readonly config: DevUrlInput['config'] },
  cwd: string,
): Promise<LocalTargetCurrentApp[]> {
  const { value } = checkConfigSource(input.config, cwd);
  const devDir = path.join(cwd, DEV_DIR);
  const apps: LocalTargetCurrentApp[] = [];
  for (const target of (await resolveLocalTargets(value)).values()) {
    const current = await fromTarget(async () => target.current?.({ devDir }));
    if (current !== undefined) apps.push(current);
  }
  if (apps.length === 0) {
    throw new CliStructuredError('DEV.NOT_STARTED_HERE', `\`prisma dev\` has not run in ${cwd}.`, {
      why: `The local services, databases and buckets of an app are recorded in ${devDir} when \`prisma dev\` runs there, and there is no such record.`,
      fix: RUN_DEV,
      meta: { cwd },
    });
  }
  return apps;
}

async function locate(input: DevUrlInput, cwd: string): Promise<DevUrl> {
  const apps = await currentApps(input, cwd);
  const app = apps.find((candidate) => candidate.addresses.includes(input.address));
  if (app === undefined) {
    const known = apps.flatMap((candidate) => candidate.addresses).sort();
    throw new CliStructuredError(
      'DEV.ADDRESS_UNKNOWN',
      `"${apps.map((a) => a.app).join('", "')}" has no node at "${input.address}".`,
      {
        why: `The addresses recorded for the app \`prisma dev\` last ran here are: ${known.join(', ')}.`,
        fix: 'Pass one of those addresses. A nested node has a dotted address, such as `catalog.database`.',
        meta: { address: input.address, known },
      },
    );
  }
  const location = await fromTarget(() => app.locate(input.address));
  if (location === undefined) {
    throw new InternalError(`the local target recorded "${input.address}" but cannot locate it`);
  }
  if (location.emulator === 'not-running') {
    throw new CliStructuredError(
      'DEV.EMULATOR_UNREACHABLE',
      `The local ${location.kind} emulator that runs "${input.address}" is not running.`,
      {
        why: 'The local emulators run your services, databases and buckets on this machine; `prisma dev` starts the ones an app needs.',
        fix: RUN_DEV,
        meta: { address: input.address, kind: location.kind },
      },
    );
  }
  if (location.condition !== 'running') throw notRunning(input.address, location);
  if (location.url === undefined) {
    throw new InternalError(`the local target reports "${input.address}" running with no URL`);
  }
  // ADR-0056: what a service runs — the target reports the command of one
  // that runs its build adapter's dev server. A database or bucket runs
  // neither, so it carries no `runs`.
  const runs =
    location.command !== undefined
      ? ('dev-server' as const)
      : location.kind === 'service'
        ? ('artifact' as const)
        : undefined;
  return {
    address: input.address,
    kind: location.kind,
    url: location.url,
    state: location.state,
    ...(runs !== undefined ? { runs } : {}),
  };
}

function notRunning(
  address: string,
  location: Extract<LocalNodeLocation, { emulator: 'running' }>,
): CliStructuredError {
  const { kind, state, condition, logPath } = location;
  const meta = { address, kind, state, ...(logPath === undefined ? {} : { logPath }) };
  const message = `The ${kind} "${address}" is not running (${state}).`;
  if (condition === 'crashing') {
    return new CliStructuredError('DEV.NOT_RUNNING', message, {
      why: 'It exited after it started, and it is being restarted or was held after repeated crashes.',
      fix:
        logPath === undefined
          ? 'Read its output in the `prisma dev` terminal, fix the cause, and rebuild.'
          : `Read its log at ${logPath}, fix the cause, and rebuild.`,
      meta,
    });
  }
  if (condition === 'missing') {
    return new CliStructuredError('DEV.NOT_RUNNING', message, {
      why: 'The local emulator no longer has it, for example because a Composer upgrade discarded the emulator’s state.',
      fix: `${RUN_DEV} It creates the ${kind} again, empty.`,
      meta,
    });
  }
  return new CliStructuredError('DEV.NOT_RUNNING', `The ${kind} "${address}" is stopped.`, {
    why: "`prisma dev stop`, `prisma dev` ending, and running another app in this directory all stop an app's services and database servers, and a stopped node has no URL that answers.",
    fix: RUN_DEV,
    meta,
  });
}

export async function executeDevUrl(
  input: DevUrlInput,
  cwd: string,
): Promise<Result<DevUrl, CliStructuredError>> {
  if (process.platform === 'win32') return notOk(platformUnsupported());
  try {
    return ok(await locate(input, cwd));
  } catch (error) {
    if (CliStructuredError.is(error)) return notOk(error);
    throw error;
  }
}

export async function executeDevStop(
  input: DevStopInput,
  cwd: string,
): Promise<Result<DevStopped, CliStructuredError>> {
  if (process.platform === 'win32') return notOk(platformUnsupported());
  try {
    const apps = await currentApps(input, cwd);
    const stopped = [];
    for (const app of apps) stopped.push(...(await fromTarget(() => app.stop())));
    return ok({ app: apps.map((a) => a.app).join(', '), stopped });
  } catch (error) {
    if (CliStructuredError.is(error)) return notOk(error);
    throw error;
  }
}

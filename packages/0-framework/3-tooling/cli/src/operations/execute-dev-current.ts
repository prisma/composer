/**
 * The `devUrl`, `devStop` and `devLogs` executor: config → each extension's local
 * target → the app it recorded in the directory's dev state. Reached only by
 * lazy import from dev-current.ts — resolving the local targets loads their
 * descriptors, whose graphs reach alchemy's provider tree.
 */
import * as path from 'node:path';
import type {
  LocalNodeLocation,
  LocalTargetAttachment,
  LocalTargetCurrentApp,
  LocalTargetDescriptor,
} from '@internal/core/local-target';
import { DEV_DIR, resolveLocalTargets } from '@internal/core/local-target';
import { CliStructuredError, InternalError } from '@internal/foundation/errors';
import { notOk, ok, type Result } from '@internal/foundation/result';
import { checkConfigSource } from '../pipeline.ts';
import {
  DEV_LOGS_DEFAULT_TAIL,
  type DevLogs,
  type DevLogsInput,
  type DevStopInput,
  type DevStopped,
  type DevUrl,
  type DevUrlInput,
} from './dev-current.ts';
import { mergeLogStreams } from './execute-log.ts';
import type { LogLine } from './log.ts';
import { toStructured } from './shared.ts';

const RUN_DEV = 'Run `prisma dev <entry>` in this directory.';

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

interface RecordedApp {
  readonly target: LocalTargetDescriptor;
  readonly current: LocalTargetCurrentApp;
}

/** Every extension's record of the app `prisma dev` last ran from `cwd`, with the extension's local target; fails when none recorded one. */
async function recordedApps(
  input: { readonly config: DevUrlInput['config'] },
  cwd: string,
): Promise<RecordedApp[]> {
  const { value } = checkConfigSource(input.config, cwd);
  const devDir = path.join(cwd, DEV_DIR);
  const apps: RecordedApp[] = [];
  for (const target of (await resolveLocalTargets(value)).values()) {
    const current = await fromTarget(async () => target.current?.({ devDir }));
    if (current !== undefined) apps.push({ target, current });
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

/** Every extension's record of the app `prisma dev` last ran from `cwd`; fails when none recorded one. */
async function currentApps(
  input: { readonly config: DevUrlInput['config'] },
  cwd: string,
): Promise<LocalTargetCurrentApp[]> {
  return (await recordedApps(input, cwd)).map(({ current }) => current);
}

function addressUnknown(
  apps: readonly LocalTargetCurrentApp[],
  address: string,
): CliStructuredError {
  const known = apps.flatMap((candidate) => candidate.addresses).sort();
  return new CliStructuredError(
    'DEV.ADDRESS_UNKNOWN',
    `"${apps.map((a) => a.app).join('", "')}" has no node at "${address}".`,
    {
      why: `The addresses recorded for the app \`prisma dev\` last ran here are: ${known.join(', ')}.`,
      fix: 'Pass one of those addresses. A nested node has a dotted address, such as `catalog.database`.',
      meta: { address, known },
    },
  );
}

function emulatorNotRunning(address: string, kind: string): CliStructuredError {
  return new CliStructuredError(
    'DEV.EMULATOR_UNREACHABLE',
    `The local ${kind} emulator that runs "${address}" is not running.`,
    {
      why: 'The local emulators run your services, databases and buckets on this machine; `prisma dev` starts the ones an app needs.',
      fix: RUN_DEV,
      meta: { address, kind },
    },
  );
}

async function locate(input: DevUrlInput, cwd: string): Promise<DevUrl> {
  const apps = await currentApps(input, cwd);
  const app = apps.find((candidate) => candidate.addresses.includes(input.address));
  if (app === undefined) throw addressUnknown(apps, input.address);
  const location = await locateRecorded(app, input.address);
  if (location.emulator === 'not-running') {
    throw emulatorNotRunning(input.address, location.kind);
  }
  if (location.condition !== 'running') throw notRunning(input.address, location);
  if (location.url === undefined) {
    throw new InternalError(`the local target reports "${input.address}" running with no URL`);
  }
  return { address: input.address, kind: location.kind, url: location.url, state: location.state };
}

async function locateRecorded(
  app: LocalTargetCurrentApp,
  address: string,
): Promise<LocalNodeLocation> {
  const location = await fromTarget(() => app.locate(address));
  if (location === undefined) {
    throw new InternalError(`the local target recorded "${address}" but cannot locate it`);
  }
  return location;
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

/** One app's attachment and the addresses of its services that `devLogs` reads. */
interface LogSource {
  readonly attachment: LocalTargetAttachment;
  readonly services: readonly string[];
}

/**
 * Attaches to the app each extension recorded and picks the services to read:
 * the one at `address`, or every service. Only services have logs, so an
 * address recorded for another kind of node fails. A service that is not
 * running still has the log of its last run, so it is read; only an emulator
 * that is not running fails, because nothing could be read from it.
 */
async function logSources(
  input: DevLogsInput,
  cwd: string,
): Promise<{ readonly app: string; readonly sources: readonly LogSource[] }> {
  const devDir = path.join(cwd, DEV_DIR);
  const recorded = await recordedApps(input, cwd);
  const app = recorded.map(({ current }) => current.app).join(', ');
  const { address } = input;
  if (
    address !== undefined &&
    !recorded.some(({ current }) => current.addresses.includes(address))
  ) {
    throw addressUnknown(
      recorded.map(({ current }) => current),
      address,
    );
  }

  const sources: LogSource[] = [];
  for (const { target, current } of recorded) {
    if (address !== undefined && !current.addresses.includes(address)) continue;
    const attachment = await fromTarget(async () =>
      target.attach({
        container: await target.container.ensure({ appName: current.app, stage: undefined }),
        devDir,
      }),
    );
    const services = (await fromTarget(() => attachment.endpoints()))
      .map((endpoint) => endpoint.address)
      .filter((service) => address === undefined || service === address)
      .sort();
    if (address !== undefined && services.length === 0) {
      // The attachment does not list it as a service. Rule out the states that
      // would also hide a service before saying it is not one: its emulator is
      // down, or the emulator lost it.
      const location = await locateRecorded(current, address);
      if (location.emulator === 'not-running') throw emulatorNotRunning(address, location.kind);
      if (location.condition === 'missing') throw notRunning(address, location);
      const { kind } = location;
      throw new CliStructuredError(
        'DEV.NO_LOGS',
        `"${address}" is a ${kind}, and only services have logs.`,
        {
          why: `A service's logs are what its process writes to stdout and stderr; a ${kind} runs none of your code.`,
          fix: 'Pass the address of a service, or no address for every service.',
          meta: { address, kind },
        },
      );
    }
    const [first] = services;
    if (first === undefined) continue;
    // One look per app: its services all run on the same emulator.
    const location = await locateRecorded(current, first);
    if (location.emulator === 'not-running') throw emulatorNotRunning(first, location.kind);
    sources.push({ attachment, services });
  }
  return { app, sources };
}

function logsUnsupported(): CliStructuredError {
  return new CliStructuredError(
    'DEV.LOGS_UNSUPPORTED',
    "The extension that runs this app locally cannot read its services' logs without following them.",
    {
      why: 'It is older than the Composer that runs this command, which reads logs through a newer interface.',
      fix: "Upgrade the app's Composer packages to the version the `prisma` CLI uses, or follow the logs instead.",
    },
  );
}

/**
 * Every source's current lines, one service after another in address order.
 * A read cut short by `input.signal` is the caller stopping, not the emulator
 * failing: it ends with the lines read so far, and the host settles the
 * interrupt from its own record of the signal.
 */
async function readLines(
  sources: readonly LogSource[],
  input: DevLogsInput,
  tail: number,
): Promise<LogLine[]> {
  const lines: LogLine[] = [];
  for (const { attachment, services } of sources) {
    const { readLogs } = attachment;
    if (readLogs === undefined) throw logsUnsupported();
    const wanted = new Set(services);
    let read: readonly LogLine[];
    try {
      read = await readLogs({
        tail,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      if (input.signal?.aborted === true) break;
      throw toStructured('DEV.EMULATOR_FAILED', error);
    }
    lines.push(...read.filter(({ service }) => wanted.has(service)));
  }
  // A stable sort, so each service's lines keep their order.
  return lines.sort((a, b) => (a.service < b.service ? -1 : a.service > b.service ? 1 : 0));
}

async function* fromArray(lines: readonly LogLine[]): AsyncGenerator<LogLine, void, undefined> {
  yield* lines;
}

export async function executeDevLogs(
  input: DevLogsInput,
  cwd: string,
): Promise<Result<DevLogs, CliStructuredError>> {
  if (process.platform === 'win32') return notOk(platformUnsupported());
  const tail = Math.max(0, Math.trunc(input.tail ?? DEV_LOGS_DEFAULT_TAIL));
  try {
    const { app, sources } = await logSources(input, cwd);
    const services = sources.flatMap((source) => source.services).sort();
    if (input.follow === true) {
      const lines = mergeLogStreams(
        sources.map((source) => source.attachment),
        { address: input.address, tail, signal: input.signal, onEvent: input.onEvent },
      );
      return ok({ app, services, lines });
    }
    // Read before returning, so a failure is the operation's failure rather
    // than a throw out of the stream.
    return ok({ app, services, lines: fromArray(await readLines(sources, input, tail)) });
  } catch (error) {
    if (CliStructuredError.is(error)) return notOk(error);
    throw error;
  }
}

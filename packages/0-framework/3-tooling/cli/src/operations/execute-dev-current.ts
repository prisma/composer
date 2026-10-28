/**
 * The `devUrl` and `devStop` executor: config → each extension's local
 * target → the app's local copy in the environment, read from that
 * environment's dev state. Reached only by lazy import from dev-current.ts —
 * resolving the local targets loads their descriptors, whose graphs reach
 * alchemy's provider tree.
 */
import * as path from 'node:path';
import type { LocalNodeLocation, LocalTargetCurrentApp } from '@internal/core/local-target';
import { devEnvironmentDir, resolveLocalTargets } from '@internal/core/local-target';
import { CliStructuredError, InternalError } from '@internal/foundation/errors';
import { notOk, ok, type Result } from '@internal/foundation/result';
import type { ComposerConfigSource } from '../composer-config.ts';
import { checkConfigSource, resolveAppIdentity } from '../pipeline.ts';
import { validateEnvironmentName } from '../validate-environment.ts';
import type { DevStopInput, DevStopped, DevUrl, DevUrlInput } from './dev-current.ts';
import { requireDevEnvironmentName } from './dev-environment-name.ts';
import { DEV_ENVIRONMENT, toStructured } from './shared.ts';

function platformUnsupported(): CliStructuredError {
  return new CliStructuredError(
    'DEV.PLATFORM_UNSUPPORTED',
    'local dev is not supported on Windows yet.',
  );
}

/** The `prisma dev` command that runs `environment`. */
function runDev(environment: string): string {
  return environment === DEV_ENVIRONMENT
    ? '`prisma dev`'
    : `\`prisma dev --environment ${environment}\``;
}

/** A call into an extension's local target; its failures that carry no code are the emulator's. */
async function fromTarget<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toStructured('DEV.EMULATOR_FAILED', error);
  }
}

interface LocalCopy {
  readonly config: ComposerConfigSource;
  readonly app: string;
  readonly environment: string;
}

/** Every extension's record of the app in the environment; fails when none recorded it. */
async function currentApps(copy: LocalCopy, cwd: string): Promise<LocalTargetCurrentApp[]> {
  const { app, environment } = copy;
  const { value } = checkConfigSource(copy.config, cwd);
  const devDir = path.join(cwd, devEnvironmentDir(environment));
  requireDevEnvironmentName(devDir, environment);
  const apps: LocalTargetCurrentApp[] = [];
  for (const target of (await resolveLocalTargets(value)).values()) {
    const current = await fromTarget(async () => target.current?.({ devDir, app, environment }));
    if (current !== undefined) apps.push(current);
  }
  if (apps.length === 0) {
    throw new CliStructuredError(
      'DEV.NOT_STARTED_HERE',
      `\`prisma dev\` has not run ${app} in the environment ${environment} in ${cwd}.`,
      {
        why: `The local services, databases and buckets of an app are recorded in ${devDir} when \`prisma dev\` runs it in the environment ${environment}, and ${app} has no such record.`,
        fix: `Run ${runDev(environment)} for ${app} in this directory.`,
        meta: { cwd, app, environment },
      },
    );
  }
  return apps;
}

/** The app a full address starts with: `shop.api` belongs to `shop`. */
function appOfAddress(address: string): string {
  const dot = address.indexOf('.');
  return dot === -1 ? address : address.slice(0, dot);
}

async function locate(input: DevUrlInput, cwd: string): Promise<DevUrl> {
  const environment = input.environment ?? DEV_ENVIRONMENT;
  validateEnvironmentName(environment);
  const app = appOfAddress(input.address);
  const apps = await currentApps({ config: input.config, app, environment }, cwd);
  const recorded = apps.find((candidate) => candidate.addresses.includes(input.address));
  if (recorded === undefined) {
    const known = apps.flatMap((candidate) => candidate.addresses).sort();
    throw new CliStructuredError(
      'DEV.ADDRESS_UNKNOWN',
      `"${app}" has no node at "${input.address}" in the environment ${environment}.`,
      {
        why: `The addresses recorded for ${app} in the environment ${environment} are: ${known.join(', ')}.`,
        fix: 'Pass one of those addresses. A nested node has a dotted address, such as `shop.catalog.database`.',
        meta: { address: input.address, known },
      },
    );
  }
  const location = await fromTarget(() => recorded.locate(input.address));
  if (location === undefined) {
    throw new InternalError(`the local target recorded "${input.address}" but cannot locate it`);
  }
  if (location.emulator === 'not-running') {
    throw new CliStructuredError(
      'DEV.EMULATOR_UNREACHABLE',
      `The local ${location.kind} emulator that runs "${input.address}" is not running.`,
      {
        why: 'The local emulators run your services, databases and buckets on this machine; `prisma dev` starts the ones an app needs.',
        fix: `Run ${runDev(environment)} in this directory.`,
        meta: { address: input.address, kind: location.kind },
      },
    );
  }
  if (location.condition !== 'running') throw notRunning(input.address, environment, location);
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
  environment: string,
  location: Extract<LocalNodeLocation, { emulator: 'running' }>,
): CliStructuredError {
  const rerun = `Run ${runDev(environment)} in this directory.`;
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
      fix: `${rerun} It creates the ${kind} again, empty.`,
      meta,
    });
  }
  return new CliStructuredError('DEV.NOT_RUNNING', `The ${kind} "${address}" is stopped.`, {
    why: "`prisma dev stop` and `prisma dev` ending both stop an app's services and database servers, and a stopped node has no URL that answers.",
    fix: rerun,
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
    const environment = input.environment ?? DEV_ENVIRONMENT;
    validateEnvironmentName(environment);
    const { name: app } = await resolveAppIdentity(input.entry, input.name, cwd, input.config);
    const apps = await currentApps({ config: input.config, app, environment }, cwd);
    const stopped = [];
    for (const recorded of apps) stopped.push(...(await fromTarget(() => recorded.stop())));
    return ok({ app, environment, stopped });
  } catch (error) {
    if (CliStructuredError.is(error)) return notOk(error);
    throw error;
  }
}

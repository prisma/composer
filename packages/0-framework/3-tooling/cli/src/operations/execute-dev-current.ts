/**
 * The `devUrl` and `devStop` executor: config → each extension's local
 * target → the app it recorded in the directory's dev state. Reached only by
 * lazy import from dev-current.ts — resolving the local targets loads their
 * descriptors, whose graphs reach alchemy's provider tree.
 */
import * as path from 'node:path';
import type { LocalTargetCurrentApp } from '@internal/core/local-target';
import { DEV_DIR, resolveLocalTargets } from '@internal/core/local-target';
import { CliStructuredError } from '@internal/foundation/errors';
import { notOk, ok, type Result } from '@internal/foundation/result';
import { checkConfigSource } from '../pipeline.ts';
import type { DevStopInput, DevStopped, DevUrl, DevUrlInput } from './dev-current.ts';
import { toStructured } from './shared.ts';

const RUN_DEV = 'Run `prisma dev <entry>` in this directory.';

function platformUnsupported(): CliStructuredError {
  return new CliStructuredError(
    'DEV.PLATFORM_UNSUPPORTED',
    'local dev is not supported on Windows yet.',
  );
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
    const current = await target.current?.({ devDir });
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
        fix: 'Pass one of those addresses. A node in a nested module has a dotted address, such as `catalog.database`.',
        meta: { address: input.address, known },
      },
    );
  }
  const location = await app.locate(input.address);
  if (location === undefined)
    throw new Error(`no location for recorded address "${input.address}"`);
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
  if (location.state !== 'running' || location.url === undefined) {
    throw new CliStructuredError(
      'DEV.NOT_RUNNING',
      `The ${location.kind} "${input.address}" is not running (${location.state}).`,
      {
        why: '`prisma dev` stops the app when it ends, and a stopped node has no URL that answers.',
        fix: RUN_DEV,
        meta: { address: input.address, kind: location.kind, state: location.state },
      },
    );
  }
  return { address: input.address, kind: location.kind, url: location.url, state: location.state };
}

export async function executeDevUrl(
  input: DevUrlInput,
  cwd: string,
): Promise<Result<DevUrl, CliStructuredError>> {
  if (process.platform === 'win32') return notOk(platformUnsupported());
  try {
    return ok(await locate(input, cwd));
  } catch (error) {
    // An emulator's own failure (not "unreachable", which arrives
    // structured) reaches here plain.
    return notOk(toStructured('DEV.EMULATOR_FAILED', error));
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
    for (const app of apps) stopped.push(...(await app.stop()));
    return ok({ app: apps.map((a) => a.app).join(', '), stopped });
  } catch (error) {
    return notOk(toStructured('DEV.EMULATOR_FAILED', error));
  }
}

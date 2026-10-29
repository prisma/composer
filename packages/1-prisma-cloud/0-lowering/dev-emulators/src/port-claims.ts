/**
 * The ports every emulator on this machine holds, whatever its registry
 * root. An instance holds its port while it is stopped, when no process has
 * it bound, so a bind probe alone would hand it to another emulator. Each
 * emulator process publishes the ports it holds in `<pid>.json` under
 * `~/.prisma-composer/port-claims/`, and allocates only under the folder's
 * lock, excluding every live process's claims and publishing its own before
 * the lock is released.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as properLockfile from 'proper-lockfile';
import { isPidAlive } from './daemon.ts';
import { readJsonFile, StateFile } from './state-file.ts';

const LOCK_RETRY_INTERVAL_MS = 100;
const LOCK_WAIT_BUDGET_MS = 10_000;
const LOCK_STALE_MS = 10_000;

interface ClaimsFile {
  readonly pid: number;
  readonly ports: readonly number[];
}

function isClaimsFile(value: unknown): value is ClaimsFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'pid' in value &&
    typeof value.pid === 'number' &&
    'ports' in value &&
    Array.isArray(value.ports) &&
    value.ports.every((port) => typeof port === 'number')
  );
}

export function portClaimsDir(): string {
  return path.join(os.homedir(), '.prisma-composer', 'port-claims');
}

export class PortClaims {
  private readonly ownPath: string;
  private readonly own: StateFile<ClaimsFile>;

  constructor(private readonly dir: string = portClaimsDir()) {
    this.ownPath = path.join(dir, `${String(process.pid)}.json`);
    this.own = new StateFile(this.ownPath);
  }

  /** Runs `allocate` while no other emulator allocates, given the ports other live emulators hold, and publishes `held()` before any other emulator allocates. */
  async allocate<T>(
    allocate: (claimedElsewhere: ReadonlySet<number>) => Promise<T>,
    held: () => Iterable<number>,
  ): Promise<T> {
    const release = await this.lock();
    try {
      const result = await allocate(await this.claimedElsewhere());
      await this.publish(held());
      return result;
    } finally {
      await release();
    }
  }

  publish(ports: Iterable<number>): Promise<void> {
    return this.own.write({ pid: process.pid, ports: [...new Set(ports)].sort((a, b) => a - b) });
  }

  /** Removes this process's claims; for exit, when every port it held is released. */
  withdraw(): void {
    fs.rmSync(this.ownPath, { force: true });
  }

  private async claimedElsewhere(): Promise<Set<number>> {
    const claimed = new Set<number>();
    for (const name of await fsp.readdir(this.dir)) {
      const file = path.join(this.dir, name);
      if (!name.endsWith('.json') || file === this.ownPath) continue;
      const claims = await readJsonFile(file, isClaimsFile);
      if (claims === undefined || !isPidAlive(claims.pid)) {
        await fsp.rm(file, { force: true });
        continue;
      }
      for (const port of claims.ports) claimed.add(port);
    }
    return claimed;
  }

  private async lock(): Promise<() => Promise<void>> {
    await fsp.mkdir(this.dir, { recursive: true });
    const target = path.join(this.dir, '.lock-target');
    await fsp.writeFile(target, '', { flag: 'a' });
    return properLockfile.lock(target, {
      stale: LOCK_STALE_MS,
      retries: {
        retries: Math.floor(LOCK_WAIT_BUDGET_MS / LOCK_RETRY_INTERVAL_MS),
        minTimeout: LOCK_RETRY_INTERVAL_MS,
        maxTimeout: LOCK_RETRY_INTERVAL_MS,
        factor: 1,
      },
    });
  }
}

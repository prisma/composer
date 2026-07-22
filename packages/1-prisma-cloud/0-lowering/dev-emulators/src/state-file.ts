/**
 * Temp-then-rename JSON state-file writes behind one in-process queue (spec
 * local-dev § 2, "API hygiene, both daemons"): each daemon is single-process,
 * so concurrent HTTP handlers mutating the same state file serialize their
 * writes through a `StateFile` instance instead of racing each other on disk.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export class StateFile<T> {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly mode?: number,
  ) {}

  /** Serializes `value` to disk, temp-then-rename, behind this file's write queue. */
  write(value: T): Promise<void> {
    const next = this.queue.then(() => this.writeNow(value));
    // A failed write must not wedge the queue for subsequent writes.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async writeNow(value: T): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = path.join(dir, `.${path.basename(this.filePath)}.${randomUUID()}.tmp`);
    const json = `${JSON.stringify(value, null, 2)}\n`;
    await fs.writeFile(tmpPath, json, this.mode !== undefined ? { mode: this.mode } : undefined);
    await fs.rename(tmpPath, this.filePath);
    if (this.mode !== undefined) await fs.chmod(this.filePath, this.mode);
  }
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

/**
 * Reads and parses a JSON state file, narrowing the parsed value with
 * `isValid` (a real type predicate, not a cast — the file's shape is only
 * trustworthy because this daemon is its only writer, but a foreign or
 * corrupt file on disk must not be treated as valid state). `undefined` when
 * absent, unreadable, or shaped wrong.
 */
export async function readJsonFile<T>(
  filePath: string,
  isValid: (value: unknown) => value is T,
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isValid(parsed) ? parsed : undefined;
}

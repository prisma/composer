/**
 * The shared dev-instance store (local-dev spec § 4): the JSON files under
 * `<devDir>/` every local provider reads or writes. Every write is
 * temp-then-rename; reads and writes on the SAME file are additionally
 * serialized behind one in-process async queue per absolute path, because the
 * local providers reconcile concurrently inside the one alchemy child and a
 * naive read-modify-write would drop a concurrent writer's key. Postgres
 * instance state is NOT here (REVISED — operator review of #162): the
 * `postgres-main` daemon owns it now.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

// One queue per absolute file path, at module scope — so every caller across
// every provider factory (each of which may construct its own `DevStore`
// handle) serializes through the SAME queue for a given file, not just
// callers sharing one JS object.
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const prior = (queues.get(filePath) ?? Promise.resolve()).then(
    () => undefined,
    () => undefined,
  );
  const result = prior.then(task);
  queues.set(
    filePath,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

async function readJson<T>(
  filePath: string,
  isValid: (value: unknown) => value is T,
  empty: T,
): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return empty;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty; // a corrupt/foreign file is treated as absent, never trusted
  }
  return isValid(parsed) ? parsed : empty;
}

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  mode: number | undefined,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(tmpPath, json, mode !== undefined ? { mode } : undefined);
  await fs.rename(tmpPath, filePath);
  if (mode !== undefined) await fs.chmod(filePath, mode);
}

export interface DevStore<T> {
  /** The current contents — the empty shape when the file has never been written. */
  read(): Promise<T>;
  /** Read-modify-write behind this file's queue: `mutate` sees the latest committed contents. */
  update(mutate: (current: T) => T): Promise<T>;
}

function createStore<T>(
  filePath: string,
  isValid: (value: unknown) => value is T,
  empty: T,
  mode?: number,
): DevStore<T> {
  return {
    read: () => enqueue(filePath, () => readJson(filePath, isValid, empty)),
    update: (mutate) =>
      enqueue(filePath, async () => {
        const current = await readJson(filePath, isValid, empty);
        const next = mutate(current);
        await writeJsonAtomic(filePath, next, mode);
        return next;
      }),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

/** `<devDir>/env.json` — every `EnvironmentVariable` row, key → value. Last write wins. */
export function envStore(devDir: string): DevStore<Record<string, string>> {
  return createStore(path.join(devDir, 'env.json'), isStringRecord, {});
}

/** `<devDir>/secrets.json` — platform var name → value (shell-sourced or minted placeholder). Mode 0o600. */
export function secretsStore(devDir: string): DevStore<Record<string, string>> {
  return createStore(path.join(devDir, 'secrets.json'), isStringRecord, {}, 0o600);
}

/**
 * The fs-touching half of `--fresh` teardown (local-dev spec § 5,
 * ADR-0041 D12). The target extension's `dev/teardown.ts` orchestrates
 * (which app, which emulator clients); this module owns the actual
 * filesystem operations, so the extension's own source stays free of
 * `node:`/`bun:` imports (its invariant 5). Emulator instances are not
 * removed here: the extension deletes them through the directory's record.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BUCKETS_DIR } from './bucket.ts';
import { EMULATOR_INSTANCES_FILE } from './emulator-instances.ts';

/** `fs.rm(..., { recursive: true, force: true })` for every given path — tolerates absence. */
export function removeLocalPaths(paths: readonly string[]): void {
  for (const target of paths) fs.rmSync(target, { recursive: true, force: true });
}

/**
 * Removes the dev state directory's contents for `--fresh`, except what
 * other apps run from the directory still use: the record of their emulator
 * instances and their buckets' objects. This app's objects go.
 */
export function removeAppDevState(devDir: string, app: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(devDir);
  } catch {
    return;
  }
  const kept = new Set([EMULATOR_INSTANCES_FILE, BUCKETS_DIR]);
  removeLocalPaths([
    ...entries.filter((entry) => !kept.has(entry)).map((entry) => path.join(devDir, entry)),
    path.join(devDir, BUCKETS_DIR, app),
  ]);
}

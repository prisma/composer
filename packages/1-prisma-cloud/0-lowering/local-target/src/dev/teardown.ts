/**
 * The fs-touching half of `--fresh` teardown (local-dev spec § 5,
 * ADR-0041 D12). The target extension's `dev/teardown.ts` orchestrates
 * (which app, which emulator clients); this module owns the actual
 * filesystem operations, so the extension's own source stays free of
 * `node:`/`bun:` imports (its invariant 5). Postgres instance removal is
 * NOT here (REVISED — operator review of #162): it is a
 * `postgresClient().deleteApp(app)` call, made directly alongside the
 * compute/buckets clients — no filesystem or child-process work of its own.
 */
import * as fs from 'node:fs';

/** `fs.rm(..., { recursive: true, force: true })` for every given path — tolerates absence. */
export function removeLocalPaths(paths: readonly string[]): void {
  for (const target of paths) fs.rmSync(target, { recursive: true, force: true });
}

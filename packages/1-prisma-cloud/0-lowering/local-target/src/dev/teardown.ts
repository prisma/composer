/**
 * The node/fs/process-touching half of `--fresh` teardown (local-dev spec
 * § 5, ADR-0041 D12). The target extension's `dev/teardown.ts` orchestrates
 * (which app, which emulator clients); this module owns every actual
 * filesystem and child-process operation, so the extension's own source stays
 * free of `node:`/`bun:` imports (its invariant 5).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { slug } from './postgres.ts';
import { resolveLocalBin } from './resolve-bin.ts';
import { combinedOutput } from './spawn-utils.ts';

const NOT_FOUND_PATTERN = /no .*servers? found/i;

function runPrismaDevCommand(bin: string, args: readonly string[]): void {
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  if (result.status === 0 || result.status === null) return;
  const output = combinedOutput(result);
  if (NOT_FOUND_PATTERN.test(output)) return;
  throw new Error(`\`${bin} ${args.join(' ')}\` failed (exit ${String(result.status)}): ${output}`);
}

/**
 * Stops and removes every `pcdev-<slug(app)>-*` local Postgres instance —
 * the SAME name slugging `postgres.ts`'s `instanceName` uses to derive an
 * instance name, or an app name containing slugged characters (spaces,
 * dots, uppercase, …) would orphan its instances. A missing `prisma` bin
 * means the app never used postgres — nothing to remove. `startDir` is the
 * caller's `process.cwd()` (kept out of this package's own env/cwd reads
 * elsewhere — only bin resolution is legitimately cwd-relative).
 */
export function removeLocalPostgresInstances(startDir: string, app: string): void {
  const bin = resolveLocalBin(startDir, 'prisma');
  if (bin === undefined) return;
  const glob = `pcdev-${slug(app)}-*`;
  runPrismaDevCommand(bin, ['dev', 'stop', glob]);
  runPrismaDevCommand(bin, ['dev', 'rm', glob]);
}

/** `fs.rm(..., { recursive: true, force: true })` for every given path — tolerates absence. */
export function removeLocalPaths(paths: readonly string[]): void {
  for (const target of paths) fs.rmSync(target, { recursive: true, force: true });
}

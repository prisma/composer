#!/usr/bin/env node
/**
 * CI ratchet for bare `as` casts.
 *
 * Counts diagnostics from the `no-bare-cast` Biome plugin at HEAD and at
 * `git merge-base origin/main HEAD`. Exits non-zero and lists the new cast
 * sites when HEAD's count exceeds the merge-base count.
 *
 * The merge-base is checked out into a temporary git worktree. HEAD's biome
 * config + plugin are copied into the scanned tree so biome auto-discovers them
 * at the tree root — this anchors the config's relative `files.includes`
 * excludes (e.g. `!docs`, `!orm`) to the same root for both scans, so
 * the two counts are comparable. (Passing `--config-path` to a foreign cwd
 * instead anchors those excludes inconsistently.) The baseline is thus "the old
 * source measured by the current rule" — which lets the PR that first
 * introduces this plugin measure the merge-base under it, and only NEW casts
 * count against the ratchet.
 *
 * Exit codes:
 *   0  — cast count did not increase (or skipped because HEAD == merge-base)
 *   1  — cast count increased; new sites printed to stderr
 *
 * The script uses process.cwd() as the git root so tests can supply a
 * temporary fixture repo by setting cwd on the child process.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The real repo root (where biome binary + config + plugin live) — always the
// directory that contains this script's parent, regardless of cwd.
const REAL_REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BIOME_BIN = join(REAL_REPO_ROOT, 'node_modules', '.bin', 'biome');
const BIOME_CONFIG = join(REAL_REPO_ROOT, 'biome.jsonc');
const BIOME_PLUGINS = join(REAL_REPO_ROOT, 'biome-plugins');

// Git root: process.cwd() so tests can override by setting cwd.
const GIT_ROOT = process.cwd();

// Put HEAD's config + plugin at the scanned tree's root so biome discovers them
// there and anchors relative excludes to that root. Skip the real repo, where
// they already live (copying onto themselves would throw).
function ensureConfig(scanDir) {
  if (resolve(scanDir) === resolve(REAL_REPO_ROOT)) return;
  cpSync(BIOME_CONFIG, join(scanDir, 'biome.jsonc'));
  cpSync(BIOME_PLUGINS, join(scanDir, 'biome-plugins'), { recursive: true });
  // The config's `vcs.useIgnoreFile` makes biome require an ignore file at the
  // root; a tree without one (a throwaway fixture repo) needs an empty stand-in.
  const gitignore = join(scanDir, '.gitignore');
  if (!existsSync(gitignore)) writeFileSync(gitignore, '');
}

export function filterNoBarecastDiags(diagnostics) {
  return diagnostics.filter(
    (d) =>
      d.category === 'plugin' &&
      typeof d.message === 'string' &&
      d.message.startsWith('no-bare-cast: '),
  );
}

function countCastsInDir(scanDir) {
  ensureConfig(scanDir);
  const result = spawnSync(BIOME_BIN, ['lint', '--reporter=json', '.'], {
    cwd: scanDir,
    encoding: 'utf-8',
    maxBuffer: 100 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`biome spawn failed: ${result.error.message}`);
  }

  const raw = (result.stdout ?? '').trim();
  if (!raw) return { count: 0, sites: [] };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `biome JSON parse failed: ${e.message}\nraw output (first 500 chars): ${raw.slice(0, 500)}`,
    );
  }

  const diags = filterNoBarecastDiags(parsed.diagnostics ?? []);
  const sites = diags.map((d) => {
    const loc = d.location ?? {};
    return `${loc.path ?? ''}:${loc.start?.line ?? 0}`;
  });

  return { count: diags.length, sites };
}

function git(...args) {
  return execFileSync('git', args, { cwd: GIT_ROOT, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function main() {
  try {
    git('rev-parse', 'origin/main');
  } catch {
    console.error('lint:casts: error — origin/main is not available.');
    console.error('  Run: git fetch --no-tags origin main:refs/remotes/origin/main');
    console.error('  Or ensure the CI checkout uses fetch-depth: 0.');
    process.exit(1);
  }

  const head = git('rev-parse', 'HEAD');
  const mergeBase = git('merge-base', 'origin/main', 'HEAD');

  if (head === mergeBase) {
    console.log(
      'lint:casts: HEAD is at merge-base with origin/main — no branch diff to ratchet. Skipping.',
    );
    process.exit(0);
  }

  const headResult = countCastsInDir(GIT_ROOT);

  const tmpDir = mkdtempSync(join(tmpdir(), 'lint-casts-'));
  let baseResult;
  try {
    git('worktree', 'add', '--detach', tmpDir, mergeBase);
    baseResult = countCastsInDir(tmpDir);
  } finally {
    try {
      git('worktree', 'remove', '--force', tmpDir);
    } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const delta = headResult.count - baseResult.count;
  const sign = delta > 0 ? '+' : '';
  console.log(
    `lint:casts: current=${headResult.count} merge-base=${baseResult.count} delta=${sign}${delta}`,
  );

  if (delta > 0) {
    const baseSet = new Set(baseResult.sites);
    const added = headResult.sites.filter((s) => !baseSet.has(s));
    console.error(
      `lint:casts: ${delta} new bare \`as\` cast(s) introduced. Replace with blindCast<T, "reason">(...) or castAs<T>(value):`,
    );
    for (const site of added) {
      console.error(`  ${site}`);
    }
    process.exit(1);
  }
}

if (process.argv[1] === import.meta.filename) main();

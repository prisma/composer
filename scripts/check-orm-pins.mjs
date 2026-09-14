#!/usr/bin/env node

// Every `@prisma/orm-*` pin in the workspace must be the same version:
// the pins ship inside the assembled `prisma` CLI, and a stale one drags
// its own copy of the toolchain into user installs. That is how
// orm-postgres@rc.1 sat beside orm-toolchain@rc.4 and re-broke composer
// commands after the rc.4 bump (2026-08-18).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'pathe';

const ORM_PACKAGE_PATTERN = /^@prisma\/orm-/;
const DEPENDENCY_MAPS = ['dependencies', 'devDependencies', 'peerDependencies'];

/**
 * @param {readonly {path: string, deps: Readonly<Record<string, string>>}[]} manifests
 * @returns {readonly string[]} one line per disagreeing pin
 */
export function ormPinViolations(manifests) {
  const versions = new Map();
  for (const { deps } of manifests) {
    for (const [name, version] of Object.entries(deps)) {
      if (!ORM_PACKAGE_PATTERN.test(name) || version.startsWith('workspace:')) continue;
      versions.set(version, true);
    }
  }
  if (versions.size <= 1) return [];
  const newest = [...versions.keys()].sort().at(-1);
  const violations = [];
  for (const { path, deps } of manifests) {
    for (const [name, version] of Object.entries(deps)) {
      if (!ORM_PACKAGE_PATTERN.test(name) || version.startsWith('workspace:')) continue;
      if (version !== newest) {
        violations.push(
          `${path}: ${name}@${version} disagrees with ${newest}, the newest ORM pin in the tree`,
        );
      }
    }
  }
  return violations;
}

function isDirectRun() {
  return (
    process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop())
  );
}

if (isDirectRun()) {
  const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const files = execFileSync('git', ['ls-files', '*package.json'], {
    cwd: rootDir,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter(Boolean);
  const manifests = [];
  for (const path of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(`${rootDir}/${path}`, 'utf-8'));
    } catch {
      continue; // a fixture, not a manifest
    }
    const deps = {};
    for (const map of DEPENDENCY_MAPS) Object.assign(deps, parsed[map] ?? {});
    manifests.push({ path, deps });
  }
  const violations = ormPinViolations(manifests);
  if (violations.length > 0) {
    console.error(`check-orm-pins: ${violations.length} disagreeing ORM pin(s):`);
    for (const line of violations) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log('check-orm-pins: every ORM-family pin agrees.');
}

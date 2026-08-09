#!/usr/bin/env node
// Committed copies of one contract must carry the same emitted types.
//
// The repo commits the same contract in more than one place: a project's
// emitted `contract.json` + `contract.d.ts`, and the content-addressed
// `migrations/snapshots/<hex>/` entry every generated `migration.ts` imports
// its bookend contracts from. Nothing re-derives those together.
//
// `contract.d.ts` carries type-level material that is not part of the
// contract's hash — the `AggregateTypes` block, for one. So a re-emit can
// leave every hash untouched, update the emitted types, and silently strand
// the store's copy. `migration plan` reads the store's copy, so the stale
// types are what a regenerated migration would import. That is not
// hypothetical: the 8.0.0-rc.1 upgrade did exactly this to all five stores.
//
// Files are grouped by canonical contract content, NOT by storage hash. The
// storage hash covers the `storage` subtree alone, so two genuinely different
// contracts can share one — an app contract and the same schema with an
// extension pack registered, for instance — and grouping by hash reports them
// as a conflict when nothing is wrong.
//
// Usage: node scripts/lint-contract-snapshots.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function trackedJson() {
  return execFileSync('git', ['ls-files', '-z', '*.json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

/** Emitted-type files grouped by the canonical content of the contract beside them. */
const byContract = new Map();

for (const file of trackedJson()) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  if (typeof parsed?.storage?.storageHash !== 'string') continue;
  const types = join(dirname(file), 'contract.d.ts');
  if (!existsSync(types)) continue;
  const key = canonical(parsed);
  const group = byContract.get(key) ?? [];
  if (!group.some((member) => member.types === types)) group.push({ file, types });
  byContract.set(key, group);
}

const problems = [];
let compared = 0;

for (const members of byContract.values()) {
  if (members.length < 2) continue;
  compared += 1;
  const [first, ...rest] = members;
  const expected = readFileSync(first.types, 'utf8');
  for (const member of rest) {
    if (readFileSync(member.types, 'utf8') !== expected) {
      problems.push(`${member.types}\n    differs from ${first.types}`);
    }
  }
}

if (problems.length > 0) {
  console.error(
    '✖ contract-snapshots: committed copies of one contract carry different emitted types:\n',
  );
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nRe-emit the contract, then copy its contract.d.ts over every committed copy — including the migrations/snapshots/<hash>/ entry.',
  );
  process.exit(1);
}

console.log(`✔ contract-snapshots: ${compared} contract(s) agree across every committed copy`);

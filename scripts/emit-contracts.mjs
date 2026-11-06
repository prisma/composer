#!/usr/bin/env node

// Emitted contracts (`contract.json`, `contract.d.ts`) are written only by
// `prisma contract emit`, then formatted as a commit formats them. This
// re-emits every committed contract: each `prisma.config.ts` that configures
// the ORM and whose output directory holds a committed `contract.json`.
// `--check` fails when the committed files differ from what the pinned
// toolchain emits, which catches a missed contract and a hand edit alike.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const tracked = new Set(run('git', ['ls-files']).split('\n'));

const contracts = run('git', ['ls-files', '*prisma.config.ts'])
  .split('\n')
  .filter((file) => file !== '')
  .map((config) => {
    const source = readFileSync(join(root, config), 'utf8');
    const output = /output:\s*'([^']+)'/.exec(source)?.[1] ?? '.';
    const outputDir = relative(root, join(root, dirname(config), output));
    return { config, source, outputDir };
  })
  .filter(
    ({ source, outputDir }) =>
      source.includes('@prisma/orm-postgres/config') &&
      tracked.has(join(outputDir, 'contract.json')),
  );

const prisma = join(root, 'node_modules', '.bin', 'prisma');
const emitted = [];
for (const { config, outputDir } of contracts) {
  process.stdout.write(`emit ${config}\n`);
  run(prisma, ['contract', 'emit', '--config', 'prisma.config.ts'], join(root, dirname(config)));
  emitted.push(join(outputDir, 'contract.json'), join(outputDir, 'contract.d.ts'));
}
run('pnpm', ['exec', 'biome', 'format', '--write', ...emitted]);
run('pnpm', ['exec', 'biome', 'check', '--write', ...emitted]);

if (check) {
  const changed = [
    run('git', ['diff', '--name-only', '--', ...emitted]),
    run('git', ['ls-files', '--others', '--exclude-standard', '--', ...emitted]),
  ]
    .join('')
    .trim();
  if (changed !== '') {
    process.stderr.write(
      `\nCommitted contracts differ from what \`pnpm contracts:emit\` writes:\n${changed}\n` +
        'Emitted contracts are never edited by hand. Run `pnpm contracts:emit` and commit the result.\n',
    );
    process.exit(1);
  }
}

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

const ormConfigs = run('git', ['ls-files', '*prisma.config.ts'])
  .split('\n')
  .filter((file) => file !== '')
  .map((config) => ({ config, source: readFileSync(join(root, config), 'utf8') }))
  .filter(({ source }) => source.includes('@prisma/orm-postgres/config'))
  .map(({ config, source }) => {
    const output = /output:\s*'([^']+)'/.exec(source)?.[1];
    if (output === undefined && /\boutput\s*:/.test(source)) {
      throw new Error(
        `${config}: write \`output\` as a single-quoted path, so this script can find the contract.`,
      );
    }
    return { config, outputDir: relative(root, join(root, dirname(config), output ?? '.')) };
  });

const contracts = ormConfigs.filter(({ outputDir }) =>
  tracked.has(join(outputDir, 'contract.json')),
);
for (const { config, outputDir } of ormConfigs.filter((c) => !contracts.includes(c))) {
  process.stdout.write(`skip ${config}: no committed contract.json in ${outputDir || '.'}\n`);
}

// The examples' configs import the built extension packages.
run('pnpm', ['turbo', 'run', 'build', '--filter', '@prisma/composer-prisma-cloud...']);

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

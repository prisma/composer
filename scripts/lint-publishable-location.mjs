#!/usr/bin/env node
// Publishable-location gate (ADR-0028): the ONLY publishable packages live in
// packages/9-public/. Every other workspace package must carry
// `"private": true`, and everything in 9-public must be publishable. Makes
// The source tree and publishable workspace inventory must agree.
//
// Wired into `pnpm lint:deps` (local, lint-staged, and CI).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const manifests = execFileSync(
  'git',
  [
    'ls-files',
    'package.json',
    'packages/*/package.json',
    'packages/**/package.json',
    'examples/**/package.json',
    'test/**/package.json',
  ],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter((f) => f && !f.includes('node_modules'));

const violations = [];

for (const file of manifests) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  const inPublic = file.startsWith('packages/9-public/');
  const isPrivate = pkg.private === true;

  if (inPublic && isPrivate) {
    violations.push(
      `${file}: packages in 9-public/ are the published surface — must not be private`,
    );
  }
  if (!inPublic && !isPrivate) {
    violations.push(
      `${file}: publishable package outside packages/9-public/ — mark it "private": true or move it (ADR-0028)`,
    );
  }
}

if (violations.length > 0) {
  console.error(
    'Publishable-location violations:\n' + violations.map((v) => `  - ${v}`).join('\n'),
  );
  process.exit(1);
}
console.log(
  `✔ publishable-location: ${manifests.length} manifests checked — only 9-public/ is publishable`,
);

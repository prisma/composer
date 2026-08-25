#!/usr/bin/env node

import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rewriteWorkspaceDeps } from './set-version-utils.ts';
import { stampSkillVersion } from './skill-frontmatter.ts';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const version = process.argv[2];

if (!version) {
  const script = path.relative(process.cwd(), process.argv[1]);
  console.error(`Usage: node ${script} <version>`);
  console.error(`Example: node ${script} 0.1.0-dev.123`);
  process.exit(1);
}

interface PnpmPackage {
  name: string;
  version: string;
  path: string;
  private: boolean;
}

interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  [key: string]: unknown;
}

const output = execSync('pnpm list -r --json', {
  cwd: rootDir,
  encoding: 'utf-8',
});

const workspacePackages: PnpmPackage[] = JSON.parse(output);

let updatedCount = 0;

// Every workspace package — publishable, private, and the workspace
// root — gets the same version. Lockstep is the invariant that lets a
// single read of the root `package.json` answer "what version are we
// shipping right now?"; if private packages drifted, that invariant
// would be silently violated by direct invocations of this script.
for (const pkg of workspacePackages) {
  const packageJsonPath = path.join(pkg.path, 'package.json');
  const content = await fs.readFile(packageJsonPath, 'utf-8');
  const packageJson: PackageJson = JSON.parse(content);

  packageJson.version = version;
  rewriteWorkspaceDeps(packageJson, version);
  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  console.log(`Updated ${pkg.name} to ${version}`);
  updatedCount++;
}

// The `prisma-composer` skill ships inside the `@prisma/composer` tarball, so
// its `library_version` is part of the same lockstep stamp as the manifests:
// the version a reader of the skill sees is the version they installed.
const skillsDir = path.join(rootDir, 'skills');
const skillDirEntries = await fs.readdir(skillsDir, { withFileTypes: true });

let stampedSkills = 0;
for (const entry of skillDirEntries) {
  if (!entry.isDirectory()) continue;
  const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
  const source = await fs.readFile(skillPath, 'utf-8').catch(() => undefined);
  if (source === undefined) continue;

  await fs.writeFile(skillPath, stampSkillVersion(source, version));
  console.log(`Stamped ${path.relative(rootDir, skillPath)} with ${version}`);
  stampedSkills++;
}

console.log(`\nDone! Updated ${updatedCount} packages and ${stampedSkills} skills.`);

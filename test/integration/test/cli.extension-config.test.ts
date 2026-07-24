/**
 * Proves the extension-config design (ADR-0017) resolves REAL extension
 * `/control` entries — not fixtures. This cannot live in packages/app-cli's
 * own suite: the CLI itself must not depend on any specific extension (see
 * test/README.md), but this package genuinely does, so `prisma-composer deploy`
 * here evaluates this package's own `prisma-composer.config.ts`, whose static
 * imports of `@prisma/composer-prisma-cloud/control` and `@prisma/composer/node/control`
 * resolve from THIS app's own dependency tree — ambient resolution, no
 * anchor file, no framework-constructed specifier.
 *
 * Drives the CLI as a binary (`node_modules/.bin/prisma-composer`), the same way
 * the example apps do, rather than importing the CLI's internals.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const integrationDir = path.resolve(import.meta.dir, '..');
const prismaAppBin = path.join(integrationDir, 'node_modules', '.bin', 'prisma-composer');
const fixtureEntry = path.join(
  integrationDir,
  'test',
  'fixtures',
  'extension-config',
  'service.ts',
);

describe('prisma-composer deploy — real extension-config resolution of prisma-cloud + node', () => {
  // Spawns the real CLI, which resolves /control entries and evaluates a config —
  // inherently slower than bun test's default 5000ms, so give it real headroom.
  test('resolves both /control entries for real and fails at the missing built entry, not at resolution', () => {
    const result = spawnSync('bun', [prismaAppBin, 'deploy', fixtureEntry], {
      cwd: integrationDir,
      encoding: 'utf8',
      env: { ...process.env, PRISMA_WORKSPACE_ID: 'ws-integration-test' },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('Cannot resolve');
    expect(result.stderr).not.toContain('environment variable PRISMA_WORKSPACE_ID is required');
    expect(result.stderr).toContain('no built entry at');
    expect(result.stderr).toContain('run your build first');
  }, 30_000);

  // Local-dev spec § 5: prismaCloud() now constructs with NO environment
  // present (its `dev` field must be buildable credential-free), so
  // PRISMA_WORKSPACE_ID's absence no longer surfaces at config evaluation —
  // config evaluation is exactly where the OLD eager check used to fire, so
  // this proves the restructure through the real CLI path, not just a unit
  // test of prismaCloud() in isolation. The pipeline still reaches the same
  // "no built entry" failure assemble hits regardless of the env (container
  // resolution, which DOES still require PRISMA_WORKSPACE_ID, runs after
  // assemble and is never reached here either way).
  test('without PRISMA_WORKSPACE_ID, config evaluation still succeeds — deploy fails at the same missing-built-entry point as with the env var present', () => {
    const env = { ...process.env };
    delete env['PRISMA_WORKSPACE_ID'];

    const result = spawnSync('bun', [prismaAppBin, 'deploy', fixtureEntry], {
      cwd: integrationDir,
      encoding: 'utf8',
      env,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('Cannot resolve');
    expect(result.stderr).not.toContain('PRISMA_WORKSPACE_ID');
    expect(result.stderr).toContain('no built entry at');
    expect(result.stderr).toContain('run your build first');
  }, 30_000);
});

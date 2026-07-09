/**
 * Proves the CLI's entry-anchored module resolution (packages/makerkit-cli/
 * src/resolve-from-entry.ts) against REAL target/adapter packs — not
 * fixtures. This cannot live in packages/makerkit-cli's own suite: the CLI
 * itself must not depend on any specific pack (see test/README.md), but this
 * package genuinely does, so `makerkit deploy` here resolves
 * `@makerkit/prisma-cloud/target` and `@makerkit/node/assemble` for real.
 *
 * Drives the CLI as a binary (`node_modules/.bin/makerkit`), the same way
 * the example apps do, rather than importing the CLI's internals.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const integrationDir = path.resolve(import.meta.dir, '..');
const makerkitBin = path.join(integrationDir, 'node_modules', '.bin', 'makerkit');
const fixtureEntry = path.join(integrationDir, 'test', 'fixtures', 'entry-anchored', 'service.ts');

describe('makerkit deploy — real entry-anchored resolution of prisma-cloud + node', () => {
  test('resolves both packs for real and fails at the missing built entry, not at resolution', () => {
    const result = spawnSync('bun', [makerkitBin, 'deploy', fixtureEntry], {
      cwd: integrationDir,
      encoding: 'utf8',
      env: { ...process.env, PRISMA_WORKSPACE_ID: 'ws-integration-test' },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('Cannot resolve');
    expect(result.stderr).not.toContain('environment variable PRISMA_WORKSPACE_ID is required');
    expect(result.stderr).toContain('no built entry at');
    expect(result.stderr).toContain("run this app's own build first");
  });

  test('without PRISMA_WORKSPACE_ID, fails at the real prisma-cloud fromEnv() check — proving the /target entry actually resolved and ran', () => {
    const env = { ...process.env };
    delete env['PRISMA_WORKSPACE_ID'];

    const result = spawnSync('bun', [makerkitBin, 'deploy', fixtureEntry], {
      cwd: integrationDir,
      encoding: 'utf8',
      env,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('Cannot resolve');
    expect(result.stderr).toContain('environment variable PRISMA_WORKSPACE_ID is required');
  });
});

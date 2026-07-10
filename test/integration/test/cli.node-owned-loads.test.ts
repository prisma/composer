/**
 * Proves node-owned loads (packages/app/src/node.ts's
 * `loadTarget()`/`loadAssembler()`/`assemble()`) resolve REAL target/adapter
 * packs — not fixtures. This cannot live in packages/app-cli's own
 * suite: the CLI itself must not depend on any specific pack (see
 * test/README.md), but this package genuinely does, so `makerkit deploy`
 * here resolves `@prisma/app-cloud/target` and `@prisma/app-node/assemble`
 * for real, from THIS app's own dependency tree (no anchor file, no
 * framework-constructed specifier) — see this package's README.md for why
 * that requires `dependenciesMeta.*.injected` in package.json.
 *
 * Drives the CLI as a binary (`node_modules/.bin/makerkit`), the same way
 * the example apps do, rather than importing the CLI's internals.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const integrationDir = path.resolve(import.meta.dir, '..');
const makerkitBin = path.join(integrationDir, 'node_modules', '.bin', 'makerkit');
const fixtureEntry = path.join(
  integrationDir,
  'test',
  'fixtures',
  'node-owned-loads',
  'service.ts',
);

describe('makerkit deploy — real node-owned loads of prisma-cloud + node', () => {
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

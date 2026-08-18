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
 *
 * `deploy` declares `needs: { credentials: 'child' }`, so the engine refuses
 * the run before the handler when nothing is signed in — which would stop
 * these invocations short of the resolution they exist to exercise. Both cases
 * therefore supply an environment credential, and the second one supplies a
 * credential that names no workspace, which is how the "config evaluation no
 * longer needs a workspace" proposition is expressed now that the workspace id
 * comes from the credential rather than from a variable the handler reads.
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

/** An unsigned JWT carrying exactly `claims` — the shape PRISMA_SERVICE_TOKEN supplies. */
function serviceToken(claims: Record<string, unknown>): string {
  const segment = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${segment({ alg: 'none', typ: 'JWT' })}.${segment({
    sub: 'user_integration_test',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  })}.`;
}

describe('prisma-composer deploy — real extension-config resolution of prisma-cloud + node', () => {
  // Spawns the real CLI, which resolves /control entries and evaluates a config —
  // inherently slower than bun test's default 5000ms, so give it real headroom.
  test('resolves both /control entries for real and fails at the missing built entry, not at resolution', () => {
    const result = spawnSync('bun', [prismaAppBin, 'deploy', fixtureEntry], {
      cwd: integrationDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PRISMA_SERVICE_TOKEN: serviceToken({ workspace_id: 'ws-integration-test' }),
        PRISMA_WORKSPACE_ID: 'ws-integration-test',
      },
    });

    // Engine 0.2.0: a non-TTY run answers with a structured result frame on
    // stdout, so the error text lives there rather than on stderr.
    const output = result.stdout + result.stderr;
    expect(result.status).not.toBe(0);
    expect(output).not.toContain('Cannot resolve');
    expect(output).not.toContain('CLI.CREDENTIALS_REQUIRED');
    expect(output).not.toContain('environment variable PRISMA_WORKSPACE_ID is required');
    expect(output).toContain('no built entry at');
    expect(output).toContain('run your build first');
  }, 30_000);

  // Local-dev spec § 5: prismaCloud() now constructs with NO workspace
  // present (its `dev` field must be buildable credential-free), so a missing
  // workspace no longer surfaces at config evaluation — config evaluation is
  // exactly where the OLD eager check used to fire, so this proves the
  // restructure through the real CLI path, not just a unit test of
  // prismaCloud() in isolation. The pipeline still reaches the same "no built
  // entry" failure assemble hits regardless (container resolution, which DOES
  // still require a workspace, runs after assemble and is never reached here
  // either way).
  test('with a credential that names no workspace, config evaluation still succeeds — deploy fails at the same missing-built-entry point', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PRISMA_SERVICE_TOKEN: serviceToken({}) };
    delete env['PRISMA_WORKSPACE_ID'];

    const result = spawnSync('bun', [prismaAppBin, 'deploy', fixtureEntry], {
      cwd: integrationDir,
      encoding: 'utf8',
      env,
    });

    const output = result.stdout + result.stderr;
    expect(result.status).not.toBe(0);
    expect(output).not.toContain('Cannot resolve');
    expect(output).not.toContain('CLI.CREDENTIALS_REQUIRED');
    expect(output).not.toContain('PRISMA_WORKSPACE_ID');
    expect(output).toContain('no built entry at');
    expect(output).toContain('run your build first');
  }, 30_000);
});

/**
 * The slice's done-condition (TML-3174): a consumer OUTSIDE the CLI drives
 * deploy end to end through `@prisma/composer/control` — real config
 * discovery, real `/control` extension resolution, real assemble — without
 * touching argv, console capture, or exit codes. The fixture app has no built
 * output, so the pipeline fails structurally at the same terminal point the
 * binary test (cli.extension-config.test.ts) pins on stderr.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { deploy } from '@prisma/composer/control';

const integrationDir = path.resolve(import.meta.dir, '..');
const fixtureEntry = path.join(
  integrationDir,
  'test',
  'fixtures',
  'extension-config',
  'service.ts',
);

describe('@prisma/composer/control — programmatic deploy over the real extension config', () => {
  test('resolves both /control entries for real and fails structurally at the missing built entry, not at resolution', async () => {
    const result = await deploy({ entry: fixtureEntry, cwd: integrationDir });

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('unreachable');
    expect(result.failure.kind).toBe('pipeline');
    expect(result.failure.message).toContain('no built entry at');
    expect(result.failure.message).toContain('run your build first');
  }, 30_000);
});

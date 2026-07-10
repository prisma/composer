/**
 * The CLI must run under node (>= 22.18, default type stripping) as well as
 * bun (design-notes.md's "CLI runtime" call). This is the one test in the
 * suite that actually spawns a separate node process, proving `bin.ts`
 * itself — not just its pieces — works there.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const binPath = path.join(import.meta.dir, '..', 'bin.ts');

describe('node compatibility smoke test', () => {
  test('a bare invocation under node prints usage (deploy and destroy) and exits nonzero', () => {
    const result = spawnSync('node', [binPath], { encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('prisma-app deploy');
    expect(result.stderr).toContain('prisma-app destroy');
    expect(result.stderr).toContain('<entry>');
  });

  test('an unknown command under node prints usage and exits nonzero', () => {
    const result = spawnSync('node', [binPath, 'build', 'src/service.ts'], { encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('prisma-app deploy');
    expect(result.stderr).toContain('prisma-app destroy');
  });
});

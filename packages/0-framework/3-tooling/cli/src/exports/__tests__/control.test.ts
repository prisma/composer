/**
 * `destroy` and `log` are reachable only through the `./control` entry: no
 * command wraps them. These drive each through that entry to a structured
 * refusal, the path a host takes when it passes a section the CLI would refuse.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PrismaAppConfig } from '@internal/core/config';
import { destroy, log } from '../control.ts';

function withAppDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'composer-control-')));
  fs.writeFileSync(path.join(dir, 'prisma.config.ts'), 'export default {};\n');
  return run(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const refusedSection = { value: {} as PrismaAppConfig, file: 'prisma.config.ts' };

describe('the ./control entry', () => {
  test('destroy refuses a section the CLI would refuse, as a structured failure', async () => {
    const result = await withAppDir((cwd) =>
      destroy({
        config: refusedSection,
        entry: 'module.ts',
        target: { kind: 'production' },
        cwd,
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure).toMatchObject({
      code: 'CONFIG.FIELD_INVALID',
      meta: { field: 'extensions' },
    });
  }, 15_000);

  test.skipIf(process.platform === 'win32')(
    'log refuses a section the CLI would refuse, as a structured failure',
    async () => {
      const result = await withAppDir((cwd) =>
        log({ config: refusedSection, entry: 'module.ts', cwd }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure).toMatchObject({
        code: 'CONFIG.FIELD_INVALID',
        meta: { field: 'extensions' },
      });
    },
    15_000,
  );
});

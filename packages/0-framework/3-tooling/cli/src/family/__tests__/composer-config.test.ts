/**
 * What a handler hands the operations: the validated section plus the file
 * that declared it, refused when an old prisma-composer.config.* sits beside
 * that file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { composerConfigOf } from '../composer-config.ts';
import { validComposerSection } from './fixtures/composer-section.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'composer-config-')));
  dirs.push(dir);
  return dir;
}

const value = validComposerSection();

describe('composerConfigOf()', () => {
  test('the path is the file that declared the section, not the nearest config file', () => {
    const root = tempDir();
    const app = path.join(root, 'apps', 'shop');
    fs.mkdirSync(app, { recursive: true });

    const result = composerConfigOf({
      config: value,
      configFiles: [
        { path: path.join(app, 'prisma.config.ts'), sections: { orm: {} } },
        { path: path.join(root, 'prisma.config.ts'), sections: { composer: value } },
      ],
    });

    expect(result.ok && result.value).toEqual({ value, path: path.join(root, 'prisma.config.ts') });
  });

  test('an old config file beside the declaring file is refused, with the section to write', () => {
    for (const name of [
      'prisma-composer.config.ts',
      'prisma-composer.config.mts',
      'prisma-composer.config.mjs',
      'prisma-composer.config.js',
    ]) {
      const dir = tempDir();
      const legacy = path.join(dir, name);
      fs.writeFileSync(legacy, 'export default {};\n');

      const result = composerConfigOf({
        config: value,
        configFiles: [{ path: path.join(dir, 'prisma.config.ts'), sections: { composer: value } }],
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.toEnvelope()).toMatchObject({
        code: 'CONFIG.LEGACY_FILE',
        summary: `${legacy} is no longer read.`,
        why: 'Composer reads its configuration only from the `composer` section of prisma.config.ts.',
        nextActions: [
          {
            kind: 'edit-file',
            label:
              "Write `composer: composer({ extensions: [...], state: ... })` in prisma.config.ts, with `import { defineConfig as composer } from '@prisma/composer/config'`. If the project has a prisma-composer.config.ts, move its extensions and state into that section and delete the file.",
          },
        ],
        where: { path: legacy },
      });
    }
  });

  test('an old config file in any other directory is not checked', () => {
    const root = tempDir();
    const app = path.join(root, 'app');
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'prisma-composer.config.ts'), 'export default {};\n');

    const result = composerConfigOf({
      config: value,
      configFiles: [
        { path: path.join(app, 'prisma.config.ts'), sections: {} },
        { path: path.join(root, 'prisma.config.ts'), sections: { composer: value } },
      ],
    });

    expect(result.ok).toBe(true);
  });
});

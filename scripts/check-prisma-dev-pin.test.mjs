// `@prisma/composer-prisma-cloud` must declare `@prisma/dev` itself: the
// local target resolves the Postgres emulator from Composer's own package,
// and the tsdown bundle inlines `@internal/local-target` without carrying its
// manifest over. Without this entry an app gets whatever `@prisma/dev` it
// happens to have (alchemy's `^0.20.0`, whose pglite-socket crashes on any
// message over 64 KiB) or none at all under an isolated linker.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = (dir) => JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf-8'));

const PUBLIC = 'packages/9-public/composer-prisma-cloud';
const LOCAL_TARGET = 'packages/1-prisma-cloud/0-lowering/local-target';
const DEV_EMULATORS = 'packages/1-prisma-cloud/0-lowering/dev-emulators';

describe('@prisma/dev is declared by the published @prisma/composer-prisma-cloud', () => {
  const published = manifest(PUBLIC).dependencies?.['@prisma/dev'];
  const internal = manifest(LOCAL_TARGET).dependencies?.['@prisma/dev'];
  const emulator = manifest(DEV_EMULATORS).dependencies?.['@prisma/dev'];

  it('is a runtime dependency of the public package', () => {
    assert.equal(typeof published, 'string', `${PUBLIC} must list @prisma/dev in dependencies`);
  });

  it('is a runtime dependency of @internal/local-target, which resolves it', () => {
    assert.equal(
      typeof internal,
      'string',
      `${LOCAL_TARGET} must list @prisma/dev in dependencies`,
    );
  });

  it('is one range everywhere the emulator is declared', () => {
    assert.equal(published, internal);
    assert.equal(emulator, internal, `${DEV_EMULATORS} must list @prisma/dev in dependencies`);
  });

  it('never allows a release older than 0.21.0, the first with whole-message socket framing', () => {
    const caret = /^\^0\.(\d+)\.\d+$/.exec(published ?? '');
    assert.ok(caret, `expected a caret range on a 0.x release, got ${JSON.stringify(published)}`);
    assert.ok(Number(caret[1]) >= 21, `${published} admits a release older than 0.21.0`);
  });
});

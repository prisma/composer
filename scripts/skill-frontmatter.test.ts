import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readSkillFrontmatter, stampSkillVersion } from './skill-frontmatter.ts';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SKILL = `---
name: prisma-composer
metadata:
  library: "@prisma/composer"
  library_version: "0.11.0"
description: >-
  A folded description that spans lines and contains a literal $& and
  library_version: not-a-key inside prose.
---

# Body

Also mentions library_version: 9.9.9 in the body.
`;

describe('readSkillFrontmatter', () => {
  it('reads metadata.library and metadata.library_version, unquoted', () => {
    assert.deepEqual(readSkillFrontmatter(SKILL), {
      library: '@prisma/composer',
      libraryVersion: '0.11.0',
    });
  });

  it('returns nothing for a file with no frontmatter', () => {
    assert.deepEqual(readSkillFrontmatter('# Just a heading\n'), {});
  });

  it('ignores the keys at the top level, where the spec does not define them', () => {
    assert.deepEqual(readSkillFrontmatter('---\nname: x\nlibrary: "@prisma/composer"\n---\n'), {});
  });
});

describe('stampSkillVersion', () => {
  it('rewrites library_version and leaves the rest byte-identical', () => {
    const stamped = stampSkillVersion(SKILL, '0.12.0-dev.4');
    assert.deepEqual(readSkillFrontmatter(stamped), {
      library: '@prisma/composer',
      libraryVersion: '0.12.0-dev.4',
    });
    assert.equal(
      stamped,
      SKILL.replace('library_version: "0.11.0"', 'library_version: "0.12.0-dev.4"'),
    );
  });

  it('keeps the version a quoted string, as the metadata map requires', () => {
    assert.match(stampSkillVersion(SKILL, '1.2.3'), /^ {2}library_version: "1\.2\.3"$/m);
  });

  it('is idempotent', () => {
    const once = stampSkillVersion(SKILL, '1.0.0');
    assert.equal(stampSkillVersion(once, '1.0.0'), once);
  });

  it('refuses a skill with no metadata map', () => {
    assert.throws(() => stampSkillVersion('---\nname: x\n---\n', '1.0.0'), /no `metadata` map/);
  });

  it('refuses a skill that does not name its package', () => {
    assert.throws(
      () => stampSkillVersion('---\nname: x\nmetadata:\n  other: y\n---\n', '1.0.0'),
      /no `metadata.library` key/,
    );
  });

  it('refuses a skill with no library_version key to stamp', () => {
    assert.throws(
      () =>
        stampSkillVersion('---\nname: x\nmetadata:\n  library: "@prisma/composer"\n---\n', '1.0.0'),
      /no `metadata.library_version` key/,
    );
  });

  it('refuses a file with no frontmatter at all', () => {
    assert.throws(() => stampSkillVersion('# nope\n', '1.0.0'), /no YAML frontmatter/);
  });
});

describe('the shipped skill', () => {
  it('carries a stamp matching the root package version', async () => {
    const rootVersion = JSON.parse(
      await readFile(path.join(repoRoot, 'package.json'), 'utf-8'),
    ).version;
    const source = await readFile(
      path.join(repoRoot, 'skills/prisma-composer-core-concepts/SKILL.md'),
      'utf-8',
    );

    assert.deepEqual(readSkillFrontmatter(source), {
      library: '@prisma/composer',
      libraryVersion: rootVersion,
    });
  });
});

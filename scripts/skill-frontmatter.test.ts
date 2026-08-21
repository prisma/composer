import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readSkillFrontmatter, stampSkillVersion } from './skill-frontmatter.ts';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SKILL = `---
name: prisma-composer
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
  it('reads library and library_version, unquoted', () => {
    assert.deepEqual(readSkillFrontmatter(SKILL), {
      library: '@prisma/composer',
      libraryVersion: '0.11.0',
    });
  });

  it('returns nothing for a file with no frontmatter', () => {
    assert.deepEqual(readSkillFrontmatter('# Just a heading\n'), {});
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

  it('is idempotent', () => {
    const once = stampSkillVersion(SKILL, '1.0.0');
    assert.equal(stampSkillVersion(once, '1.0.0'), once);
  });

  it('refuses a skill that does not name its package', () => {
    assert.throws(() => stampSkillVersion('---\nname: x\n---\n', '1.0.0'), /no `library` key/);
  });

  it('refuses a skill with no library_version key to stamp', () => {
    assert.throws(
      () => stampSkillVersion('---\nname: x\nlibrary: "@prisma/composer"\n---\n', '1.0.0'),
      /no `library_version` key/,
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
    const source = await readFile(path.join(repoRoot, 'skills/prisma-composer/SKILL.md'), 'utf-8');

    assert.deepEqual(readSkillFrontmatter(source), {
      library: '@prisma/composer',
      libraryVersion: rootVersion,
    });
  });
});

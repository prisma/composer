// Pure helpers for the `library` / `library_version` frontmatter keys that
// tie a skill to the npm package it describes.
//
// The skill ships inside the `@prisma/composer` tarball, so the version a
// reader sees must be the version they installed. `set-version.ts` stamps
// `library_version` from the same root version it writes into every
// package.json, and `check-skill-packaging.mjs` re-reads it out of the packed
// tarball. Both go through here so there is one definition of what the
// frontmatter looks like.

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

function keyPattern(key: string): RegExp {
  return new RegExp(`^${key}:[ \\t]*(.*)$`, 'm');
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export interface SkillFrontmatter {
  /** The npm package the skill ships inside, e.g. `@prisma/composer`. */
  library?: string;
  /** The version of that package, stamped at release time. */
  libraryVersion?: string;
}

/** Read the version-stamp keys out of a `SKILL.md`. Absent keys stay undefined. */
export function readSkillFrontmatter(source: string): SkillFrontmatter {
  const block = FRONTMATTER_BLOCK.exec(source)?.[1];
  if (block === undefined) return {};

  const library = keyPattern('library').exec(block)?.[1];
  const libraryVersion = keyPattern('library_version').exec(block)?.[1];
  return {
    library: library === undefined ? undefined : unquote(library),
    libraryVersion: libraryVersion === undefined ? undefined : unquote(libraryVersion),
  };
}

/**
 * Rewrite `library_version` in a `SKILL.md` to `version`. Idempotent.
 *
 * Both keys must already be present. Adding them is an authoring decision —
 * a skill that ships in a tarball declares which package it ships in — and
 * silently inserting them here would let a skill with no `library` key be
 * stamped with a version that means nothing.
 */
export function stampSkillVersion(source: string, version: string): string {
  const block = FRONTMATTER_BLOCK.exec(source)?.[1];
  if (block === undefined) {
    throw new Error('SKILL.md has no YAML frontmatter block.');
  }
  const { library, libraryVersion } = readSkillFrontmatter(source);
  if (library === undefined) {
    throw new Error(
      'SKILL.md frontmatter has no `library` key — a skill that ships inside a tarball must name the package it ships in.',
    );
  }
  if (libraryVersion === undefined) {
    throw new Error(
      'SKILL.md frontmatter has no `library_version` key — add it (any value) so the release pipeline can stamp it.',
    );
  }

  // Function replacements throughout: the skill body and its long
  // `description` are prose, and a literal `$&` or `$1` in them would be
  // expanded as a capture reference by the string form.
  const stamped = block.replace(
    keyPattern('library_version'),
    () => `library_version: "${version}"`,
  );
  return source.replace(block, () => stamped);
}

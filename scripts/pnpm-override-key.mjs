// The package a root `pnpm.overrides` key overrides, parsed as pnpm 10 parses
// it (`parsePkgAndParentSelector` in @pnpm/parse-overrides): the key splits
// into parent and child at the first `>` that follows a character other than
// a space, `|` or `@`, so a `>` inside a range stays in its selector; the
// child selector is a package name, optionally followed by `@<range>`.

const PARENT_DELIMITER = /[^ |@]>/;

/**
 * `@prisma/orm-toolchain`, `prisma>@prisma/orm-toolchain`,
 * `prisma@>=8>@prisma/orm-toolchain` and `@prisma/orm-toolchain@>=8` all
 * name `@prisma/orm-toolchain`.
 * @param {string} key
 * @returns {string}
 */
export function overriddenPackage(key) {
  const delimiter = key.search(PARENT_DELIMITER);
  const target = delimiter === -1 ? key : key.slice(delimiter + 2);
  const versionAt = target.indexOf('@', 1);
  return versionAt === -1 ? target : target.slice(0, versionAt);
}

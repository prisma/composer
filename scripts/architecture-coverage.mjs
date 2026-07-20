/**
 * Shared helpers for the architecture lint (ADR-0028).
 *
 * `normalizeGlob` is imported by both dependency-cruiser.config.mjs (which
 * turns architecture.config.json into cruiser rules) and
 * lint-architecture-coverage.mjs (which checks every source file is
 * classified). If the check used its own matcher it could report a file as
 * classified while the cruiser matched no group and applied no rule to it.
 */

export const normalizeGlob = (glob) => {
  const DOUBLE_WILDCARD = '__DOUBLE_WILDCARD__';
  const SINGLE_WILDCARD = '__SINGLE_WILDCARD__';
  const hasWildcard = glob.includes('*');
  const lastPathSegment = glob.split('/').pop() ?? '';
  const isFileLikePattern = !hasWildcard && lastPathSegment.includes('.');

  let pattern = glob
    .replace(/\*\*/g, DOUBLE_WILDCARD)
    .replace(/\*/g, SINGLE_WILDCARD)
    .replaceAll(DOUBLE_WILDCARD, '.*')
    .replaceAll(SINGLE_WILDCARD, '[^/]*');

  if (isFileLikePattern) {
    return `^${pattern}$`;
  }
  if (!hasWildcard && !pattern.endsWith('/')) {
    pattern += '/.*';
  }
  return `^${pattern}`;
};

export const findUnclassifiedFiles = (files, packageConfigs) => {
  const matchers = packageConfigs.map((pkgConfig) => new RegExp(normalizeGlob(pkgConfig.glob)));
  return files.filter((file) => !matchers.some((matcher) => matcher.test(file)));
};

const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

export const readImportSpecifiers = (source) =>
  [...source.matchAll(IMPORT_SPECIFIER)].map((match) => match[1]);

/**
 * Workspace specifiers that `paths` does not alias to source. Their package
 * `exports` maps point at built dist, which the cruiser excludes, so the edge
 * is dropped and no rule can fire on it.
 */
export const findUnaliasedSpecifiers = (specifiers, workspacePackageNames, paths) => {
  const belongsToWorkspace = (specifier) =>
    workspacePackageNames.some((name) => specifier === name || specifier.startsWith(`${name}/`));

  return [...new Set(specifiers)]
    .filter(belongsToWorkspace)
    .filter((specifier) => !Object.hasOwn(paths, specifier))
    .sort();
};

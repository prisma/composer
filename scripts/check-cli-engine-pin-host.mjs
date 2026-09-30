/**
 * The host half of scripts/check-cli-engine-pin.mjs: the installed `prisma`
 * host must run the workspace's command family, and the host and the family
 * must load one copy of `@prisma/cli-engine`.
 *
 * It compares resolved copies, not declared versions. The release order is
 * engine, then Composer, then the host, so between releases the published
 * host declares an older engine than the workspace pins. That is expected;
 * two engine copies loaded in one process is not.
 */

import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';

const ENGINE = '@prisma/cli-engine';
const FAMILY = '@prisma/composer-cli/family';
const OVERRIDE_HINT =
  "Check the root package.json's pnpm override and its @prisma/composer-cli devDependency (gotchas.md).";

function firstLine(error) {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0];
}

/** Where a module the given file would import actually lives on disk. */
function realResolve(fromFile, specifier) {
  return realpathSync(createRequire(fromFile).resolve(specifier));
}

/**
 * Every failure for the host at `hostManifestPath` against the workspace
 * family package at `cliDir`; an empty list when both hold.
 */
export function checkHost({ hostManifestPath, cliDir }) {
  const familyEntry = join(cliDir, 'dist/family.mjs');
  if (!existsSync(familyEntry)) {
    return [
      `${familyEntry} does not exist: build @prisma/composer-cli first (pnpm turbo run build --filter=@prisma/composer-cli).`,
    ];
  }

  let family;
  try {
    family = realResolve(hostManifestPath, FAMILY);
  } catch (error) {
    return [
      `the installed prisma cannot resolve ${FAMILY} (${firstLine(error)}). ${OVERRIDE_HINT}`,
    ];
  }
  if (!family.startsWith(realpathSync(cliDir) + sep)) {
    return [
      `the installed prisma resolves @prisma/composer-cli to ${family}, not to the workspace package. ${OVERRIDE_HINT}`,
    ];
  }

  const hostEngine = realResolve(hostManifestPath, `${ENGINE}/package.json`);
  const familyEngine = realResolve(family, `${ENGINE}/package.json`);
  if (hostEngine !== familyEngine) {
    return [
      `the host and the family load different copies of ${ENGINE}: ${hostEngine} and ${familyEngine}. ` +
        `The host declares a different engine than the workspace pins; during a tandem release, add a root pnpm override of ${ENGINE} to the workspace pin.`,
    ];
  }
  return [];
}

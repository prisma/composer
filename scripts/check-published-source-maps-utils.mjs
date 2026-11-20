// The rules behind `check-published-source-maps.mjs`, in their own module so
// the test can import them without running the check.

import { existsSync, globSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const ABSOLUTE_OR_URL = /^(?:[a-z][a-z0-9+.-]*:|[\\/])/i;
const ORM_OR_PRETTIER = /(?:^|\/)node_modules\/(?:@prisma\/orm-|prettier\/)/;
const IN_DIST = /(?:^|\/)dist\//;
const RE_EXPORT_LINE =
  /^(?:import (?:\{[^}]*\} from )?"[^"]+";|export \{[^}]*\}(?: from "[^"]+")?;|export \* from "[^"]+";)$/;

function isOwnCode(source) {
  return !source.includes('node_modules/') || source.includes('node_modules/@internal/');
}

function needsNoMap(file) {
  if (basename(file).startsWith('rolldown-runtime-')) return true;
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .every((line) => RE_EXPORT_LINE.test(line));
}

/** Every problem with the source maps in `distDirs`, one message each. */
export function sourceMapProblems(distDirs) {
  const problems = [];
  for (const dist of distDirs) {
    if (!existsSync(dist)) {
      problems.push(`${dist}: missing; build the public packages first`);
      continue;
    }
    for (const name of globSync('**/*.{mjs,d.mts}', { cwd: dist }).sort()) {
      const file = join(dist, name);
      if (!existsSync(`${file}.map`) && !needsNoMap(file)) {
        problems.push(`${file}: has no source map`);
      }
    }
    for (const name of globSync('**/*.map', { cwd: dist }).sort()) {
      const mapFile = join(dist, name);
      const map = JSON.parse(readFileSync(mapFile, 'utf8'));
      const isDeclarationMap = /\.d\.[cm]?ts\.map$/.test(name);
      const inlined = [];
      for (const [index, source] of (map.sources ?? []).entries()) {
        if (ABSOLUTE_OR_URL.test(source)) {
          problems.push(`${mapFile}: source is an absolute path or URL: ${source}`);
          continue;
        }
        if (ORM_OR_PRETTIER.test(source)) inlined.push(source);
        if (!isOwnCode(source)) continue;
        if (IN_DIST.test(source)) {
          problems.push(`${mapFile}: source is built output, not our TypeScript: ${source}`);
        }
        if (!isDeclarationMap && typeof map.sourcesContent?.[index] !== 'string') {
          problems.push(`${mapFile}: no sourcesContent for ${source}`);
        }
      }
      if (inlined.length > 0) {
        problems.push(
          `${mapFile}: inlines ${inlined.length} source files of the Prisma ORM or prettier, which the app installs itself; first: ${inlined[0]}`,
        );
      }
    }
  }
  return problems;
}

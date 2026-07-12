// Rewrites inline `import("@internal/…")` type references left in the rolled
// declarations to the public `@prisma/compose` subpaths. Top-level imports are
// handled by the resolve hook in tsdown.config.ts; TypeScript's inline import
// types inside the internals' prebuilt d.mts are plain text the bundler passes
// through, so they are mapped here. Fails the build if any @internal IMPORT
// survives (doc-comment mentions are prose, not references).
import { globSync, readFileSync, writeFileSync } from 'node:fs';

const MAP = [
  ['@internal/foundation/casts', '@prisma/compose/casts'],
  ['@internal/foundation/assertions', '@prisma/compose/assertions'],
  ['@internal/core/config', '@prisma/compose/config'],
  ['@internal/core/deploy', '@prisma/compose/deploy'],
  ['@internal/core/testing', '@prisma/compose/testing'],
  ['@internal/core', '@prisma/compose'],
  ['@internal/rpc', '@prisma/compose/rpc'],
  ['@internal/node/control', '@prisma/compose/node/control'],
  ['@internal/node', '@prisma/compose/node'],
  ['@internal/nextjs/control', '@prisma/compose/nextjs/control'],
  ['@internal/nextjs', '@prisma/compose/nextjs'],
];
const IMPORT_REF = /(?:import\(|from )["']@internal\/[^"']+["']/;

const files = globSync('dist/**/*.d.mts');
for (const file of files) {
  let text = readFileSync(file, 'utf8');
  for (const [from, to] of MAP) {
    text = text.replaceAll(`import("${from}")`, `import("${to}")`);
    text = text.replaceAll(`from "${from}"`, `from "${to}"`);
    text = text.replaceAll(`from '${from}'`, `from '${to}'`);
  }
  writeFileSync(file, text);
}
const bad = files.filter((f) => IMPORT_REF.test(readFileSync(f, 'utf8')));
if (bad.length) {
  console.error(`unresolved @internal imports in: ${bad.join(', ')}`);
  process.exit(1);
}
console.log(`dts internal references rewritten across ${files.length} files`);

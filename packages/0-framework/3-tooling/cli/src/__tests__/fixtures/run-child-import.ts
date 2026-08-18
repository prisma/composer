/**
 * Minimal driver: dynamically imports the path from argv[2] and exits 0 on
 * success or 1 on failure. Used by the child-hook real-node proof test to
 * confirm that NODE_OPTIONS --import of the register module makes .js → .ts
 * resolution work in a plain node child process (no loadEntry() involved).
 */
const target = process.argv[2];
if (target === undefined) {
  console.error('usage: run-child-import.ts <module-to-import>');
  process.exit(1);
}

import(target)
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

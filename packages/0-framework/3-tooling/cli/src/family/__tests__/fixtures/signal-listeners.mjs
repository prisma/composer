/**
 * Reports SIGINT/SIGTERM/exit listener counts around the imports a composer
 * command performs, in a FRESH process so nothing else can have registered.
 *
 * Config evaluation is the moment alchemy enters the process. The counts are
 * printed as JSON on stdout; the test asserts against them.
 *
 * Argument: what to import.
 *   `alchemy`       — the provider tree a config evaluation loads.
 *   `local-target`  — additionally the thunk resolution dev/log perform.
 */
const counts = () => ({
  SIGINT: process.listenerCount('SIGINT'),
  SIGTERM: process.listenerCount('SIGTERM'),
  exit: process.listenerCount('exit'),
});

const what = process.argv[2] ?? 'alchemy';

const before = counts();

await import('alchemy');
const afterConfigEvaluation = counts();

let afterLocalTargets = afterConfigEvaluation;
if (what === 'local-target') {
  // What resolveLocalTargets additionally reaches: effect's Layer. (The
  // historical suspect, @alchemy.run/node-utils' lockfile module, no longer
  // exists — alchemy ships no file-lock module at all since 2.0.0-beta.74.)
  await import('effect/Layer');
  afterLocalTargets = counts();
}

process.stdout.write(JSON.stringify({ before, afterConfigEvaluation, afterLocalTargets }));

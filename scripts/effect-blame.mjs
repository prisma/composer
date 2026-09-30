/**
 * Decides whether a failure to import alchemy is the installed `effect`'s
 * fault. Used by check-npm-effect-resolution.mjs's adversarial shape, which
 * must fail unless effect is what broke.
 *
 * A wrong `effect` shows up either as a missing export of an effect module
 * (the message or stack names `node_modules/effect/`, `@effect/` or an
 * `effect` module specifier), or as `X.Y is not a function` where the
 * installed effect exports a module `X` without a function `Y`. Paths are
 * matched on `node_modules/`, because the check's scratch directory has
 * "effect" in its name.
 *
 * @param {unknown} error the import failure
 * @param {Record<string, unknown>} effect the installed `effect` package's exports
 */
export function blamesEffect(error, effect) {
  const message = String(error?.message ?? error);
  const text = `${message}\n${String(error?.stack ?? '')}`;
  if (/node_modules\/(?:effect|@effect\/[^/]+)\//.test(text)) return true;
  if (/module ['"](?:effect|@effect\/[^'"]+)(?:\/[^'"]*)?['"]/.test(text)) return true;

  const missing = /(\w+)\.(\w+) is not a function/.exec(message);
  if (missing === null) return false;
  const [, moduleName, member] = missing;
  const namespace = effect[moduleName];
  return (
    typeof namespace === 'object' && namespace !== null && typeof namespace[member] !== 'function'
  );
}

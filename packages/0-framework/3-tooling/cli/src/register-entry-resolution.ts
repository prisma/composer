/**
 * Thin preload module: registers the .js / extensionless → .ts resolve hook
 * before any user module is imported.
 *
 * Loaded in the delegated alchemy converge child via
 * `NODE_OPTIONS=--import=<file:// URL of this module's dist>`, so the hook
 * is active when the generated `alchemy.run.ts` imports the user's entry
 * module (which may itself use `./service.js` specifiers for `.ts` sources).
 *
 * Kept separate from `entry-resolution.ts` because that module owns the hook
 * implementation and the guard logic; this module's only job is to fire the
 * registration at import time.
 */
import { registerEntryResolution } from './entry-resolution.ts';

registerEntryResolution();

/**
 * Synchronous Node resolve hook so that entry modules may import relative
 * files using the specifier forms TypeScript accepts by default —
 * extensionless `./service` and `./service.js` for a `.ts` source file —
 * without requiring `allowImportingTsExtensions` in every consumer's tsconfig.
 *
 * Resolution only; uses TypeScript's own documented mapping: for a specifier
 * Node could not resolve, strip any JS-family extension and probe the
 * corresponding TypeScript source; first candidate that exists on disk wins.
 * Format-specific rules: `.mjs` → `.mts`; `.cjs` → `.cts`; `.js` and
 * extensionless → `.ts`, `.mts`, `.tsx`, then `./index.ts`. Bare and package
 * specifiers are never touched. Existing `./x.ts` imports keep working —
 * Node resolves them before the hook fires (ADR-0005: no transform, no
 * guessing, deterministic TypeScript rule).
 *
 * Bun resolves `./x.js` and `./x` to `x.ts` natively, so the hook is a
 * no-op under Bun. Nothing is registered there.
 *
 * The hook also observes, without changing anything: `recordAppFiles` uses
 * it to learn which app files an entry import loaded.
 */

import { existsSync } from 'node:fs';
import * as mod from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

let registered = false;
let recording: Set<string> | undefined;

/** An app file: a `file:` module outside every `node_modules` directory. */
function appFile(url: string): string | undefined {
  if (!url.startsWith('file:')) return undefined;
  const file = fileURLToPath(url);
  return file.split(path.sep).includes('node_modules') ? undefined : file;
}

function record(url: string): void {
  const file = recording === undefined ? undefined : appFile(url);
  if (file !== undefined) recording?.add(file);
}

/**
 * Runs `load` and returns the app files it imported: every module outside
 * `node_modules` that the runtime loaded for the first time while it ran,
 * static and dynamic imports alike. Under Node the resolve hook records them;
 * under Bun they are the modules `require.cache` gained, which includes ES
 * modules. A module already loaded before `load` started, and what only it
 * imports, is not recorded.
 */
export async function recordAppFiles<T>(
  load: () => Promise<T>,
): Promise<{ readonly value: T; readonly files: readonly string[] }> {
  if (typeof process.versions.bun === 'string') {
    const cache = mod.createRequire(import.meta.url).cache;
    const before = new Set(Object.keys(cache));
    const value = await load();
    const files = Object.keys(cache).flatMap((key) => {
      if (before.has(key) || !path.isAbsolute(key)) return [];
      return key.split(path.sep).includes('node_modules') ? [] : [key];
    });
    return { value, files };
  }
  registerEntryResolution();
  const files = new Set<string>();
  recording = files;
  try {
    return { value: await load(), files: [...files] };
  } finally {
    recording = undefined;
  }
}

/**
 * Registers the resolve hook once (idempotent). Call at the start of
 * `loadEntry` so every module in the entry graph benefits, including those
 * imported lazily after the entry itself loads.
 */
export function registerEntryResolution(): void {
  if (registered || typeof process.versions.bun === 'string') return;
  // registerHooks landed in Node 22.15; the oldest supported Node.js is 22.18.
  // Guard here covers any non-standard environment.
  if (typeof mod.registerHooks !== 'function') return;
  registered = true;
  mod.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        const resolved = nextResolve(specifier, context);
        record(resolved.url);
        return resolved;
      } catch (error) {
        if (
          !isRelativeSpecifier(specifier) ||
          context.parentURL === undefined ||
          !isModuleNotFoundError(error)
        ) {
          throw error;
        }
        for (const candidate of sourceCandidates(new URL(specifier, context.parentURL))) {
          if (existsSync(fileURLToPath(candidate))) {
            const resolved = nextResolve(candidate.href, context);
            record(resolved.url);
            return resolved;
          }
        }
        throw error;
      }
    },
  });
}

/**
 * TypeScript's extension mapping: for a JS-family or extensionless URL,
 * produce the source candidates to probe. Format-specific: `.mjs` maps only
 * to `.mts`; `.cjs` maps only to `.cts`; `.js` and extensionless probe
 * `.ts`, `.mts`, `.tsx` (keeping `.tsx` so the JSX diagnostic fires), then
 * `./index.ts`.
 */
function sourceCandidates(resolved: URL): URL[] {
  const href = resolved.href;
  if (href.endsWith('.mjs')) {
    const base = href.slice(0, -4);
    return [new URL(`${base}.mts`)];
  }
  if (href.endsWith('.cjs')) {
    const base = href.slice(0, -4);
    return [new URL(`${base}.cts`)];
  }
  const base = href.endsWith('.js') ? href.slice(0, -3) : href;
  return [
    new URL(`${base}.ts`),
    new URL(`${base}.mts`),
    new URL(`${base}.tsx`),
    new URL(`${base}/index.ts`),
  ];
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function isModuleNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!('code' in error)) return false;
  return error.code === 'ERR_MODULE_NOT_FOUND';
}

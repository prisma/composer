/**
 * Synchronous Node resolve hook so that entry modules may import relative
 * files using the specifier forms TypeScript accepts by default —
 * extensionless `./service` and `./service.js` for a `.ts` source file —
 * without requiring `allowImportingTsExtensions` in every consumer's tsconfig.
 *
 * Resolution only; uses TypeScript's own documented mapping: for a specifier
 * Node could not resolve, strip any JS-family extension, then probe `.ts`,
 * `.mts`, `.tsx`, and finally `./index.ts` in that order; first candidate
 * that exists on disk wins. Bare and package specifiers are never touched.
 * Existing `./x.ts` imports keep working — Node resolves them before the hook
 * fires (ADR-0005: no transform, no guessing, deterministic TypeScript rule).
 *
 * Bun resolves `./x.js` and `./x` to `x.ts` natively, so the hook is a
 * no-op under Bun. Nothing is registered there.
 */

import { existsSync } from 'node:fs';
import * as mod from 'node:module';
import { fileURLToPath } from 'node:url';

const SOURCE_EXTENSIONS = ['.ts', '.mts', '.tsx'] as const;
let registered = false;

/**
 * Registers the resolve hook once (idempotent). Call at the start of
 * `loadEntry` so every module in the entry graph benefits, including those
 * imported lazily after the entry itself loads.
 */
export function registerEntryResolution(): void {
  if (registered || typeof process.versions.bun === 'string') return;
  // registerHooks landed in Node 22.15; the engine floor is 22.18.
  // Guard here covers any non-standard environment.
  if (typeof mod.registerHooks !== 'function') return;
  registered = true;
  mod.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
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
            return nextResolve(candidate.href, context);
          }
        }
        throw error;
      }
    },
  });
}

/**
 * TypeScript's extension mapping: for a JS-family or extensionless URL,
 * produce the `.ts`/`.mts`/`.tsx`/`index.ts` candidates to probe.
 */
function sourceCandidates(resolved: URL): URL[] {
  const base = resolved.href.replace(/\.(js|mjs|cjs)$/, '');
  return [...SOURCE_EXTENSIONS.map((ext) => new URL(base + ext)), new URL(`${base}/index.ts`)];
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function isModuleNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!('code' in error)) return false;
  return error.code === 'ERR_MODULE_NOT_FOUND';
}

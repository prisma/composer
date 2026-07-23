/**
 * Dev preflight (local-dev spec § 5, ADR-0041): the same name walk deploy's
 * preflight uses (`preflight-names.ts`), but with dev's value-sourcing policy
 * (ADR-0041's D7) instead of deploy's platform-existence check — a secret
 * falls back to a minted, persisted placeholder with a warning; an
 * env-sourced param falls back to nothing and is a hard error, because params
 * feed boot-time schema validation and a placeholder there would produce a
 * confusing crash instead of a legible degraded mode.
 *
 * Control-plane only, runs in the CLI parent (no CliError import — see
 * container.ts). Reads no Management API — dev is credential-free.
 */

import type { PreflightInput } from '@internal/core/config';
import { DEV_DIR } from '@internal/core/config';
import { secretsStore } from '@internal/local-target';
import { collectPreflightNames, type PreflightName } from '../preflight-names.ts';

/** `local-placeholder-<16 lowercase hex>` — Web Crypto only, matching the extension's other local mints (ServiceKey, S3Credentials). */
function mintPlaceholder(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `local-placeholder-${hex}`;
}

function missingEnvParamsError(missing: readonly PreflightName[]): Error {
  const lines = missing.map((m) => `  - ${m.name}  (required by service "${m.serviceAddress}")`);
  return new Error(
    `local dev preflight failed — ${missing.length} env-sourced param(s) are not set in this shell:\n` +
      `${lines.join('\n')}\n\n` +
      'Set each in the shell you run `prisma-composer dev` from.',
  );
}

export async function runDevPreflight(input: PreflightInput): Promise<void> {
  // No `node:path` import (invariant 5) — local dev is POSIX-only (spec's
  // Windows note), so a plain `/`-join is exact, not an approximation.
  const devDir = `${process.cwd()}/${DEV_DIR}`;
  const store = secretsStore(devDir);
  const { secrets, envParams } = collectPreflightNames(input.graph);

  // Secrets first, persisted immediately — a later env-param failure below
  // must not cost an already-minted placeholder its stability.
  await store.update((current) => {
    const next = { ...current };
    for (const { name } of secrets) {
      const shellValue = process.env[name];
      if (shellValue !== undefined && shellValue.length > 0) {
        next[name] = shellValue;
        continue;
      }
      if (next[name] !== undefined) continue; // reuse the persisted placeholder
      next[name] = mintPlaceholder();
      console.warn(
        `[dev] ${name} is not set in this shell — using a local placeholder. Anything that talks ` +
          'to the real service behind it will fail; everything else runs.',
      );
    }
    return next;
  });

  const resolved: Record<string, string> = {};
  const missing: PreflightName[] = [];
  for (const meta of envParams) {
    const shellValue = process.env[meta.name];
    if (shellValue !== undefined && shellValue.length > 0) {
      resolved[meta.name] = shellValue;
    } else {
      missing.push(meta);
    }
  }
  if (Object.keys(resolved).length > 0) {
    await store.update((current) => ({ ...current, ...resolved }));
  }
  if (missing.length > 0) throw missingEnvParamsError(missing);
}

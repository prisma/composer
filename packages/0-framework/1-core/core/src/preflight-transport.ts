/**
 * Carries an extension's deploy-preflight payload from the CLI process to the
 * alchemy child (which re-imports the config from scratch) — one env var per
 * extension, same channel as containers (container-transport.ts). The
 * framework never reads the contents. Payloads carry metadata only, never
 * secret values: the child's environment is not a secret store.
 */
import { envVarSafeExtensionId } from './container-transport.ts';

/** A string only this extension reads back, or `undefined` when it has nothing to carry. */
export type PreflightPayload = string | undefined;

/** '@prisma/composer-prisma-cloud' → 'PRISMA_COMPOSER_PREFLIGHT_PRISMA_COMPOSER_PRISMA_CLOUD' */
export function preflightEnvVarName(extensionId: string): string {
  return `PRISMA_COMPOSER_PREFLIGHT_${envVarSafeExtensionId(extensionId)}`;
}

/** The env entries the CLI sets on the alchemy process: `{ [preflightEnvVarName(id)]: payload }` for every extension whose preflight returned one. */
export function preflightEnv(payloads: ReadonlyMap<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  const ownerByVarName = new Map<string, string>();
  for (const [extensionId, payload] of payloads) {
    if (payload.length === 0) continue;
    const varName = preflightEnvVarName(extensionId);
    const owner = ownerByVarName.get(varName);
    if (owner !== undefined) {
      throw new Error(
        `Extension ids "${owner}" and "${extensionId}" both map to the preflight transport ` +
          `variable "${varName}" — rename one of the extensions.`,
      );
    }
    ownerByVarName.set(varName, extensionId);
    env[varName] = payload;
  }
  return env;
}

/** The alchemy-process side: the payload this extension's own preflight wrote, or `undefined` when it wrote none (or when nothing ran a preflight at all). */
export function readPreflightPayload(
  extensionId: string,
  env: Readonly<Record<string, string | undefined>>,
): PreflightPayload {
  const payload = env[preflightEnvVarName(extensionId)];
  return payload === undefined || payload.length === 0 ? undefined : payload;
}

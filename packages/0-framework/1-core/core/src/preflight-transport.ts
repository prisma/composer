/**
 * Carries what an extension's deploy preflight learned from the CLI process
 * into the alchemy process — the same two-process problem, and the same
 * channel, as resolved containers (ADR-0037, container-transport.ts).
 *
 * Preflight runs in the CLI parent, because it is the step that talks to the
 * platform. Alchemy then runs as a child process against the generated stack
 * file, which re-imports the app config from scratch: every extension factory
 * is called again, with none of the parent's state. Anything preflight learned
 * that the lowering needs is therefore gone unless it is transported, and env
 * vars are the only channel between the two processes. So the CLI writes each
 * extension's preflight payload into one env var, and the extension reads its
 * own var back in the alchemy process. The framework owns the vars; it never
 * reads their contents.
 *
 * An extension must never put a SECRET VALUE in a payload: the alchemy child's
 * environment is not a secret store, and the payload is not encrypted. Carry
 * metadata (e.g. when a platform variable was last written), never values.
 */
import { mangleExtensionId } from './container-transport.ts';

/**
 * What an extension's `preflight` hands back for the transport: a string only
 * that extension reads, or `undefined` when it has nothing to carry (the usual
 * case for an extension whose preflight only checks prerequisites).
 */
export type PreflightPayload = string | undefined;

/** '@prisma/composer-prisma-cloud' → 'PRISMA_COMPOSER_PREFLIGHT_PRISMA_COMPOSER_PRISMA_CLOUD' */
export function preflightEnvVarName(extensionId: string): string {
  return `PRISMA_COMPOSER_PREFLIGHT_${mangleExtensionId(extensionId)}`;
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
        `Extension ids "${owner}" and "${extensionId}" both mangle to the preflight transport ` +
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

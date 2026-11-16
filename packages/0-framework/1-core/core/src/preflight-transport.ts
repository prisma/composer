/**
 * Carries an extension's preflight payload from the CLI process to the
 * alchemy child (which re-imports the config from scratch) — one env var per
 * extension, same channel as containers (container-transport.ts), filled by
 * whichever preflight the run executed: the deploy preflight or the local
 * target's dev preflight. The framework never reads the contents, so an
 * extension that implements both must tell its own payload kinds apart.
 * Payloads carry metadata only, never secret values: the child's environment
 * is not a secret store.
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
        `Extension ids "${owner}" and "${extensionId}" both use the environment variable "${varName}". Rename one of the extensions.`,
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

/** Where a platform variable is named: a service's input field, a service's per-key param, or the input of a module or resource that passes it to no service. */
export type PlatformVariableReader =
  | { readonly kind: 'field'; readonly service: string; readonly path: string }
  | { readonly kind: 'param'; readonly service: string; readonly param: string }
  | { readonly kind: 'unread'; readonly node: string; readonly nodeKind: 'module' | 'resource' };

/** A platform variable with no value that nothing requires, with its readers and the commands that set it. */
export interface UnsetPlatformVariable {
  readonly name: string;
  readonly readers: readonly PlatformVariableReader[];
  /** Shell commands that each set it, in the order to offer them. */
  readonly commands: readonly string[];
}

/** What a deploy preflight found that does not stop the deploy. Names and readers only, never a value. */
export interface PreflightFindings {
  readonly unset: readonly UnsetPlatformVariable[];
}

/** One reader as the deploy prints it, for example `read by service "shop.email", field "apiKey"`. */
export function platformVariableReaderText(reader: PlatformVariableReader): string {
  switch (reader.kind) {
    case 'field':
      return `read by service "${reader.service}", field "${reader.path === '' ? '(root)' : reader.path}"`;
    case 'param':
      return `read by service "${reader.service}", per-key param "${reader.param}"`;
    case 'unread':
      return `named by ${reader.nodeKind} "${reader.node}", read by no service`;
  }
}

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
    if (varName === PREFLIGHT_FINDINGS_ENV_VAR) {
      throw new Error(
        `Extension id "${extensionId}" uses the environment variable "${varName}", which Composer reserves. Rename the extension.`,
      );
    }
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((member) => typeof member === 'string');

function isPlatformVariableReader(value: unknown): value is PlatformVariableReader {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'field':
      return typeof value['service'] === 'string' && typeof value['path'] === 'string';
    case 'param':
      return typeof value['service'] === 'string' && typeof value['param'] === 'string';
    case 'unread':
      return (
        typeof value['node'] === 'string' &&
        (value['nodeKind'] === 'module' || value['nodeKind'] === 'resource')
      );
    default:
      return false;
  }
}

function isUnsetPlatformVariable(value: unknown): value is UnsetPlatformVariable {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    Array.isArray(value['readers']) &&
    value['readers'].every(isPlatformVariableReader) &&
    isStringArray(value['commands'])
  );
}

function isPreflightFindings(value: unknown): value is PreflightFindings {
  return (
    isRecord(value) &&
    Array.isArray(value['unset']) &&
    value['unset'].every(isUnsetPlatformVariable)
  );
}

/** The variable that carries every extension's deploy preflight findings from the first process to the second. No extension's preflight variable may take this name. */
export const PREFLIGHT_FINDINGS_ENV_VAR = 'PRISMA_COMPOSER_PREFLIGHT_FINDINGS';

/** The env entry the CLI sets on the second process. It is always set, and empty when nothing was found, so a stale value in the shell never reads as this run's. */
export function preflightFindingsEnv(findings: PreflightFindings): Record<string, string> {
  return {
    [PREFLIGHT_FINDINGS_ENV_VAR]: findings.unset.length === 0 ? '' : JSON.stringify(findings),
  };
}

/** The second process's side: the findings the CLI carried, or none. Throws on a value that does not decode: that is a framework bug. */
export function readPreflightFindings(
  env: Readonly<Record<string, string | undefined>>,
): PreflightFindings {
  const text = env[PREFLIGHT_FINDINGS_ENV_VAR];
  if (text === undefined || text.length === 0) return { unset: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isPreflightFindings(parsed)) {
    throw new Error(
      `The deploy check's findings could not be read in the second process (${PREFLIGHT_FINDINGS_ENV_VAR}). This is a Composer bug; deploying again will not fix it.`,
    );
  }
  return parsed;
}

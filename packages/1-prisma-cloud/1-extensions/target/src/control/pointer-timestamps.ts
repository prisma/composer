/**
 * Carries, on the framework's preflight transport, when each platform
 * variable a Composer row points at was last written — read by preflight in
 * the CLI process, needed by the environment fingerprint in the alchemy
 * process (which re-imports the config from scratch). ISO timestamps only,
 * never values: the Management API returns none and the child's environment
 * is not a place to put one.
 */
import { readPreflightPayload } from '@internal/core/config';
import { PRISMA_CLOUD_EXTENSION_ID } from '../container.ts';

/** The pointed platform variable's `updatedAt`, or undefined when it is unknown (dev, or a name the deploy just provisioned). */
export type PointerUpdatedAt = (name: string) => string | undefined;

/** The CLI-process side: what `preflight` hands the framework, or undefined when the deploy read no pointed variable at all. */
export function serializePointerUpdatedAt(
  timestamps: ReadonlyMap<string, string>,
): string | undefined {
  if (timestamps.size === 0) return undefined;
  const sorted = [...timestamps].sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify(Object.fromEntries(sorted));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The alchemy-process side: the timestamps the CLI process transported. An
 * absent payload is the normal case for `prisma-composer dev` and for any run
 * with no pointed variables, and reads as an empty map; a payload that is
 * present but unreadable is a framework bug and throws rather than silently
 * costing the deploy its rotation signal.
 */
export function deserializePointerUpdatedAt(
  payload: string | undefined,
): ReadonlyMap<string, string> {
  const timestamps = new Map<string, string>();
  if (payload === undefined) return timestamps;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw payloadError(error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(parsed)) throw payloadError('it is not a JSON object');
  for (const [name, updatedAt] of Object.entries(parsed)) {
    if (typeof updatedAt !== 'string') throw payloadError(`"${name}" is not a string timestamp`);
    timestamps.set(name, updatedAt);
  }
  return timestamps;
}

const payloadError = (reason: string): Error =>
  new Error(
    "prisma-cloud: the deploy preflight's rotation timestamps did not survive the transport " +
      `into the alchemy process — ${reason}. This is a framework bug; re-running the deploy ` +
      'will not fix it.',
  );

/**
 * The pointer lookup the node descriptors close over: `own` — filled by
 * `preflight` — in the CLI process, and the transported payload in the alchemy
 * process, where `own` is empty because that process never runs a preflight.
 * A name in neither reads as unknown, which is every name under
 * `prisma-composer dev`.
 */
export function pointerUpdatedAtLookup(
  own: ReadonlyMap<string, string>,
  env: Readonly<Record<string, string | undefined>>,
): PointerUpdatedAt {
  let transported: ReadonlyMap<string, string> | undefined;
  return (name) => {
    const mine = own.get(name);
    if (mine !== undefined) return mine;
    transported ??= deserializePointerUpdatedAt(
      readPreflightPayload(PRISMA_CLOUD_EXTENSION_ID, env),
    );
    return transported.get(name);
  };
}

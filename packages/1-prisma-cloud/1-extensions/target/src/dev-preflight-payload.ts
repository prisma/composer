/**
 * What the `prisma dev` preflight hands the alchemy process on the preflight
 * transport. It shares the transport variable with the deploy preflight's
 * timestamps (`control/pointer-timestamps.ts`), so it carries a `dev:` prefix
 * that a deploy payload, always a JSON object, never starts with. It holds
 * names and SHA-256 fingerprints only, never a value.
 */
import { readPreflightPayload } from '@internal/core/config';
import { PRISMA_CLOUD_EXTENSION_ID } from './container.ts';

const DEV_PAYLOAD_PREFIX = 'dev:';

export interface DevPreflightPayload {
  /** The `envSecret` names that are unset or empty in this run's environment. */
  readonly absentSecrets: readonly string[];
  /** A SHA-256 hex digest of the current value of each pointed variable that is set. */
  readonly fingerprints: Readonly<Record<string, string>>;
}

export function serializeDevPreflightPayload(payload: DevPreflightPayload): string {
  const fingerprints = Object.fromEntries(
    Object.entries(payload.fingerprints).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return `${DEV_PAYLOAD_PREFIX}${JSON.stringify({
    absentSecrets: [...new Set(payload.absentSecrets)].sort(),
    fingerprints,
  })}`;
}

export function isDevPreflightPayload(payload: string | undefined): payload is string {
  return payload?.startsWith(DEV_PAYLOAD_PREFIX) === true;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((member) => typeof member === 'string');
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((member) => typeof member === 'string')
  );
}

/** Throws on a payload that does not parse: that is a framework bug, and guessing would hide it. */
export function deserializeDevPreflightPayload(payload: string): DevPreflightPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.slice(DEV_PAYLOAD_PREFIX.length));
  } catch (error) {
    throw payloadError(error instanceof Error ? error.message : String(error));
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('absentSecrets' in parsed) ||
    !isStringArray(parsed.absentSecrets) ||
    !('fingerprints' in parsed) ||
    !isStringRecord(parsed.fingerprints)
  ) {
    throw payloadError('it does not have the expected shape');
  }
  return { absentSecrets: parsed.absentSecrets, fingerprints: parsed.fingerprints };
}

const payloadError = (reason: string): Error =>
  new Error(
    "prisma-cloud: the `prisma dev` preflight's payload did not survive the transport into the " +
      `alchemy process — ${reason}. This is a framework bug; re-running \`prisma dev\` will not fix it.`,
  );

/** The transported dev payload, or undefined when this run is a deploy or carried none. */
export function readDevPreflightPayload(
  env: Readonly<Record<string, string | undefined>>,
): DevPreflightPayload | undefined {
  const payload = readPreflightPayload(PRISMA_CLOUD_EXTENSION_ID, env);
  return isDevPreflightPayload(payload) ? deserializeDevPreflightPayload(payload) : undefined;
}

/** The secrets the transported dev payload names absent, read once on first call; empty for a deploy. */
export function transportedAbsentSecrets(
  env: Readonly<Record<string, string | undefined>>,
): () => ReadonlySet<string> {
  let absent: ReadonlySet<string> | undefined;
  return () => {
    absent ??= new Set(readDevPreflightPayload(env)?.absentSecrets ?? []);
    return absent;
  };
}

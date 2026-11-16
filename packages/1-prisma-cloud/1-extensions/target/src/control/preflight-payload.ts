// A deploy payload is JSON `{ updatedAt }`; a `prisma dev` payload is `dev:` then JSON
// `{ absentVariables, pointerVersions }`. Names, times and keyed hashes only, never a value.
import { readPreflightPayload } from '@internal/core/config';
import { PRISMA_CLOUD_EXTENSION_ID } from '../container.ts';

/** A value that changes when the pointed variable's value changes: the platform `updatedAt` on deploy, an HMAC of the value under `prisma dev`. Undefined when unknown. */
export type PointerVersion = (name: string) => string | undefined;

/** What the preflight of this run sent, as the lowering reads it. */
export interface TransportedPreflight {
  readonly pointerVersion: PointerVersion;
  readonly absentVariables: ReadonlySet<string>;
}

export interface DeployPreflightPayload {
  readonly updatedAt: ReadonlyMap<string, string>;
}

export interface DevPreflightPayload {
  readonly absentVariables: readonly string[];
  readonly pointerVersions: Readonly<Record<string, string>>;
}

export type DecodedPreflightPayload =
  | { readonly kind: 'none' }
  | ({ readonly kind: 'deploy' } & DeployPreflightPayload)
  | {
      readonly kind: 'dev';
      readonly absentVariables: ReadonlySet<string>;
      readonly pointerVersions: ReadonlyMap<string, string>;
    };

const DEV_PAYLOAD_PREFIX = 'dev:';

const byName = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : 1);

export function serializeDeployPreflightPayload(
  payload: DeployPreflightPayload,
): string | undefined {
  if (payload.updatedAt.size === 0) return undefined;
  return JSON.stringify({ updatedAt: Object.fromEntries([...payload.updatedAt].sort(byName)) });
}

export function serializeDevPreflightPayload(payload: DevPreflightPayload): string {
  return `${DEV_PAYLOAD_PREFIX}${JSON.stringify({
    absentVariables: [...new Set(payload.absentVariables)].sort(),
    pointerVersions: Object.fromEntries(Object.entries(payload.pointerVersions).sort(byName)),
  })}`;
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((member) => typeof member === 'string')
  );
}

function parseJson(text: string, error: (reason: string) => Error): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw error(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Throws on a payload that does not parse: that is a framework bug, and guessing would hide it. */
export function decodePreflightPayload(payload: string | undefined): DecodedPreflightPayload {
  if (payload === undefined) return { kind: 'none' };
  if (payload.startsWith(DEV_PAYLOAD_PREFIX)) {
    const parsed = parseJson(payload.slice(DEV_PAYLOAD_PREFIX.length), devPayloadError);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('absentVariables' in parsed) ||
      !Array.isArray(parsed.absentVariables) ||
      !parsed.absentVariables.every((name: unknown) => typeof name === 'string') ||
      !('pointerVersions' in parsed) ||
      !isStringRecord(parsed.pointerVersions)
    ) {
      throw devPayloadError('it does not have the expected shape');
    }
    return {
      kind: 'dev',
      absentVariables: new Set<string>(parsed.absentVariables),
      pointerVersions: new Map(Object.entries(parsed.pointerVersions)),
    };
  }
  const parsed = parseJson(payload, deployPayloadError);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw deployPayloadError('it is not a JSON object');
  }
  if (!('updatedAt' in parsed) || !isStringRecord(parsed.updatedAt)) {
    throw deployPayloadError('its "updatedAt" is not an object of string timestamps');
  }
  return { kind: 'deploy', updatedAt: new Map(Object.entries(parsed.updatedAt)) };
}

const deployPayloadError = (reason: string): Error =>
  new Error(
    `prisma-cloud: the deploy check's payload could not be read in the second process: ${reason}. ` +
      'This is a Composer bug; deploying again will not fix it.',
  );

const devPayloadError = (reason: string): Error =>
  new Error(
    `prisma-cloud: the \`prisma dev\` check's payload could not be read in the second process: ${reason}. ` +
      'This is a Composer bug; running `prisma dev` again will not fix it.',
  );

export function transportedPreflight(
  own: () => ReadonlyMap<string, string> | undefined,
  env: Readonly<Record<string, string | undefined>>,
): TransportedPreflight {
  let decoded: DecodedPreflightPayload | undefined;
  const decode = () =>
    (decoded ??= decodePreflightPayload(readPreflightPayload(PRISMA_CLOUD_EXTENSION_ID, env)));
  const noVariables: ReadonlySet<string> = new Set();
  return {
    pointerVersion: (name) => {
      const snapshot = own();
      if (snapshot !== undefined) return snapshot.get(name);
      const payload = decode();
      if (payload.kind === 'deploy') return payload.updatedAt.get(name);
      if (payload.kind === 'dev') return payload.pointerVersions.get(name);
      return undefined;
    },
    get absentVariables() {
      const payload = decode();
      return payload.kind === 'dev' ? payload.absentVariables : noVariables;
    },
  };
}

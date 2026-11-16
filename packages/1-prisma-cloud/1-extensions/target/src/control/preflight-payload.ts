/**
 * What this extension's preflight hands the lowering, which reads it as
 * `LowerContext.preflight`. One payload carries either kind:
 *
 * - deploy: a JSON object holding `updatedAt`, which maps each platform
 *   variable a service reads to the `updatedAt` of the row the platform resolves;
 * - `prisma dev`: `dev:` followed by JSON naming the unset secrets and an
 *   HMAC-SHA256 of the current value of each variable a service points at.
 *
 * A deploy payload always starts with `{`, so the prefix tells them apart.
 * Names, times and keyed hashes only, never a value.
 */

/** A value that changes when the pointed variable's value changes: the platform `updatedAt` on deploy, an HMAC of the value under `prisma dev`. Undefined when unknown. */
export type PointerVersion = (name: string) => string | undefined;

/** What this run's preflight returned, decoded for the lowering. */
export interface PreflightView {
  readonly pointerVersion: PointerVersion;
  /** The `envSecret` names `prisma dev` found unset; their leaves are left out of the input document. Always empty for a deploy. */
  readonly absentSecrets: ReadonlySet<string>;
}

export interface DeployPreflightPayload {
  readonly updatedAt: ReadonlyMap<string, string>;
}

export interface DevPreflightPayload {
  readonly absentSecrets: readonly string[];
  readonly pointerVersions: Readonly<Record<string, string>>;
}

export type DecodedPreflightPayload =
  | { readonly kind: 'none' }
  | ({ readonly kind: 'deploy' } & DeployPreflightPayload)
  | {
      readonly kind: 'dev';
      readonly absentSecrets: ReadonlySet<string>;
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
    absentSecrets: [...new Set(payload.absentSecrets)].sort(),
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
      !('absentSecrets' in parsed) ||
      !Array.isArray(parsed.absentSecrets) ||
      !parsed.absentSecrets.every((name: unknown) => typeof name === 'string') ||
      !('pointerVersions' in parsed) ||
      !isStringRecord(parsed.pointerVersions)
    ) {
      throw devPayloadError('it does not have the expected shape');
    }
    return {
      kind: 'dev',
      absentSecrets: new Set<string>(parsed.absentSecrets),
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
    `prisma-cloud: the deploy check's payload could not be read: ${reason}. ` +
      'This is a Composer bug; deploying again will not fix it.',
  );

const devPayloadError = (reason: string): Error =>
  new Error(
    `prisma-cloud: the \`prisma dev\` check's payload could not be read: ${reason}. ` +
      'This is a Composer bug; running `prisma dev` again will not fix it.',
  );

/** The lowering's view of `LowerContext.preflight`, decoded once on first use. */
export function preflightView(payload: string | undefined): PreflightView {
  let decoded: DecodedPreflightPayload | undefined;
  const decode = () => (decoded ??= decodePreflightPayload(payload));
  const noSecrets: ReadonlySet<string> = new Set();
  return {
    pointerVersion: (name) => {
      const sent = decode();
      if (sent.kind === 'deploy') return sent.updatedAt.get(name);
      if (sent.kind === 'dev') return sent.pointerVersions.get(name);
      return undefined;
    },
    get absentSecrets() {
      const sent = decode();
      return sent.kind === 'dev' ? sent.absentSecrets : noSecrets;
    },
  };
}

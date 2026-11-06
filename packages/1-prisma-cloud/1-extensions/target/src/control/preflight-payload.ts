/**
 * What this extension's preflight hands the alchemy process, which re-imports
 * the config from scratch, on the framework's preflight transport. One
 * variable carries either kind:
 *
 * - deploy: a JSON object holding `updatedAt`, which maps each pointed
 *   platform variable to the `updatedAt` of the row the platform resolves,
 *   and `findings`, the variables with no value that nothing requires;
 * - `prisma dev`: `dev:` followed by JSON naming the unset secrets and an
 *   HMAC-SHA256 of the current value of each variable a service points at.
 *
 * A deploy payload always starts with `{`, so the prefix tells them apart.
 * Names, readers, times and keyed hashes only, never a value.
 */
import {
  isPreflightFindings,
  type PreflightFindings,
  readPreflightPayload,
} from '@internal/core/config';
import { PRISMA_CLOUD_EXTENSION_ID } from '../container.ts';

/** A value that changes when the pointed variable's value changes: the platform `updatedAt` on deploy, an HMAC of the value under `prisma dev`. Undefined when unknown. */
export type PointerVersion = (name: string) => string | undefined;

/** What the preflight of this run sent, as the lowering reads it. */
export interface TransportedPreflight {
  readonly pointerVersion: PointerVersion;
  /** The `envSecret` names `prisma dev` found unset; their leaves are left out of the input document. Always empty for a deploy. */
  readonly absentSecrets: ReadonlySet<string>;
  /** The deploy preflight's findings. Empty under `prisma dev` and when nothing was transported. */
  readonly findings: PreflightFindings;
}

/** What the deploy preflight hands the alchemy process. */
export interface DeployPreflightPayload {
  readonly updatedAt: ReadonlyMap<string, string>;
  readonly findings: PreflightFindings;
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

const NO_FINDINGS: PreflightFindings = { unset: [] };

/** The deploy preflight's payload, or undefined when it read no pointed variable and found nothing. */
export function serializeDeployPreflightPayload(
  payload: DeployPreflightPayload,
): string | undefined {
  if (payload.updatedAt.size === 0 && payload.findings.unset.length === 0) return undefined;
  return JSON.stringify({
    updatedAt: Object.fromEntries([...payload.updatedAt].sort(byName)),
    findings: payload.findings,
  });
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
  if (!('findings' in parsed) || !isPreflightFindings(parsed.findings)) {
    throw deployPayloadError('its "findings" do not have the expected shape');
  }
  return {
    kind: 'deploy',
    updatedAt: new Map(Object.entries(parsed.updatedAt)),
    findings: parsed.findings,
  };
}

const deployPayloadError = (reason: string): Error =>
  new Error(
    "prisma-cloud: the deploy preflight's payload did not survive the transport " +
      `into the alchemy process — ${reason}. This is a framework bug; re-running the deploy ` +
      'will not fix it.',
  );

const devPayloadError = (reason: string): Error =>
  new Error(
    "prisma-cloud: the `prisma dev` preflight's payload did not survive the transport into the " +
      `alchemy process — ${reason}. This is a framework bug; re-running \`prisma dev\` will not fix it.`,
  );

/**
 * The lowering's view of what the preflight sent. `own` holds what the deploy
 * preflight read in this same process (the CLI process); the alchemy process
 * has none and reads the transported payload, decoded once on first use.
 */
export function transportedPreflight(
  own: ReadonlyMap<string, string>,
  env: Readonly<Record<string, string | undefined>>,
): TransportedPreflight {
  let decoded: DecodedPreflightPayload | undefined;
  const decode = () =>
    (decoded ??= decodePreflightPayload(readPreflightPayload(PRISMA_CLOUD_EXTENSION_ID, env)));
  const noSecrets: ReadonlySet<string> = new Set();
  return {
    pointerVersion: (name) => {
      const mine = own.get(name);
      if (mine !== undefined) return mine;
      const payload = decode();
      if (payload.kind === 'deploy') return payload.updatedAt.get(name);
      if (payload.kind === 'dev') return payload.pointerVersions.get(name);
      return undefined;
    },
    get absentSecrets() {
      const payload = decode();
      return payload.kind === 'dev' ? payload.absentSecrets : noSecrets;
    },
    get findings() {
      const payload = decode();
      return payload.kind === 'deploy' ? payload.findings : NO_FINDINGS;
    },
  };
}

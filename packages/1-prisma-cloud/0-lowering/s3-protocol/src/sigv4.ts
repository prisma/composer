/**
 * AWS SigV4 verification for the S3 wire protocol (spec § 2 auth). The payload
 * hash comes from the client — `x-amz-content-sha256` (a real hash or
 * `UNSIGNED-PAYLOAD`) for header auth, `UNSIGNED-PAYLOAD` for presign — and is
 * never re-hashed; the verifier trusts what was signed, like a real S3 endpoint.
 * Runtime engine code (`node:crypto`); not re-exported from the authoring barrel.
 *
 * Also owns `mintKeyPair` (local-dev spec § 1) — the one key-pair generator
 * both the deploy-time `S3Credentials` resource and the local dev bucket
 * emulator's credential provisioning use.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function toHexUpper(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/** A fresh SigV4 key pair: an AKIA-prefixed id and a 40-char base64 secret. */
export function mintKeyPair(): Credentials {
  const accessKeyId = `AKIA${toHexUpper(randomBytes(8))}`;
  const secretAccessKey = btoa(String.fromCharCode(...randomBytes(30)));
  return { accessKeyId, secretAccessKey };
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** AWS canonical URI encoding: every byte except the unreserved set is %XX. */
function awsUriEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/g, '~');
}

interface CredentialScope {
  readonly accessKeyId: string;
  readonly date: string;
  readonly region: string;
  readonly service: string;
}

function parseCredential(credential: string): CredentialScope | null {
  const parts = credential.split('/');
  if (parts.length !== 5 || parts[4] !== 'aws4_request') return null;
  const [accessKeyId, date, region, service] = parts;
  if (!accessKeyId || !date || !region || !service) return null;
  return { accessKeyId, date, region, service };
}

function signingKey(secret: string, scope: CredentialScope): Buffer {
  const kDate = hmac(`AWS4${secret}`, scope.date);
  const kRegion = hmac(kDate, scope.region);
  const kService = hmac(kRegion, scope.service);
  return hmac(kService, 'aws4_request');
}

function canonicalHeaders(url: URL, req: Request, signedHeaders: readonly string[]): string {
  return signedHeaders
    .map((name) => {
      const raw = name === 'host' ? url.host : (req.headers.get(name) ?? '');
      return `${name}:${raw.trim().replace(/\s+/g, ' ')}\n`;
    })
    .join('');
}

function canonicalQuery(url: URL, exclude?: string): string {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (exclude !== undefined && key === exclude) continue;
    entries.push([awsUriEncode(key), awsUriEncode(value)]);
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  entries.sort(([ak, av], [bk, bv]) => cmp(ak, bk) || cmp(av, bv));
  return entries.map(([k, v]) => `${k}=${v}`).join('&');
}

function stringToSign(amzDate: string, scope: CredentialScope, canonicalRequest: string): string {
  const scopeString = `${scope.date}/${scope.region}/${scope.service}/aws4_request`;
  return [ALGORITHM, amzDate, scopeString, sha256Hex(canonicalRequest)].join('\n');
}

function signatureMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** `YYYYMMDDTHHMMSSZ` → epoch ms, or null when malformed. */
function parseAmzDate(amzDate: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

function parseAuthorizationHeader(
  header: string,
): { credential: string; signedHeaders: string[]; signature: string } | null {
  if (!header.startsWith(`${ALGORITHM} `)) return null;
  const rest = header.slice(ALGORITHM.length + 1);
  const fields = new Map<string, string>();
  for (const part of rest.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const credential = fields.get('Credential');
  const signedHeaders = fields.get('SignedHeaders');
  const signature = fields.get('Signature');
  if (!credential || !signedHeaders || !signature) return null;
  return { credential, signedHeaders: signedHeaders.split(';'), signature };
}

/** The one signing core both auth forms share: check the access key, rebuild the canonical request, derive the key, compare in constant time. */
function verifySignature(
  req: Request,
  url: URL,
  credentials: Credentials,
  params: {
    readonly scope: CredentialScope;
    readonly amzDate: string;
    readonly signedHeaders: readonly string[];
    readonly payloadHash: string;
    readonly signature: string;
    readonly excludeQuery?: string;
  },
): VerifyResult {
  if (params.scope.accessKeyId !== credentials.accessKeyId)
    return { ok: false, reason: 'unknown access key' };
  const canonicalRequest = [
    req.method,
    url.pathname,
    canonicalQuery(url, params.excludeQuery),
    canonicalHeaders(url, req, params.signedHeaders),
    params.signedHeaders.join(';'),
    params.payloadHash,
  ].join('\n');
  const expected = hmac(
    signingKey(credentials.secretAccessKey, params.scope),
    stringToSign(params.amzDate, params.scope, canonicalRequest),
  ).toString('hex');
  return signatureMatches(expected, params.signature)
    ? { ok: true }
    : { ok: false, reason: 'signature mismatch' };
}

function verifyHeader(req: Request, url: URL, credentials: Credentials): VerifyResult {
  const auth = parseAuthorizationHeader(req.headers.get('authorization') ?? '');
  if (!auth) return { ok: false, reason: 'malformed Authorization header' };
  const scope = parseCredential(auth.credential);
  if (!scope) return { ok: false, reason: 'malformed credential scope' };
  const amzDate = req.headers.get('x-amz-date');
  if (!amzDate) return { ok: false, reason: 'missing x-amz-date' };
  const payloadHash = req.headers.get('x-amz-content-sha256');
  if (!payloadHash) return { ok: false, reason: 'missing x-amz-content-sha256' };

  return verifySignature(req, url, credentials, {
    scope,
    amzDate,
    signedHeaders: auth.signedHeaders,
    payloadHash,
    signature: auth.signature,
  });
}

function verifyPresigned(
  req: Request,
  url: URL,
  credentials: Credentials,
  now: Date,
): VerifyResult {
  const q = url.searchParams;
  if (q.get('X-Amz-Algorithm') !== ALGORITHM)
    return { ok: false, reason: 'unsupported presign algorithm' };

  const credentialRaw = q.get('X-Amz-Credential');
  const amzDate = q.get('X-Amz-Date');
  const expiresRaw = q.get('X-Amz-Expires');
  const signedHeadersRaw = q.get('X-Amz-SignedHeaders');
  const signature = q.get('X-Amz-Signature');
  if (!credentialRaw || !amzDate || !expiresRaw || !signedHeadersRaw || !signature) {
    return { ok: false, reason: 'incomplete presign parameters' };
  }

  const scope = parseCredential(credentialRaw);
  if (!scope) return { ok: false, reason: 'malformed credential scope' };

  const signedAt = parseAmzDate(amzDate);
  const expires = Number(expiresRaw);
  if (signedAt === null || !Number.isFinite(expires))
    return { ok: false, reason: 'malformed presign date' };
  if (now.getTime() > signedAt + expires * 1000) return { ok: false, reason: 'presign expired' };

  return verifySignature(req, url, credentials, {
    scope,
    amzDate,
    signedHeaders: signedHeadersRaw.split(';'),
    payloadHash: UNSIGNED_PAYLOAD,
    signature,
    excludeQuery: 'X-Amz-Signature',
  });
}

/**
 * Verify a request's SigV4 signature against a single credential pair. Picks
 * the presigned form when `X-Amz-Signature` is present, otherwise the
 * `Authorization`-header form. `now` is injectable for deterministic
 * expiry tests.
 */
export function verifyRequest(
  req: Request,
  credentials: Credentials,
  now: Date = new Date(),
): VerifyResult {
  const url = new URL(req.url);
  if (url.searchParams.has('X-Amz-Signature')) return verifyPresigned(req, url, credentials, now);
  if (req.headers.has('authorization')) return verifyHeader(req, url, credentials);
  return { ok: false, reason: 'unsigned request' };
}

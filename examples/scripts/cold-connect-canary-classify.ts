/**
 * Pass/fail logic for cold-connect-canary.ts, split out for offline unit
 * testing. Duplicates the transient-error signatures from
 * packages/compose-cloud/src/pg-connection.ts (not exported from that package's
 * public entry points) — keep in sync if that list changes.
 */

const TRANSIENT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

const INCONCLUSIVE_CODES = new Set(['ETIMEDOUT']);

const TRANSIENT_MESSAGE_FRAGMENTS = [
  'upstream database',
  'connection terminated',
  'connection refused',
  'terminating connection',
  'server closed the connection',
];

// FT-5226 manifests as an ACTIVE rejection. A client-side connect timeout is
// inconclusive (could be a slow-but-fixed cold start) and must not count as PASS.
const INCONCLUSIVE_MESSAGE_FRAGMENTS = ['connection timeout', 'timeout expired'];

function errorInfo(error: unknown): { code: string | undefined; message: string } {
  if (typeof error !== 'object' || error === null)
    return { code: undefined, message: String(error) };
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return { code, message };
}

function isTransient(error: unknown): boolean {
  const { code, message } = errorInfo(error);
  if (code !== undefined && TRANSIENT_CODES.has(code)) return true;
  const lower = message.toLowerCase();
  return TRANSIENT_MESSAGE_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

function isInconclusive(error: unknown): boolean {
  const { code, message } = errorInfo(error);
  if (code !== undefined && INCONCLUSIVE_CODES.has(code)) return true;
  const lower = message.toLowerCase();
  return INCONCLUSIVE_MESSAGE_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

export interface ColdConnectResult {
  readonly pass: boolean;
  readonly message: string;
}

/**
 * Classifies the canary's single bare connect attempt: success → FAIL (bug looks
 * fixed), active rejection → PASS (bug present), timeout → FAIL (inconclusive),
 * anything else (auth, quota) → FAIL (broken canary, not a fixed platform).
 */
export function classifyColdConnectResult(error: unknown): ColdConnectResult {
  if (error === undefined) {
    return {
      pass: false,
      message:
        'PPG cold-connect rejection is gone (FT-5226 fixed?) — remove withConnectionRetry and this canary.',
    };
  }
  if (isInconclusive(error)) {
    const { message } = errorInfo(error);
    return {
      pass: false,
      message: `Inconclusive: the connect timed out instead of being actively rejected — FT-5226 may be fixed (slow cold start), or the canary is broken: ${message}`,
    };
  }
  if (isTransient(error)) {
    const { message } = errorInfo(error);
    return { pass: true, message: `Cold-connect rejection still present: ${message}` };
  }
  const { message } = errorInfo(error);
  return {
    pass: false,
    message: `Canary got a non-transient error, not the known cold-start rejection — canary or credentials are broken, not FT-5226: ${message}`,
  };
}

/** Connection resilience helpers shared by the deploy lowerings and the pnPostgres runtime client (FT-5226); no heavy imports, so it's safe in both. */

/** Network-level socket failures node-postgres surfaces as `err.code`. */
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/** Connection-establishment failure messages (no useful `err.code`). */
const TRANSIENT_MESSAGE_FRAGMENTS = [
  // Prisma Postgres's edge proxy while a cold/idle DB's upstream warms up.
  'upstream database',
  // node-postgres pool / server-close transients.
  'connection terminated',
  'connection refused',
  'terminating connection',
  'server closed the connection',
  'connection timeout',
  'timeout expired',
];

/** Whether an error is a transient connection failure worth retrying, as opposed to a real query error that must surface at once. */
export function isTransientConnectionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  if (code !== undefined && TRANSIENT_CODES.has(code)) return true;
  const message =
    'message' in error && typeof error.message === 'string' ? error.message.toLowerCase() : '';
  return TRANSIENT_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment));
}

/**
 * Rewrites a deprecating `sslmode` (`require`/`prefer`/`verify-ca`) to the
 * explicit `verify-full` these already mean, silencing node-postgres's
 * deprecation warning. `disable`/`no-verify`/unset are left untouched.
 */
export function normalizeSslMode(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a parseable URL — leave it; the driver surfaces its own error.
    return url;
  }
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode === 'require' || sslmode === 'prefer' || sslmode === 'verify-ca') {
    parsed.searchParams.set('sslmode', 'verify-full');
    return parsed.toString();
  }
  return url;
}

/**
 * Retries an operation past a transient connection failure, bounded (default
 * ~1 min). `shouldRetry` decides what's transient — defaults to retrying
 * everything; the runtime client passes {@link isTransientConnectionError}.
 */
export async function withConnectionRetry<T>(
  operation: () => Promise<T>,
  opts: {
    readonly attempts?: number;
    readonly delayMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly shouldRetry?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 12;
  const delayMs = opts.delayMs ?? 5000;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const shouldRetry = opts.shouldRetry ?? (() => true);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!shouldRetry(error)) throw error;
      lastError = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw lastError;
}

/** Retries acquiring a connection past a transient cold-start; {@link withConnectionRetry} with {@link isTransientConnectionError} fixed as the predicate. */
export function retryTransientConnect<T>(
  acquire: () => Promise<T>,
  opts: {
    readonly attempts?: number;
    readonly delayMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  return withConnectionRetry(acquire, { ...opts, shouldRetry: isTransientConnectionError });
}

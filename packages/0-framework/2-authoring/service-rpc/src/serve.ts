/**
 * Generates the RPC server from a service's `expose`: a web fetch handler
 * that dispatches `POST /rpc/<method>` across every exposed port, flattened
 * into one method namespace (method names must be unique across a service's
 * ports — there is no port segment in the route). `Handlers<S>` derives the
 * exhaustive, correctly-typed handler map straight off `S["expose"]` and
 * `S["load"]`'s return, so an incomplete or mistyped `serve(service,
 * handlers)` call does not compile; extra handler methods/ports are allowed
 * (width, same as a provider exposing more than a consumer requires).
 *
 * Per ADR-0030, every request is checked against the accepted service-key
 * set before dispatch: unset (never provisioned — local/test) passes
 * through; a provisioned `"[]"` (deployed, zero wired consumers) denies
 * every caller; a provisioned non-empty set requires membership via
 * `Authorization: Bearer <key>`.
 */

import type { Contract, Expose, RunnableServiceNode } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { standardValidate } from './standard-schema.ts';

// The ambient environment of whatever runtime hosts the bundle. Declared
// structurally so this entry imports no runtime's types.
declare const process: { env: Record<string, string | undefined> };

/** The reserved env var the target (slice 2) writes the accepted key set to. */
export const RPC_ACCEPTED_KEYS_ENV = 'COMPOSER_RPC_ACCEPTED_KEYS';

// biome-ignore lint/suspicious/noExplicitAny: accepts any concrete runnable service node — generics are invariant, so `any` is required (mirrors ModuleBuilder.provision in @prisma/composer).
type AnyRunnable = RunnableServiceNode<any, any, any>;

type CmpOf<C> = C extends Contract<string, infer Cmp> ? Cmp : never;

/** A handler's optional third argument. Handlers may ignore it. */
export interface RpcHandlerContext {
  /** The call's idempotency key (same across its retries), or `undefined` for a keyless caller that opted out of dedup. */
  readonly idempotencyKey: string | undefined;
}

type HandlerFor<Fn, LoadedDeps> = Fn extends (input: infer I) => Promise<infer O>
  ? (input: I, deps: LoadedDeps, ctx: RpcHandlerContext) => Promise<O>
  : never;

/**
 * The keys of `E` whose contract is an RPC contract. A service may expose
 * non-rpc ports beside its rpc ones (e.g. a public HTTP surface whose
 * contract carries connection config, not methods) — serve() has nothing to
 * dispatch for those, so `Handlers<S>` must not demand a handler map for
 * them. The runtime mirror is `methodTable`'s kind check.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches contract()'s own Cmp bound — the filter cares about the kind, not the function map.
type RpcPortKeys<E> = { [P in keyof E]: E[P] extends Contract<'rpc', any> ? P : never }[keyof E];

/** Every exposed RPC port's methods, turned into a handler map typed off S's own `expose` and `load()`. Non-rpc exposed ports are skipped. */
export type Handlers<S extends AnyRunnable> = {
  [Port in RpcPortKeys<NonNullable<S['expose']>>]: {
    [M in keyof CmpOf<NonNullable<S['expose']>[Port]>]: HandlerFor<
      CmpOf<NonNullable<S['expose']>[Port]>[M],
      ReturnType<S['load']>
    >;
  };
};

interface MethodSchemas {
  readonly input: StandardSchemaV1;
  readonly output: StandardSchemaV1;
}

type RpcHandler = (input: unknown, deps: unknown, ctx: RpcHandlerContext) => Promise<unknown>;

/** A response, reduced to what the replay cache needs to reproduce it byte-identically. */
interface Outcome {
  readonly status: number;
  readonly bodyText: string;
}

function outcome(body: unknown, status = 200): Outcome {
  return { status, bodyText: JSON.stringify(body) };
}

function toResponse(o: Outcome): Response {
  return new Response(o.bodyText, {
    status: o.status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The generic message every caller-facing 500 carries — the real error goes to `console.error` instead. */
const INTERNAL_ERROR_MESSAGE = 'Internal server error';

/** Request body cap. Internal RPC payloads are small records, not uploads; 1 MiB bounds a slow request's memory. */
export const MAX_BODY_BYTES = 1_048_576;

class RequestBodyTooLargeError extends Error {}

/** Reads the body as text, aborting past `maxBytes` of bytes actually read — `content-length` is caller-supplied, so untrusted. */
async function readBoundedBody(req: Request, maxBytes: number): Promise<string> {
  const reader = req.body?.getReader();
  if (reader === undefined) return '';

  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RequestBodyTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

/** Completed answers held for replay before LRU eviction. Fixed, so the per-provider cache is bounded memory, not traffic-scaled. */
export const REPLAY_CACHE_MAX_ENTRIES = 1000;

/** How long a completed 2xx/4xx answer stays replayable for a repeated key. */
const REPLAY_TTL_MS = 60_000;

interface CompletedEntry {
  readonly kind: 'completed';
  readonly outcome: Outcome;
  readonly completedAt: number;
  // The entry knows where it lives, so eviction can delete it from byMethod
  // without reconstructing its location.
  readonly method: string;
  readonly key: string;
}
type CacheEntry = { readonly kind: 'pending'; readonly promise: Promise<Outcome> } | CompletedEntry;

/**
 * Per-method, per-key deduplication. A duplicate arriving mid-execution
 * single-flights onto the same promise; a completed 2xx/4xx replays for
 * REPLAY_TTL_MS; a 5xx is never kept, since that is what a retry re-executes.
 * Keyed by method first, so a replay can never answer a different method.
 */
class IdempotencyStore {
  private readonly byMethod = new Map<string, Map<string, CacheEntry>>();
  // Completed entries in least-recently-used order. A Set keeps insertion
  // order, so deleting then re-adding an entry moves it to the newest end.
  private readonly lru = new Set<CompletedEntry>();

  async dispatch(method: string, key: string, run: () => Promise<Outcome>): Promise<Outcome> {
    const bucket = this.bucketFor(method);
    const existing = bucket.get(key);

    if (existing?.kind === 'pending') {
      return existing.promise;
    }
    if (existing?.kind === 'completed') {
      if (Date.now() - existing.completedAt < REPLAY_TTL_MS) {
        this.lru.delete(existing);
        this.lru.add(existing);
        return existing.outcome;
      }
      bucket.delete(key);
      this.lru.delete(existing);
    }

    const promise = run();
    bucket.set(key, { kind: 'pending', promise });

    let result: Outcome;
    try {
      result = await promise;
    } catch (err) {
      bucket.delete(key);
      throw err;
    }

    if (result.status >= 500) {
      bucket.delete(key); // retryable outcome — a retry must re-execute
    } else {
      const entry: CompletedEntry = {
        kind: 'completed',
        outcome: result,
        completedAt: Date.now(),
        method,
        key,
      };
      bucket.set(key, entry);
      this.lru.add(entry);
      this.evictOverflow();
    }
    return result;
  }

  private bucketFor(method: string): Map<string, CacheEntry> {
    let bucket = this.byMethod.get(method);
    if (bucket === undefined) {
      bucket = new Map();
      this.byMethod.set(method, bucket);
    }
    return bucket;
  }

  private evictOverflow(): void {
    if (this.lru.size <= REPLAY_CACHE_MAX_ENTRIES) return;
    const oldest = this.lru.values().next().value;
    if (oldest !== undefined) {
      this.lru.delete(oldest);
      this.byMethod.get(oldest.method)?.delete(oldest.key);
    }
  }
}

/** The provisioned accepted key set, or undefined when the deploy never provisioned one (local/test — enforcement off). */
function acceptedKeys(): readonly string[] | undefined {
  const raw = process.env[RPC_ACCEPTED_KEYS_ENV];
  if (raw === undefined || raw === '') return undefined; // unprovisioned → pass through

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // provisioned but unreadable → deny all
  }
  return Array.isArray(parsed) && parsed.every((key): key is string => typeof key === 'string')
    ? parsed
    : [];
}

/**
 * Length-independent constant-time string equality — no early exit on the
 * first mismatched character or on a length difference, so a caller cannot
 * time its way toward a valid key. No `node:crypto`, to keep this module
 * runtime-agnostic.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) {
    diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}

/** Whether `presented` is a member of `accepted` — always compares against every key. */
function isAcceptedKey(presented: string, accepted: readonly string[]): boolean {
  let matched = false;
  for (const key of accepted) {
    matched = constantTimeEquals(presented, key) || matched;
  }
  return matched;
}

const BEARER_PREFIX = 'Bearer ';

/** The bearer token on `Authorization`, or `''` if the header is missing or malformed. */
function bearerToken(req: Request): string {
  const header = req.headers.get('authorization');
  return header?.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : '';
}

const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * Flattens every exposed port's methods into one method → {schemas, handler}
 * table. RPC dispatch is flat (`/rpc/<method>`), so a method name exposed by
 * more than one port is a construction-time error, as is a missing handler.
 */
function methodTable(
  expose: Expose,
  handlers: Record<string, Record<string, RpcHandler>>,
): Map<string, MethodSchemas & { handler: RpcHandler }> {
  const table = new Map<string, MethodSchemas & { handler: RpcHandler }>();

  for (const [port, contract] of Object.entries(expose)) {
    // Only rpc ports carry dispatchable methods; a non-rpc exposed port
    // (its __cmp is connection config, not a function map) is not serve()'s
    // to handle — the type-level mirror is RpcPortKeys in Handlers<S>.
    if (contract.kind !== 'rpc') continue;
    const portHandlers = handlers[port] ?? {};
    for (const [method, fn] of Object.entries(contract.__cmp)) {
      if (table.has(method)) {
        throw new Error(
          `serve(): method "${method}" is exposed by more than one port — RPC dispatch is flat ` +
            "(POST /rpc/<method>), so method names must be unique across a service's exposed ports.",
        );
      }
      const handler = portHandlers[method];
      if (handler === undefined) {
        throw new Error(`serve(): no handler supplied for exposed method "${port}.${method}".`);
      }
      const { input, output } = blindCast<
        MethodSchemas,
        'rpc() stores the method input/output Standard Schemas on the function value; the Cmp type models only the call signature'
      >(fn);
      table.set(method, { input, output, handler });
    }
  }

  return table;
}

/**
 * Routes `POST /rpc/<method>`: checks the service key, requires an
 * Idempotency-Key, single-flights/replays through `IdempotencyStore`, and —
 * per call — parses JSON within the body cap, validates input, calls the
 * handler with `service.load()`'s deps plus `{ idempotencyKey }`, validates
 * the output, and responds JSON. A handler or output-validation failure
 * masks its message behind a generic 500 and logs the real error; an
 * unknown method or invalid input is a 4xx. `load()` is called exactly
 * once, here, before the handler ever runs.
 */
export function serve<S extends AnyRunnable, H extends Handlers<S>>(
  service: S,
  handlers: H,
): (req: Request) => Promise<Response> {
  const table = methodTable(
    service.expose ?? {},
    blindCast<
      Record<string, Record<string, RpcHandler>>,
      'Handlers<S> is the exhaustive typed handler map; methodTable indexes it by the runtime port/method strings'
    >(handlers),
  );
  const deps = service.load();
  const idempotency = new IdempotencyStore();

  return async (req: Request): Promise<Response> => {
    const accepted = acceptedKeys();
    if (accepted !== undefined && !isAcceptedKey(bearerToken(req), accepted)) {
      return toResponse(outcome({ error: 'Unauthorized: missing or invalid service key' }, 401));
    }

    const { pathname } = new URL(req.url);
    const methodName = /^\/rpc\/([^/]+)$/.exec(pathname)?.[1];
    if (methodName === undefined) {
      return toResponse(outcome({ error: `Not found: ${pathname}` }, 404));
    }

    const method = table.get(methodName);
    if (method === undefined) {
      return toResponse(outcome({ error: `Unknown RPC method "${methodName}"` }, 404));
    }
    if (req.method !== 'POST') {
      return toResponse(outcome({ error: `Method "${methodName}" requires POST` }, 405));
    }

    // An empty header is the same as no header: the caller sent no key.
    const idempotencyKey = req.headers.get(IDEMPOTENCY_KEY_HEADER.toLowerCase()) || undefined;
    const ctx: RpcHandlerContext = { idempotencyKey };

    const run = async (): Promise<Outcome> => {
      let bodyText: string;
      try {
        bodyText = await readBoundedBody(req, MAX_BODY_BYTES);
      } catch (err) {
        if (err instanceof RequestBodyTooLargeError) {
          return outcome({ error: `Request body exceeds the ${MAX_BODY_BYTES}-byte limit` }, 413);
        }
        // A body-stream I/O error: mask and log like any other internal
        // failure — letting it reject would break serve()'s Response contract.
        console.error(`serve(): reading the request body for "${methodName}" failed:`, err);
        return outcome({ error: INTERNAL_ERROR_MESSAGE }, 500);
      }

      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        return outcome({ error: 'Request body must be JSON' }, 400);
      }

      let input: unknown;
      try {
        input = await standardValidate(method.input, body);
      } catch (err) {
        return outcome({ error: err instanceof Error ? err.message : String(err) }, 400);
      }

      try {
        const result = await method.handler(input, deps, ctx);
        let output: unknown;
        try {
          output = await standardValidate(method.output, result);
        } catch (err) {
          console.error(
            `serve(): handler for "${methodName}" returned output that failed schema validation — this is a provider bug:`,
            err,
          );
          return outcome({ error: INTERNAL_ERROR_MESSAGE }, 500);
        }
        return outcome(output);
      } catch (err) {
        console.error(`serve(): handler for "${methodName}" threw:`, err);
        return outcome({ error: INTERNAL_ERROR_MESSAGE }, 500);
      }
    };

    // Keyed calls dedupe/replay through the store; a keyless one opts out (the
    // generated client always sends a key, so this is a hand-rolled/legacy caller).
    const result =
      idempotencyKey === undefined
        ? await run()
        : await idempotency.dispatch(methodName, idempotencyKey, run);
    return toResponse(result);
  };
}

/**
 * The streams client a consumer's `durableStreams()` binding hydrates to —
 * the RPC parity: RPC users don't hand-roll request encoding (`rpc()` hydrates
 * through `makeClient`), and streams users don't hand-roll the Durable Streams
 * protocol. All protocol knowledge lives here: the URL layout, the bearer
 * scheme, JSON-array append framing, opaque offsets, and the long-poll dance
 * — plus the stream lifecycle (ensure-create, the proven-safe 404 heal) that
 * used to live in application code. The wire client is
 * `@durable-streams/client` (ElectricSQL's canonical protocol client,
 * Apache-2.0); this wrapper narrows it to what the module contract promises
 * and adds the platform compensations, each annotated with the ticket it
 * stands in for.
 *
 * Two classes: `StreamsClient` holds the transport (base URL, bearer header,
 * the per-stream write handles a batched append needs) and hands out one
 * `StreamHandle` per stream name, memoized so its ensure-create state
 * survives repeat calls. `StreamHandle` holds one stream's name and
 * ensure-create memo, and is what a consumer actually calls `append`/`read`/
 * `tail` on — no call site names a stream twice.
 *
 * Exported standalone (and via the umbrella) so local dev and tests can wrap
 * the stand-in's URL without a deployed binding:
 *
 *   const client = new StreamsClient({ url: standIn.url, apiKey: 'unused' });
 *   await client.stream('log').append({ n: 1 });
 */
import {
  BackoffDefaults,
  DurableStream,
  DurableStreamError,
  FetchError,
  stream,
} from '@durable-streams/client';
import type { StreamsConfig } from './contract.ts';

/** A catch-up read: the events from the requested offset, and the cursor to resume from. */
export interface StreamsReadResult<T> {
  readonly events: readonly T[];
  /** Opaque resume cursor (the protocol's `stream-next-offset`); feed it back as `offset`. */
  readonly nextOffset: string;
}

/** One live long-poll delivery, or a timeout with nothing new. */
export interface StreamsTailResult<T> {
  readonly events: readonly T[];
  readonly nextOffset: string;
  readonly timedOut: boolean;
}

const JSON_CONTENT_TYPE = 'application/json';

/**
 * PRO-219: a scale-to-zero streams service can reset the first connection
 * while its instance boots (~3.5–8s observed), so IDEMPOTENT operations ride
 * it out with a bounded backoff. The wire client retries any failure except
 * a 4xx other than 429 — thrown network errors and 5xx statuses included —
 * so a real protocol error (401, 404, 409) surfaces on the first try. The
 * bound is ATTEMPTS, not wall-clock: each wait is jittered up to the current
 * delay, and a server Retry-After acts as a per-wait floor (capped upstream
 * at 1h). Appends never get any of this (see `StreamsClient.append`). Remove
 * when CI's "Cold-start canary (PRO-217)" goes clean — it exists to flag
 * exactly that.
 */
const IDEMPOTENT_BACKOFF = {
  ...BackoffDefaults,
  initialDelay: 250,
  maxDelay: 5_000,
  multiplier: 2,
  maxRetries: 5,
};

/** The wire client retries network errors by default — appends must not be (no idempotency key). */
const NO_RETRY_BACKOFF = { ...BackoffDefaults, maxRetries: 0 };

const DEFAULT_TAIL_TIMEOUT_MS = 20_000;

function isAlreadyExists(error: unknown): boolean {
  return error instanceof DurableStreamError && error.status === 409;
}

/**
 * Whether a client operation failed because the stream does not exist — the
 * one failure that provably applied NOTHING, so re-creating the stream and
 * re-running the operation is safe even for an append. Deliberately exactly
 * that: ambiguous failures (socket closes, 502/504) never match. Not
 * exported — its only consumer is `StreamHandle`'s own heal, so no app code
 * needs the wire client's error shape.
 */
function isStreamNotFound(error: unknown): boolean {
  return (
    (error instanceof FetchError || error instanceof DurableStreamError) && error.status === 404
  );
}

function streamUrl(base: string, name: string): string {
  return `${base}/v1/stream/${encodeURIComponent(name)}`;
}

/**
 * The transport a consumer's `durableStreams()` binding hydrates to (bare
 * form) — holds the base URL, the bearer header, and the per-stream write
 * handles a batched append needs. `stream(name)` is the client's whole
 * public surface: a dynamic streams consumer names a stream by calling it,
 * never by any other method here.
 */
export class StreamsClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  // One write handle per stream: batching off so one append() is one POST
  // (the wire client's default coalescing would make a failure ambiguous
  // across several callers' events), retries off per the append contract.
  private readonly writers = new Map<string, DurableStream>();
  private readonly handles = new Map<string, StreamHandle>();

  constructor(config: StreamsConfig) {
    this.base = config.url.replace(/\/$/, '');
    this.headers = { authorization: `Bearer ${config.apiKey}` };
  }

  /** One handle per stream name, memoized so its ensure-create state survives repeat calls. */
  stream(name: string): StreamHandle {
    let handle = this.handles.get(name);
    if (handle === undefined) {
      handle = new StreamHandle(name, this);
      this.handles.set(name, handle);
    }
    return handle;
  }

  private writer(name: string): DurableStream {
    let handle = this.writers.get(name);
    if (handle === undefined) {
      handle = new DurableStream({
        url: streamUrl(this.base, name),
        headers: this.headers,
        contentType: JSON_CONTENT_TYPE,
        batching: false,
        backoffOptions: NO_RETRY_BACKOFF,
      });
      this.writers.set(name, handle);
    }
    return handle;
  }

  /** Creates the stream (idempotent: an existing stream of any content type is success). Used by `StreamHandle`'s ensure-create. */
  async create(name: string): Promise<void> {
    const handle = new DurableStream({
      url: streamUrl(this.base, name),
      headers: this.headers,
      contentType: JSON_CONTENT_TYPE,
      backoffOptions: IDEMPOTENT_BACKOFF,
    });
    try {
      await handle.create();
    } catch (error) {
      // PUT-create is create-only upstream; a handle's ensure-create is
      // ensure-style, so an existing stream is success.
      if (!isAlreadyExists(error)) throw error;
    }
  }

  /**
   * Appends one JSON event. NEVER retried beyond `StreamHandle`'s one-shot
   * 404 heal: the protocol has no idempotency key, so a failed request is
   * indistinguishable from one that applied — the caller retries, because
   * only it knows whether a duplicate is acceptable.
   */
  async append(name: string, event: unknown): Promise<void> {
    await this.writer(name).append(JSON.stringify(event));
  }

  /** Reads the stream from `offset` (default: the beginning) to the current head. */
  async read<T = unknown>(name: string, opts?: { offset?: string }): Promise<StreamsReadResult<T>> {
    const res = await stream<T>({
      url: streamUrl(this.base, name),
      headers: this.headers,
      offset: opts?.offset ?? '-1',
      live: false,
      json: true, // JSON by contract; don't depend on a content-type header
      backoffOptions: IDEMPOTENT_BACKOFF,
    });
    const events = await res.json<T>();
    return { events, nextOffset: res.offset };
  }

  /**
   * Waits for the next live delivery after `offset` (default: the current
   * head), via long-poll — SSE cannot traverse the Compute ingress (PRO-218).
   * Resolves with the delivered events, or `timedOut: true` after `timeoutMs`
   * (default 20s) with nothing new.
   */
  async tail<T = unknown>(
    name: string,
    opts?: { offset?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<StreamsTailResult<T>> {
    // `offset: 'now'` is the protocol's own "from the current head" — no
    // client-side head dance needed.
    const abort = new AbortController();
    const onCallerAbort = (): void => abort.abort();
    opts?.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => abort.abort(), opts?.timeoutMs ?? DEFAULT_TAIL_TIMEOUT_MS);

    try {
      const res = await stream<T>({
        url: streamUrl(this.base, name),
        headers: this.headers,
        offset: opts?.offset ?? 'now',
        live: 'long-poll',
        // The deployed server's `offset=now` long-poll answers 204 with no
        // content-type, which would defeat the client's JSON-mode
        // detection; this module's streams are JSON by contract.
        json: true,
        backoffOptions: IDEMPOTENT_BACKOFF,
        signal: abort.signal,
      });

      return await new Promise<StreamsTailResult<T>>((resolve, reject) => {
        abort.signal.addEventListener(
          'abort',
          () => resolve({ events: [], nextOffset: res.offset, timedOut: true }),
          { once: true },
        );
        try {
          res.subscribeJson<T>((batch) => {
            if (batch.items.length === 0) return; // control-only delivery, keep waiting
            // Resolve BEFORE aborting: the abort listener above also
            // resolves (as a timeout), and a settled promise ignores it.
            resolve({ events: batch.items, nextOffset: batch.offset, timedOut: false });
            abort.abort(); // stop the session's follow loop
          });
        } catch (error) {
          reject(error);
        }
      });
    } catch (error) {
      // Aborted before the first response: a timeout, not a failure.
      if (abort.signal.aborted)
        return { events: [], nextOffset: opts?.offset ?? 'now', timedOut: true };
      throw error;
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

/**
 * One stream's handle — the name and the ensure-create memo. Everything a
 * `durableStreams(contract)` handle or a `durableStreams()` client's
 * `stream(name)` result exposes; no call site passes a name again.
 *
 * Owns the lifecycle the app used to hand-roll: the first operation creates
 * the stream (memoized here; upstream create is already ensure-style, so a
 * racing second instance is harmless — using a stream is sufficient to
 * create it), and a 404 on any operation heals by dropping the memo,
 * re-creating, and retrying that operation once. A 404 is generated INSTEAD
 * OF a write at every layer, so it proves nothing was applied — retrying
 * once cannot duplicate an event, even an append. Ambiguous failures (socket
 * closes, 502/504) never match `isStreamNotFound` and surface raw.
 */
export class StreamHandle {
  private ensured: Promise<void> | undefined;

  constructor(
    private readonly name: string,
    private readonly transport: StreamsClient,
  ) {}

  private ensureCreate(): Promise<void> {
    if (this.ensured === undefined) {
      this.ensured = this.transport.create(this.name).catch((error: unknown) => {
        this.ensured = undefined;
        throw error;
      });
    }
    return this.ensured;
  }

  private async withHeal<T>(op: () => Promise<T>): Promise<T> {
    await this.ensureCreate();
    try {
      return await op();
    } catch (error) {
      if (!isStreamNotFound(error)) throw error;
      this.ensured = undefined;
      await this.ensureCreate();
      return op();
    }
  }

  /**
   * Appends one JSON event. NEVER retried beyond the one-shot 404 heal above:
   * the protocol has no idempotency key, so a failed request is
   * indistinguishable from one that applied — the caller retries, because
   * only it knows whether a duplicate is acceptable.
   */
  append(event: unknown): Promise<void> {
    return this.withHeal(() => this.transport.append(this.name, event));
  }

  /** Reads the stream from `offset` (default: the beginning) to the current head. */
  read<T = unknown>(opts?: { offset?: string }): Promise<StreamsReadResult<T>> {
    return this.withHeal(() => this.transport.read<T>(this.name, opts));
  }

  /**
   * Waits for the next live delivery after `offset` (default: the current
   * head), via long-poll. Resolves with the delivered events, or
   * `timedOut: true` after `timeoutMs` (default 20s) with nothing new.
   */
  tail<T = unknown>(opts?: {
    offset?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<StreamsTailResult<T>> {
    return this.withHeal(() => this.transport.tail<T>(this.name, opts));
  }
}

import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';

/** A non-2xx response from the Management API (or a transport failure). */
export class PrismaApiError extends Data.TaggedError('PrismaApiError')<{
  readonly status: number;
  readonly message: string;
}> {}

/** The shape openapi-fetch returns from every client call. */
type Result = { data?: unknown; error?: unknown; response: Response };

const attempt = <R extends Result>(f: () => Promise<R>) =>
  Effect.tryPromise({
    try: f,
    catch: (cause) => new PrismaApiError({ status: 0, message: String(cause) }),
  });

const fail = (r: Result) =>
  Effect.fail(new PrismaApiError({ status: r.response.status, message: JSON.stringify(r.error) }));

/** Unwrap `data`, failing on any API error. Preserves the SDK's response type. */
export const call = <R extends Result>(
  f: () => Promise<R>,
): Effect.Effect<NonNullable<R['data']>, PrismaApiError> =>
  attempt(f).pipe(
    Effect.flatMap((r) =>
      r.error !== undefined || r.data === undefined
        ? fail(r)
        : Effect.succeed(r.data as NonNullable<R['data']>),
    ),
  );

/** Unwrap `data`, mapping a 404 to `undefined` (resource gone / not found). */
export const callOptional = <R extends Result>(
  f: () => Promise<R>,
): Effect.Effect<NonNullable<R['data']> | undefined, PrismaApiError> =>
  attempt(f).pipe(
    Effect.flatMap((r) =>
      r.response.status === 404
        ? Effect.succeed(undefined)
        : r.error !== undefined
          ? fail(r)
          : Effect.succeed(r.data as NonNullable<R['data']>),
    ),
  );

/** Fire-and-forget a call, tolerating a 404 (already deleted). */
export const callVoid = <R extends Result>(
  f: () => Promise<R>,
): Effect.Effect<void, PrismaApiError> =>
  attempt(f).pipe(
    Effect.flatMap((r) =>
      r.response.status === 404 || r.error === undefined ? Effect.void : fail(r),
    ),
  );

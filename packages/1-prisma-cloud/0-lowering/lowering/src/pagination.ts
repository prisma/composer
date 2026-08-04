import * as Effect from 'effect/Effect';
import { PrismaApiError } from './http.ts';

/** Far beyond any real collection size per listing; hitting it means the API's pagination is broken. */
const MAX_PAGES = 1000;

export interface Page<T> {
  readonly data: readonly T[];
  readonly pagination: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

const brokenPaginationError = (description: string, reason: string): PrismaApiError =>
  new PrismaApiError({
    status: 0,
    message:
      `listing ${description} ${reason} — the Management API pagination appears broken; ` +
      'refusing to continue with a possibly incomplete listing.',
  });

/** {@link drivePages} in its most common shape: every page's rows, accumulated. */
export const collectPages = <T>(
  description: string,
  fetchPage: (cursor: string | undefined) => Effect.Effect<Page<T>, PrismaApiError>,
): Effect.Effect<readonly T[], PrismaApiError> =>
  Effect.gen(function* () {
    const rows: T[] = [];
    yield* drivePages(description, fetchPage, (data) => {
      rows.push(...data);
      return false;
    });
    return rows;
  });

/**
 * Drives a cursor-paginated Management API listing with a guard against
 * broken pagination: a cursor that does not advance, or more than
 * {@link MAX_PAGES} pages, FAILS instead of hanging forever or returning a
 * listing known to be incomplete. `onPage` receives each page's rows as they
 * arrive; returning `true` stops early (the caller found what it wanted).
 */
export const drivePages = <T>(
  description: string,
  fetchPage: (cursor: string | undefined) => Effect.Effect<Page<T>, PrismaApiError>,
  onPage: (data: readonly T[]) => boolean,
): Effect.Effect<void, PrismaApiError> =>
  Effect.gen(function* () {
    let cursor: string | undefined;
    for (let pageCount = 0; ; pageCount++) {
      if (pageCount >= MAX_PAGES) {
        return yield* Effect.fail(
          brokenPaginationError(description, `did not finish within ${String(MAX_PAGES)} pages`),
        );
      }
      const page = yield* fetchPage(cursor);
      if (onPage(page.data)) return;
      const next = page.pagination.nextCursor;
      if (!page.pagination.hasMore || next === null) return;
      if (next === cursor) {
        return yield* Effect.fail(
          brokenPaginationError(description, 'returned a non-advancing cursor'),
        );
      }
      cursor = next;
    }
  });

/**
 * {@link drivePages} for Promise-based callers (e.g. target's preflight,
 * which speaks the SDK's `{data, error}` shape directly). Same guard, same
 * errors; deliberately a sibling loop rather than a wrapper, because routing
 * a Promise fetch through Effect and back (`Effect.tryPromise` +
 * `runPromise`) would re-wrap the caller's own thrown errors. `fetchPage`
 * rejections propagate untouched.
 */
export async function drivePagesAsync<T>(
  description: string,
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  onPage: (data: readonly T[]) => boolean,
): Promise<void> {
  let cursor: string | undefined;
  for (let pageCount = 0; ; pageCount++) {
    if (pageCount >= MAX_PAGES) {
      throw brokenPaginationError(description, `did not finish within ${String(MAX_PAGES)} pages`);
    }
    const page = await fetchPage(cursor);
    if (onPage(page.data)) return;
    const next = page.pagination.nextCursor;
    if (!page.pagination.hasMore || next === null) return;
    if (next === cursor) {
      throw brokenPaginationError(description, 'returned a non-advancing cursor');
    }
    cursor = next;
  }
}

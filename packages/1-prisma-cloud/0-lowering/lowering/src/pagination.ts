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

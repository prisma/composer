import { blindCast } from '@internal/foundation/casts';
import type { ManagementApiClient } from '../../client.ts';

export interface FakeBranchResource {
  id: string;
  name: string;
  projectId: string;
  branchId: string;
}

export interface FakeState {
  apps: FakeBranchResource[];
  databases: FakeBranchResource[];
  buckets: FakeBranchResource[];
  /** Page size for GET /v1/apps — unset serves everything in one page. */
  appsPageSize?: number;
  /** When set, GET /v1/apps reports hasMore with a nextCursor equal to the request's cursor — a broken, non-advancing pagination. */
  appsCursorStuck?: boolean;
}

export const newFakeState = (overrides: Partial<FakeState> = {}): FakeState => ({
  apps: [],
  databases: [],
  buckets: [],
  ...overrides,
});

const okResponse = <T>(data: T, status = 200) => ({
  data,
  error: undefined,
  response: new Response(null, { status }),
});

type FakeInit = {
  params?: { path?: Record<string, string>; query?: Record<string, string> };
};

/**
 * A stubbed `ManagementApiClient` — just enough of the Management API to
 * exercise the empty-scope guard's branch listings (apps, databases,
 * buckets) without touching the cloud. Pagination quirks (page size, stuck
 * cursor) are modelled on /v1/apps only; the guard drives all three listings
 * through the same pagination helper.
 */
export const fakeClient = (state: FakeState): ManagementApiClient => {
  const singlePage = (rows: FakeBranchResource[], query: Record<string, string>) => {
    const filtered = rows.filter(
      (row) =>
        (query['projectId'] === undefined || row.projectId === query['projectId']) &&
        (query['branchId'] === undefined || row.branchId === query['branchId']),
    );
    return okResponse({
      data: filtered,
      pagination: { nextCursor: null, hasMore: false },
    });
  };

  const GET = (path: string, init: FakeInit = {}) => {
    const query = init.params?.query ?? {};
    if (path === '/v1/apps') {
      const filtered = state.apps.filter(
        (app) =>
          (query['projectId'] === undefined || app.projectId === query['projectId']) &&
          (query['branchId'] === undefined || app.branchId === query['branchId']),
      );
      const offset = query['cursor'] === undefined ? 0 : Number(query['cursor']);
      const pageSize = state.appsPageSize ?? filtered.length;
      const data = filtered.slice(offset, offset + pageSize);
      if (state.appsCursorStuck === true) {
        return Promise.resolve(
          okResponse({ data, pagination: { nextCursor: String(offset), hasMore: true } }),
        );
      }
      const nextOffset = offset + data.length;
      const hasMore = nextOffset < filtered.length;
      return Promise.resolve(
        okResponse({
          data,
          pagination: { nextCursor: hasMore ? String(nextOffset) : null, hasMore },
        }),
      );
    }
    if (path === '/v1/databases') return Promise.resolve(singlePage(state.databases, query));
    if (path === '/v1/buckets') return Promise.resolve(singlePage(state.buckets, query));
    throw new Error(`fakeClient: unexpected GET ${path}`);
  };

  return blindCast<
    ManagementApiClient,
    'a hand-written fake of openapi-fetch’s generated client: it answers only the paths these suites exercise, and reproducing the real generic signature would add no safety the per-path handlers above do not already give'
  >({ GET });
};

export const PROJECT_ID = 'proj-1';

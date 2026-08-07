import { blindCast } from '@internal/foundation/casts';
import type { ManagementApiClient } from '../../client.ts';

export interface FakeApp {
  id: string;
  name: string;
  projectId: string;
  branchId: string;
}

export interface FakeState {
  apps: FakeApp[];
  /** Page size for GET /v1/apps — unset serves everything in one page. */
  appsPageSize?: number;
  /** When set, GET /v1/apps reports hasMore with a nextCursor equal to the request's cursor — a broken, non-advancing pagination. */
  appsCursorStuck?: boolean;
}

export const newFakeState = (overrides: Partial<FakeState> = {}): FakeState => ({
  apps: [],
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
 * exercise the empty-scope guard's app listing without touching the cloud.
 */
export const fakeClient = (state: FakeState): ManagementApiClient => {
  const GET = (path: string, init: FakeInit = {}) => {
    if (path === '/v1/apps') {
      const query = init.params?.query ?? {};
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
    throw new Error(`fakeClient: unexpected GET ${path}`);
  };

  return blindCast<
    ManagementApiClient,
    'a hand-written fake of openapi-fetch’s generated client: it answers only the paths these suites exercise, and reproducing the real generic signature would add no safety the per-path handlers above do not already give'
  >({ GET });
};

export const PROJECT_ID = 'proj-1';

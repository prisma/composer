/**
 * The Management API's build-reporting endpoints, written by hand.
 *
 * TEMPORARY. Every other call in this package goes through the generated
 * `@prisma/management-api-sdk` client, and this one should too — but the SDK
 * does not carry `/v1/builds` yet (the routes land with pdp-control-plane
 * #4855, which is still stacked on two unmerged PRs). Delete this module and
 * move these three calls onto `ManagementClient` as soon as an SDK release
 * includes them; the shapes below are transcribed from that PR's zod schemas
 * and are the same contract, not a parallel one.
 *
 * Nothing here throws. Reporting a build is observability, never a step of a
 * deploy, so a failed call warns and the caller carries on with a value that
 * says the report did not land.
 */

/** Reportable `BuildSource` — the platform rejects the three that name its own surfaces. */
export type BuildSource = 'ci' | 'cli';

export type BuildPhase = 'queued' | 'build' | 'deploy';

export type BuildState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type BuildResourceType =
  | 'project'
  | 'branch'
  | 'database'
  | 'app'
  | 'deployment'
  | 'bucket'
  | 'service_key'
  | 'config_variable';

export type BuildResourceAction = 'created' | 'acted_on' | 'deleted';

/**
 * Identifies a CI run. Supplying it makes creation idempotent — two reporters
 * watching the same run converge on one build instead of racing to create
 * two — and it is what resolves the build's repository, so a build reported
 * without one is never linked to the repository it came from.
 *
 * `repositoryId` and `runId` are digits only: the platform joins the parts
 * with `:`, so a part containing one would let two different runs spell the
 * same key.
 */
export interface BuildRunIdentity {
  readonly provider: 'github';
  readonly repositoryId: string;
  readonly runId: string;
  readonly runAttempt: number;
}

export interface CreateBuildBody {
  readonly source: BuildSource;
  readonly commitSha: string;
  readonly branchName: string;
  readonly runIdentity?: BuildRunIdentity;
  readonly externalLogUrl?: string;
  readonly projectId?: string;
  readonly branchId?: string;
  readonly appId?: string;
}

export interface UpdateBuildBody {
  readonly phase?: BuildPhase;
  readonly state?: BuildState;
  readonly failingStep?: string;
  readonly errorMessage?: string;
  readonly externalLogUrl?: string;
  /**
   * The build's query anchors. Settable at creation today; settable on update
   * only once the amendment requested on pdp-control-plane #4855 lands.
   * Until then the platform rejects an anchors-only update, which is why
   * `BuildsApi.anchor` reports its own failure and nothing else depends on
   * it succeeding.
   */
  readonly projectId?: string;
  readonly branchId?: string;
  readonly appId?: string;
}

export interface BuildsApi {
  /** The created or joined build's id, or `undefined` when the report did not land. */
  create(body: CreateBuildBody): Promise<string | undefined>;
  update(buildId: string, body: UpdateBuildBody): Promise<boolean>;
  reportResource(
    buildId: string,
    resourceType: BuildResourceType,
    resourceId: string,
    action: BuildResourceAction,
  ): Promise<boolean>;
}

export interface BuildsApiOptions {
  readonly origin: string;
  readonly token: string;
  /** Where a failed report goes. Injected so tests can assert on it and the CLI can route it. */
  readonly warn: (message: string) => void;
  /** Injected in tests; defaults to the global. */
  readonly fetch?: typeof globalThis.fetch;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The build id from a create response, or `undefined` when the body is not the shape the contract promises. */
function buildIdOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const data = payload['data'];
  if (!isRecord(data)) return undefined;
  const id = data['id'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

export function buildsApi(options: BuildsApiOptions): BuildsApi {
  const doFetch = options.fetch ?? globalThis.fetch;

  const send = async (
    method: 'POST' | 'PATCH' | 'PUT',
    path: string,
    body: unknown,
    describe: string,
  ): Promise<unknown | undefined> => {
    let response: Response;
    try {
      response = await doFetch(`${options.origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      options.warn(`Could not reach Prisma Cloud to ${describe}: ${detail}`);
      return undefined;
    }

    if (!response.ok) {
      // The body is the platform's own error envelope. It never carries the
      // token — the header does — so quoting it back is safe and is usually
      // the only way to tell a rejected field from a missing permission.
      const detail = await response.text().catch(() => '');
      options.warn(
        `Prisma Cloud refused to ${describe} (HTTP ${String(response.status)})${
          detail.length > 0 ? `: ${detail}` : ''
        }`,
      );
      return undefined;
    }

    if (response.status === 204) return {};
    return await response.json().catch(() => undefined);
  };

  return {
    async create(body) {
      const payload = await send('POST', '/v1/builds', body, 'record this deploy');
      if (payload === undefined) return undefined;
      const id = buildIdOf(payload);
      if (id === undefined) {
        options.warn('Prisma Cloud recorded this deploy but returned no build id.');
      }
      return id;
    },

    async update(buildId, body) {
      const payload = await send(
        'PATCH',
        `/v1/builds/${encodeURIComponent(buildId)}`,
        body,
        "update this deploy's build",
      );
      return payload !== undefined;
    },

    async reportResource(buildId, resourceType, resourceId, action) {
      const payload = await send(
        'PUT',
        `/v1/builds/${encodeURIComponent(buildId)}/resources/${resourceType}/${encodeURIComponent(resourceId)}`,
        { action },
        `record the ${resourceType} this deploy ${action === 'acted_on' ? 'acted on' : action}`,
      );
      return payload !== undefined;
    },
  };
}

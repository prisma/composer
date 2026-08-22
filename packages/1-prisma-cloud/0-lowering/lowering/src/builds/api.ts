/**
 * The Management API's build-reporting endpoints, over the generated SDK
 * client — the same client every other call in this package uses.
 *
 * Nothing here throws. Reporting a build is observability, never a step of a
 * deploy, so a failed call warns and the caller carries on with a value that
 * says the report did not land. That is the whole reason these three calls
 * are wrapped rather than made directly: one place decides what a failure
 * costs, and the answer is always "nothing".
 */
import type { operations } from '@prisma/management-api-sdk';
import type { ManagementApiClient } from '../client.ts';

/**
 * Every shape below is DERIVED from the generated client, never restated. The
 * platform owns this contract, and a hand-kept copy would drift silently the
 * next time it moves — the whole reason to wait for the SDK rather than keep
 * transcribing the routes.
 */
type JsonBody<O> = O extends { requestBody?: { content: { 'application/json': infer B } } }
  ? B
  : never;

/**
 * What a reporter sends to create a build. `runIdentity` is what makes
 * creation idempotent — two reporters watching the same run converge on one
 * build instead of racing to create two — and it is also what resolves the
 * build's repository, so a build reported without one is never linked to the
 * repository it came from.
 */
export type CreateBuildBody = JsonBody<operations['postV1Builds']>;

/**
 * Progress on a build. `projectId`, `branchId`, `appId` and `deployedUrl` are
 * fill-only: a reporter that resolves them partway through a deploy sets them
 * here, re-sending a recorded value is accepted, and changing one is a 409.
 *
 * `applicationTopologyContentHash` is the one field stated here rather than
 * derived: the platform's `Build` table already has the column, the endpoint
 * accepting it is an additive follow-up, and its validator strips unknown
 * keys in the meantime — so sending it is how the value starts landing the
 * moment the platform accepts it. The SDK regeneration retires the
 * intersection.
 */
export type UpdateBuildBody = JsonBody<operations['patchV1BuildsByBuildId']> & {
  applicationTopologyContentHash?: string;
};

type ResourcePath =
  operations['putV1BuildsByBuildIdResourcesByResourceTypeByResourceId']['parameters']['path'];

export type BuildResourceType = ResourcePath['resourceType'];
export type BuildResourceAction = NonNullable<
  JsonBody<operations['putV1BuildsByBuildIdResourcesByResourceTypeByResourceId']>
>['action'];

/** Reportable `BuildSource` — the platform rejects the three that name its own surfaces. */
export type BuildSource = NonNullable<CreateBuildBody>['source'];
export type BuildPhase = NonNullable<NonNullable<UpdateBuildBody>['phase']>;
export type BuildState = NonNullable<NonNullable<UpdateBuildBody>['state']>;
export type BuildRunIdentity = NonNullable<NonNullable<CreateBuildBody>['runIdentity']>;

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
  readonly client: ManagementApiClient;
  /** Where a failed report goes. Injected so tests can assert on it and callers can route it. */
  readonly warn: (message: string) => void;
}

/**
 * Reporting is observability, so no call may stall the deploy: every request
 * carries this deadline, and an expired one is warned and dropped like any
 * other failure.
 */
const REPORT_DEADLINE_MS = 10_000;

/** What openapi-fetch hands back from every call. */
interface ClientResult {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response: Response;
}

export function buildsApi(options: BuildsApiOptions): BuildsApi {
  const { client, warn } = options;

  /** Runs one call, turning every failure — transport or refusal — into a warning and `undefined`. */
  const send = async <R extends ClientResult>(
    call: () => Promise<R>,
    describe: string,
  ): Promise<R['data'] | undefined> => {
    let result: R;
    try {
      result = await call();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warn(`Could not reach Prisma Cloud to ${describe}: ${detail}`);
      return undefined;
    }

    if (!result.response.ok) {
      // The platform's own error envelope. It never carries the token — that
      // rides the header — so quoting it back is safe, and it is usually the
      // only way to tell a rejected field from a missing permission.
      const detail = result.error === undefined ? '' : `: ${JSON.stringify(result.error)}`;
      warn(`Prisma Cloud refused to ${describe} (HTTP ${String(result.response.status)})${detail}`);
      return undefined;
    }

    // A 204 carries no body; `{}` still means the call landed.
    return result.data ?? {};
  };

  return {
    async create(body) {
      const created = await send(
        () => client.POST('/v1/builds', { body, signal: AbortSignal.timeout(REPORT_DEADLINE_MS) }),
        'record this deploy',
      );
      if (created === undefined) return undefined;
      // Typed by the generated client, so this reads the id rather than
      // hunting for it — but a 2xx with no body is still possible on the wire.
      const id = created.data?.id;
      if (id === undefined || id.length === 0) {
        warn('Prisma Cloud recorded this deploy but returned no build id.');
        return undefined;
      }
      return id;
    },

    async update(id, body) {
      const payload = await send(
        () =>
          client.PATCH('/v1/builds/{buildId}', {
            params: { path: { buildId: id } },
            body,
            signal: AbortSignal.timeout(REPORT_DEADLINE_MS),
          }),
        "update this deploy's build",
      );
      return payload !== undefined;
    },

    async reportResource(id, resourceType, resourceId, action) {
      const payload = await send(
        () =>
          client.PUT('/v1/builds/{buildId}/resources/{resourceType}/{resourceId}', {
            params: { path: { buildId: id, resourceType, resourceId } },
            body: { action },
            signal: AbortSignal.timeout(REPORT_DEADLINE_MS),
          }),
        `record the ${resourceType} this deploy ${action === 'acted_on' ? 'acted on' : action}`,
      );
      return payload !== undefined;
    },
  };
}

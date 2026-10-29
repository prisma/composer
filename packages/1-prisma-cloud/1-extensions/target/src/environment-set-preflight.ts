import { inputManifest, isSecretSource, paramManifest } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import { CliStructuredError } from '@internal/foundation/errors';
import { drivePagesAsync, type ManagementApiClient } from '@internal/lowering';
import { prismaCloudContainerOf } from './container.ts';
import type { EnvironmentSetApi, EnvironmentSetMetadata } from './environment-set-api.ts';
import type { RuntimeEnvironmentSet } from './environment-set-state.ts';
import {
  isEnvParamSource,
  isGeneratedParamSource,
  isOriginParamSource,
  paramName,
} from './param.ts';
import { managementClient, type PrismaCloudPreflightInput, runPreflight } from './preflight.ts';
import { secretName } from './secret.ts';

export type EnvironmentSetSelection =
  | string
  | ((input: { readonly environment: string }) => string);

/** Ensures operator configuration while keeping legacy branches unchanged until they select a set. */
export async function runEnvironmentSetPreflight(
  input: PrismaCloudPreflightInput,
  selection?: EnvironmentSetSelection,
  injectedClient?: ManagementApiClient,
): Promise<{ timestamps: ReadonlyMap<string, string>; environmentSet?: RuntimeEnvironmentSet }> {
  const container = prismaCloudContainerOf(input.container);
  const { projectId } = container;
  const branchId = container.branchId ?? container.defaultBranchId;
  if (branchId === undefined)
    throw new Error('prisma-cloud: named sets require the resolved default Branch id.');
  const client = input.credentials?.client ?? injectedClient ?? (await managementClient());
  const api = blindCast<
    EnvironmentSetApi,
    'the companion platform adds these routes; the existing openapi-fetch client transports them unchanged until its generated SDK catches up'
  >(client);
  const sets: EnvironmentSetMetadata[] = [];
  await drivePagesAsync(
    'environment sets',
    async (cursor) => {
      const result = await api.GET('/v1/projects/{projectId}/environment-sets', {
        params: {
          path: { projectId },
          query: { limit: 100, ...(cursor === undefined ? {} : { cursor }) },
        },
      });
      if (result.data === undefined)
        throw apiFailure('list environment sets', result.response.status);
      return result.data;
    },
    (page) => {
      sets.push(...page);
      return false;
    },
  );
  const current = sets.find((set) => set.branches.some((branch) => branch.id === branchId));
  if (
    selection === undefined &&
    current === undefined &&
    (await hasLegacyUserValues(client, projectId, container.branchId))
  ) {
    return { timestamps: await runPreflight(input, { client }) };
  }
  const name =
    typeof selection === 'function'
      ? selection({ environment: input.environment })
      : (selection ?? current?.name ?? 'default');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name))
    throw new Error(
      'Environment set names must use 1–64 letters, digits, hyphens, or underscores.',
    );
  const keys = environmentNames(input);
  const ensured = await api.POST('/v1/projects/{projectId}/environment-sets', {
    params: { path: { projectId } },
    body: { name, keys },
  });
  if (ensured.data === undefined)
    throw apiFailure(`ensure environment set "${name}"`, ensured.response.status);
  const set = ensured.data.data;
  const selected = await api.PUT('/v1/projects/{projectId}/branches/{branchId}/environment-set', {
    params: { path: { projectId, branchId } },
    body: { environmentSetId: set.id },
  });
  if (selected.error !== undefined)
    throw apiFailure(`select environment set "${name}"`, selected.response.status);
  const details = await api.GET('/v1/projects/{projectId}/environment-sets/{environmentSetId}', {
    params: { path: { projectId, environmentSetId: set.id } },
  });
  if (details.data === undefined)
    throw apiFailure(`read environment set "${name}"`, details.response.status);
  const byKey = new Map(details.data.data.variables.map((variable) => [variable.key, variable]));
  const timestamps = new Map<string, string>();
  const missing: string[] = [];
  let filled = 0;
  for (const key of keys) {
    const variable = byKey.get(key);
    if (variable?.isSet) {
      timestamps.set(key, variable.updatedAt);
      continue;
    }
    const value = process.env[key];
    if (value !== undefined) {
      const saved = await api.PATCH(
        '/v1/projects/{projectId}/environment-sets/{environmentSetId}/variables/{key}',
        {
          params: { path: { projectId, environmentSetId: set.id, key } },
          body: { value, onlyIfUnset: true },
        },
      );
      if (saved.data === undefined)
        throw apiFailure(`fill "${key}" in environment set "${name}"`, saved.response.status);
      timestamps.set(key, saved.data.data.updatedAt);
      filled += 1;
    } else {
      missing.push(key);
    }
  }
  const environmentSet: RuntimeEnvironmentSet = {
    id: set.id,
    name,
    projectId,
    branchId,
    keys,
    missing,
    consoleUrl: set.consoleUrl,
  };
  input.report?.({ checked: keys.length, filled, missing: missing.length });
  if (missing.length > 0) {
    const failure = new CliStructuredError(
      'DEPLOY.CONFIGURATION_REQUIRED',
      `Environment set "${name}" needs values for ${missing.join(', ')}.`,
      {
        why: 'The project and uploaded bundles are retained. No service will be released until these declared values are saved.',
        fix: `Enter the values at ${set.consoleUrl}, then click Redeploy. No new build or push is needed.`,
        meta: {
          projectId,
          branchId,
          environmentSetId: set.id,
          missingKeys: missing,
          consoleUrl: set.consoleUrl,
        },
      },
    );
    if (input.deferFailure === undefined) throw failure;
    input.deferFailure(failure);
  }
  return { timestamps, environmentSet };
}

function environmentNames(input: PrismaCloudPreflightInput): string[] {
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (isGeneratedParamSource(value) || isOriginParamSource(value)) return;
    if (isSecretSource(value)) {
      names.add(secretName(value, 'an environment set binding'));
      return;
    }
    if (isEnvParamSource(value)) {
      names.add(value.payload.name);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const member of Array.isArray(value) ? value : Object.values(value)) walk(member);
    }
  };
  for (const { binding } of inputManifest(input.graph)) walk(binding);
  for (const binding of paramManifest(input.graph)) {
    if (isEnvParamSource(binding.binding)) names.add(paramName(binding));
  }
  return [...names].sort();
}

interface LegacyPage {
  readonly data: readonly {
    readonly branchId: string | null;
    readonly key: string;
    readonly isManagedBySystem: boolean;
  }[];
  readonly pagination: { readonly hasMore: boolean; readonly nextCursor: string | null };
}

async function hasLegacyUserValues(
  client: ManagementApiClient,
  projectId: string,
  branchId: string | undefined,
): Promise<boolean> {
  let found = false;
  await drivePagesAsync(
    'legacy environment variables',
    async (cursor) => {
      const result = await client.GET('/v1/environment-variables', {
        params: {
          query: blindCast<
            never,
            'the SDK types this existing query as never; the platform accepts projectId, class, limit, and cursor'
          >({
            projectId,
            class: branchId === undefined ? 'production' : 'preview',
            limit: 100,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        },
      });
      if (result.data === undefined)
        throw apiFailure('inspect legacy configuration', result.response.status);
      return blindCast<
        LegacyPage,
        'the existing environment-variable endpoint returns key, branchId, system ownership, and pagination metadata'
      >(result.data);
    },
    (rows) => {
      found ||= rows.some(
        (row) =>
          (row.branchId === null || row.branchId === branchId) &&
          !row.isManagedBySystem &&
          !row.key.startsWith('COMPOSER_'),
      );
      return found;
    },
  );
  return found;
}

function apiFailure(operation: string, status: number): CliStructuredError {
  return new CliStructuredError(
    'DEPLOY.PREFLIGHT_FAILED',
    `Could not ${operation} (HTTP ${status}).`,
    {
      fix: 'Check access to this project and that the platform supports named environment sets, then deploy again.',
    },
  );
}

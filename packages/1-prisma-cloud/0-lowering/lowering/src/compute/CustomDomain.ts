import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import { type ManagementApiClient, ManagementClient } from '../client.ts';
import { call, callOptional, callVoid, PrismaApiError } from '../http.ts';

export interface CustomDomainProps {
  readonly appId: string;
  readonly hostname: string;
  readonly projectId: string;
  readonly consoleUrl: string;
  /** Orders registration after the app has a promoted deployment. */
  readonly deploymentId: string;
}

export interface CustomDomainAttributes {
  readonly hostname: string;
  readonly status: string;
  readonly setupUrl: string;
  readonly domainId?: string;
}

export type CustomDomain = Resource<
  'PrismaComposer.CustomDomain',
  CustomDomainProps,
  CustomDomainAttributes
>;
export const CustomDomain = Resource<CustomDomain>('PrismaComposer.CustomDomain');

type Domain = { readonly id: string; readonly hostname: string; readonly status: string };

function attributes(
  props: CustomDomainProps,
  setupUrl: string,
  domain?: Domain,
): CustomDomainAttributes {
  return {
    hostname: props.hostname,
    setupUrl,
    status: domain?.status ?? 'setup_required',
    ...(domain ? { domainId: domain.id } : {}),
  };
}

function isSetupRequired(status: number, body: unknown): boolean {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const error = body.error;
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return (
    (status === 422 && error.code === 'domain-ownership-required') ||
    (status === 400 && error.code === 'domain-dns-required')
  );
}

/** One declared hostname owns its binding; unrelated domains on the app are never enumerated for deletion. */
export function customDomainProviderService(
  client: ManagementApiClient,
): Provider.ProviderService<CustomDomain> {
  const find = (props: CustomDomainProps) =>
    callOptional(() =>
      client.GET('/v1/apps/{appId}/domains', { params: { path: { appId: props.appId } } }),
    ).pipe(
      Effect.map((page) =>
        page?.data.find((domain) => domain.hostname.toLowerCase() === props.hostname),
      ),
    );

  const setupUrl = (props: CustomDomainProps) =>
    call(() =>
      client.GET('/v1/projects/{id}', {
        params: { path: { id: props.projectId } },
      }),
    ).pipe(
      Effect.map((project) =>
        domainSetupUrl(
          props.consoleUrl,
          project.data.workspace.id,
          props.projectId,
          props.appId,
          props.hostname,
        ),
      ),
    );

  return {
    list: () => Effect.succeed([]),
    // DNS and Console changes happen outside deploy state, so observe them on every deploy.
    diff: () => Effect.succeed({ action: 'update' as const }),
    reconcile: ({ news }) =>
      Effect.gen(function* () {
        const url = yield* setupUrl(news);
        const existing = yield* find(news);
        if (existing) return attributes(news, url, existing);
        const response = yield* Effect.tryPromise({
          try: () =>
            client.POST('/v1/apps/{appId}/domains', {
              params: { path: { appId: news.appId } },
              body: { hostname: news.hostname },
            }),
          catch: (cause) => new PrismaApiError({ status: 0, message: String(cause) }),
        });
        if (response.data) return attributes(news, url, response.data.data);
        if (isSetupRequired(response.response.status, response.error)) return attributes(news, url);
        if (response.response.status === 409) {
          const raced = yield* find(news);
          if (raced) return attributes(news, url, raced);
        }
        return yield* Effect.fail(
          new PrismaApiError({
            status: response.response.status,
            message: JSON.stringify(response.error),
          }),
        );
      }),
    read: ({ olds }) =>
      Effect.gen(function* () {
        const domain = yield* find(olds);
        // A declaration authorizes adopting a matching binding completed in Console.
        return domain ? attributes(olds, yield* setupUrl(olds), domain) : undefined;
      }),
    delete: ({ olds, output }) =>
      Effect.gen(function* () {
        const current = yield* find(olds);
        if (current && (output.domainId === undefined || current.id === output.domainId)) {
          yield* callVoid(() =>
            client.DELETE('/v1/domains/{domainId}', {
              params: { path: { domainId: current.id } },
            }),
          );
        }
      }),
  };
}

export const CustomDomainProvider = () =>
  Provider.effect(
    CustomDomain,
    Effect.gen(function* () {
      return customDomainProviderService(yield* ManagementClient);
    }),
  );

export function domainSetupUrl(
  consoleUrl: string,
  workspaceId: string,
  projectId: string,
  appId: string,
  hostname: string,
): string {
  const workspace = encodeURIComponent(workspaceId.replace(/^wksp_/, ''));
  const project = encodeURIComponent(projectId.replace(/^proj_/, ''));
  const app = encodeURIComponent(appId.replace(/^cps_/, ''));
  const url = new URL(
    `${workspace}/${project}/compute/${app}/domains`,
    `${consoleUrl.replace(/\/$/, '')}/`,
  );
  url.searchParams.set('setup', hostname);
  return url.href;
}

/** Reads the actual branch name rather than assuming the default branch is called main. */
export const customDomainBranchName = (branchId: string) =>
  Effect.gen(function* () {
    const client = yield* ManagementClient;
    const branch = yield* call(() =>
      client.GET('/v1/branches/{branchId}', { params: { path: { branchId } } }),
    );
    return branch.data.gitName;
  });

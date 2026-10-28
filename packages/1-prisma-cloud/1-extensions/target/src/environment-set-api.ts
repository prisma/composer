interface ApiResponse<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response: Response;
}

export interface EnvironmentSetMetadata {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly branches: readonly { readonly id: string }[];
}

export interface EnvironmentSetDetail extends EnvironmentSetMetadata {
  readonly variables: readonly {
    readonly key: string;
    readonly isSet: boolean;
    readonly updatedAt: string;
  }[];
}

/** Routes supplied by the companion platform change, pending the generated SDK release. */
export interface EnvironmentSetApi {
  GET(
    path: '/v1/projects/{projectId}/environment-sets',
    options: { params: { path: { projectId: string }; query: { cursor?: string; limit: number } } },
  ): Promise<
    ApiResponse<{
      data: EnvironmentSetMetadata[];
      pagination: { hasMore: boolean; nextCursor: string | null };
    }>
  >;
  GET(
    path: '/v1/projects/{projectId}/environment-sets/{environmentSetId}',
    options: { params: { path: { projectId: string; environmentSetId: string } } },
  ): Promise<ApiResponse<{ data: EnvironmentSetDetail }>>;
  POST(
    path: '/v1/projects/{projectId}/environment-sets',
    options: { params: { path: { projectId: string } }; body: { name: string; keys: string[] } },
  ): Promise<ApiResponse<{ data: EnvironmentSetMetadata & { consoleUrl: string } }>>;
  POST(
    path: '/v1/deployments/{deploymentId}/release',
    options: { params: { path: { deploymentId: string } } },
  ): Promise<ApiResponse<{ data: { serviceEndpointDomain: string } }>>;
  PATCH(
    path: '/v1/projects/{projectId}/environment-sets/{environmentSetId}/variables/{key}',
    options: {
      params: { path: { projectId: string; environmentSetId: string; key: string } };
      body: { value: string; onlyIfUnset: boolean };
    },
  ): Promise<ApiResponse<{ data: { updatedAt: string } }>>;
  PUT(
    path: '/v1/projects/{projectId}/branches/{branchId}/environment-set',
    options: {
      params: { path: { projectId: string; branchId: string } };
      body: { environmentSetId: string };
    },
  ): Promise<ApiResponse<unknown>>;
  PUT(
    path: '/v1/deployments/{deploymentId}/artifact',
    options: {
      params: { path: { deploymentId: string } };
      body: { artifactHash: string; requiredEnvironmentVariables: string[] };
    },
  ): Promise<ApiResponse<{ data: { id: string; artifactHash: string; consoleUrl: string } }>>;
}

/**
 * The authoring vocabulary for Prisma Cloud — nodes carrying their
 * connection and config knowledge. The driver is a parameter, so the extension
 * ships none and the client type is inferred. Imports @prisma/composer and
 * nothing else. Pure barrel — implementations live in the named modules.
 */

export { compute } from '../compute.ts';
export type { HttpClient } from '../http.ts';
export { http } from '../http.ts';
export { envParam, paramName } from '../param.ts';
export type { PostgresConfig } from '../postgres.ts';
export { postgres, postgresContract } from '../postgres.ts';
export type { ProvisionedEdge } from '../provisioned-edges.ts';
export { provisionedEdges } from '../provisioned-edges.ts';
export type { CredentialsConfig, CredentialsContract } from '../s3-credentials.ts';
export { credentialsContract, s3Credentials } from '../s3-credentials.ts';
export { s3StoreService } from '../s3-store.ts';
export { envSecret, secretName } from '../secret.ts';
export { configKey } from '../serializer.ts';
export { STREAMS_API_KEY, STREAMS_API_KEY_ENV, streamsApiKeyNeed } from '../streams-keys.ts';

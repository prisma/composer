/**
 * The authoring vocabulary for Prisma Cloud — nodes carrying their
 * connection and config knowledge. The driver is a parameter, so the extension
 * ships none and the client type is inferred. Imports @prisma/compose and
 * nothing else. Pure barrel — implementations live in the named modules.
 */

export { compute } from './compute.ts';
export type { HttpClient } from './http.ts';
export { http } from './http.ts';
export type { PostgresConfig } from './postgres.ts';
export { postgres, postgresContract } from './postgres.ts';
export { configKey } from './serializer.ts';

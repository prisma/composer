/**
 * The authoring vocabulary for Prisma Cloud — nodes carrying their
 * connection and config knowledge. The driver is a parameter, so the pack
 * ships none and the client type is inferred. Imports @makerkit/core and
 * nothing else. Pure barrel — implementations live in the named modules.
 */
export { postgres } from "./postgres.ts";
export type { PostgresConfig } from "./postgres.ts";
export { compute } from "./compute.ts";

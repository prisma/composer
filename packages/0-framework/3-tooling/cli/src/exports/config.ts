/** The config adapters and the pool readers (ADR-0062): imported by prisma.config.ts and by the generated stack files, so this entry imports nothing heavier than node:fs, node:path and dotenv. */
export { dotenv, environmentVariables } from '../config-adapters.ts';
export type { PoolReadInput } from '../config-pools.ts';
export { readConfigPool, readSecretsPool } from '../config-pools.ts';

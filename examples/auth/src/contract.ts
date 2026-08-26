/**
 * The (empty) app-space contract wrapped into the framework's `postgres`
 * kind — the resource end references it (`postgres({ name, contract,
 * config })`); no service consumes the app space, so there is no dependency
 * end: the auth module claims the database through its own `authDb()` pack
 * requirement.
 */
import { dataContract } from '@prisma/composer-prisma-cloud/orm';
import type { Contract } from '../contract.d.ts';
import contractJson from '../contract.json' with { type: 'json' };

export const appContract = dataContract<Contract>(contractJson);

/**
 * orders' Prisma ORM data contract wrapped into the framework's
 * `postgres` kind — referenced by both the resource end (module.ts) and
 * the dependency end (service.ts). Emitted from contract.prisma by
 * `prisma contract emit`.
 */
import { dataContract } from '@prisma/composer-prisma-cloud/orm';
import type { Contract } from '../contract.d.ts';
import contractJson from '../contract.json' with { type: 'json' };

export const ordersData = dataContract<Contract>(contractJson);

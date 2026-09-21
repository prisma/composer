/**
 * catalog's Prisma ORM data contract wrapped into the framework's
 * `postgres` kind — the ONE value both ends reference: the resource end
 * (`postgres({ name, contract, config })` in module.ts) and the dependency
 * end (`postgres(catalogData)` in service.ts). Emitted from contract.prisma
 * by `prisma contract emit`.
 */
import { dataContract } from '@prisma/composer-prisma-cloud/orm';
import type { Contract } from '../contract.d.ts';
import contractJson from '../contract.json' with { type: 'json' };

export const catalogData = dataContract<Contract>(contractJson);

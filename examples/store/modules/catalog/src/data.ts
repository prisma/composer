/**
 * catalog's Prisma Next data contract wrapped into the framework's
 * `prisma-next` kind — the ONE value both ends reference: the resource end
 * (`pnPostgres({ name, contract, config })` in module.ts) and the dependency
 * end (`pnPostgres(catalogData)` in service.ts). Emitted from contract.prisma
 * by `prisma-next contract emit`.
 */
import { pnContract } from '@prisma/compose-prisma-cloud/prisma-next';
import type { Contract } from '../contract.d.ts';
import contractJson from '../contract.json' with { type: 'json' };

export const catalogData = pnContract<Contract>(contractJson);

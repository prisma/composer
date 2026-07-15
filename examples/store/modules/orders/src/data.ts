/**
 * orders' Prisma Next data contract wrapped into the framework's
 * `prisma-next` kind — referenced by both the resource end (module.ts) and
 * the dependency end (service.ts). Emitted from contract.prisma by
 * `prisma-next contract emit`.
 */
import { pnContract } from '@prisma/compose-prisma-cloud/prisma-next';
import type { Contract } from '../contract.d.ts';
import contractJson from '../contract.json' with { type: 'json' };

export const ordersData = pnContract<Contract>(contractJson);

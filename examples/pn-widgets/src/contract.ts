/**
 * The Widget data contract wrapped into the framework's `prisma-next` kind —
 * the ONE value both ends reference: the resource end
 * (`pnPostgres({ name, contract, config })` in module.ts) and the dependency
 * end (`pnPostgres(contract)` in service.ts). `contractJson` is the emitted
 * data the runtime hydrates from; `Contract` is the emitted branded type the
 * service's typed client flows from (PSL-first authoring mode — the type is
 * passed explicitly since a JSON import's inferred type is plain data).
 */
import { pnContract } from '@prisma/compose-prisma-cloud/prisma-next';
import type { Contract } from '../contract.d.ts';
import contractJson from '../contract.json' with { type: 'json' };

export const widgetContract = pnContract<Contract>(contractJson);

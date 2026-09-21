/**
 * The Widget data contract wrapped into the framework's `postgres` kind —
 * the ONE value both ends reference: the resource end
 * (`postgres({ name, contract, config })` in module.ts) and the dependency
 * end (`postgres(contract)` in service.ts). `contractJson` is the emitted
 * data the runtime hydrates from; `Contract` is the emitted branded type the
 * service's typed client flows from (PSL-first authoring mode — the type is
 * passed explicitly since a JSON import's inferred type is plain data).
 */
import { dataContract } from '@prisma/composer-prisma-cloud/orm';
import type { Contract } from '../contract.d.ts';
import contractJson from '../contract.json' with { type: 'json' };

export const widgetContract = dataContract<Contract>(contractJson);

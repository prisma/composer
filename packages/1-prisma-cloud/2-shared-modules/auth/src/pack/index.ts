/**
 * The `auth` contract space as a Prisma Next extension pack (mirrors
 * `@prisma/orm-extension-supabase`'s `supabasePack`): the emitted Better
 * Auth contract plus the shipped migration packages, in-memory. A consumer
 * lists `authPack` in their `prisma.config.ts` and their normal
 * migration step creates and evolves the auth tables beside their own —
 * `migration plan` materialises the shipped packages into the project's
 * `migrations/auth/` directory.
 *
 * Control policy is MANAGED (the emit default) — unlike Supabase's external
 * tables, OUR migrations create these. Regeneration: edit `contract.prisma`,
 * run `prisma contract emit`, and re-author the migration.
 */
import { blindCast } from '@internal/foundation/casts';
import type { SqlControlExtensionDescriptor } from '@prisma/orm-postgres/family/control';
import { sqlContractCanonicalizationHooks } from '@prisma/orm-postgres/family-contract/canonicalization-hooks';
import { assertDescriptorSelfConsistency } from '@prisma/orm-toolchain/migration-tools/spaces';
import packageJson from '../../package.json' with { type: 'json' };
import { AUTH_PACK_HEAD_HASH, AUTH_PACK_ID, AUTH_SCHEMA } from './constants.ts';
import type { Contract } from './contract.d.ts';
import contractJson from './contract.json' with { type: 'json' };
import initMetadata from './migrations/0001_init/migration.json' with { type: 'json' };
import initOps from './migrations/0001_init/ops.json' with { type: 'json' };

export { AUTH_PACK_HEAD_HASH, AUTH_PACK_ID, AUTH_SCHEMA };

const contract = blindCast<
  Contract,
  'JSON import narrowed to the emitted Contract type; assertDescriptorSelfConsistency below recomputes and verifies the storageHash at load time'
>(contractJson);

type AuthContractSpace = NonNullable<SqlControlExtensionDescriptor<'postgres'>['contractSpace']>;

const authContractSpace: AuthContractSpace = {
  contractJson: contract,
  migrations: [
    {
      dirName: '0001_init',
      metadata: initMetadata,
      ops: blindCast<
        AuthContractSpace['migrations'][number]['ops'],
        'JSON import widened the authored ops (operationClass literals, param unions); the file is exactly what prisma migration plan wrote, hash-attested by migration.json.migrationHash'
      >(initOps),
    },
  ],
  headRef: { hash: AUTH_PACK_HEAD_HASH, invariants: [] },
};

// Fail at load, not at some downstream marker write, if contract.json was
// regenerated without this descriptor's head following it (or vice versa).
assertDescriptorSelfConsistency({
  extensionId: AUTH_PACK_ID,
  target: contract.target,
  targetFamily: contract.targetFamily,
  storage: contract.storage,
  headRefHash: AUTH_PACK_HEAD_HASH,
  ...sqlContractCanonicalizationHooks,
});

/** The `auth` extension pack — list it in a consumer's `prisma.config.ts`. */
export const authPack: SqlControlExtensionDescriptor<'postgres'> = {
  kind: 'extension',
  id: AUTH_PACK_ID,
  familyId: 'sql',
  targetId: 'postgres',
  version: packageJson.version,
  contractSpace: authContractSpace,
  create: () => ({ familyId: 'sql', targetId: 'postgres' }),
};

export default authPack;

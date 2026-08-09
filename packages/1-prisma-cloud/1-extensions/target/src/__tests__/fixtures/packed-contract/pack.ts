/**
 * An extension-pack descriptor for the pack-requirement tests: just enough
 * shape to pass PN's config validation (kind/id/familyId/version) and carry a
 * `contractSpace.headRef.hash` for the preflight to compare. It borrows the
 * gadget fixture's emitted contract because PN validates a descriptor's head
 * against its own `contractJson` at config load, so the two have to agree;
 * nothing under test reads past the head hash.
 */
import { blindCast } from '@internal/foundation/casts';
import type { PostgresConfigOptions } from '@prisma/orm-postgres/config';
import gadgetContractJson from '../gadget-contract/emitted/contract.json' with { type: 'json' };

type PgPack = NonNullable<PostgresConfigOptions['extensions']>[number];
type PgPackContractSpace = NonNullable<PgPack['contractSpace']>;

export const GADGET_PACK_ID = 'gadget';
export const GADGET_PACK_HEAD_HASH: string = gadgetContractJson.storage.storageHash;

const contractSpace: PgPackContractSpace = {
  contractJson: blindCast<
    PgPackContractSpace['contractJson'],
    'JSON import widened the emitted contract literal types; the file is exactly what prisma-next contract emit wrote'
  >(gadgetContractJson),
  migrations: [],
  headRef: { hash: GADGET_PACK_HEAD_HASH, invariants: [] },
};

export const gadgetPack: PgPack = {
  kind: 'extension',
  id: GADGET_PACK_ID,
  familyId: 'sql',
  targetId: 'postgres',
  version: '0.0.1',
  contractSpace,
  create: () => ({ familyId: 'sql', targetId: 'postgres' }),
};

/** The same pack declaring no migratable contract space, so it carries no head. */
export const spacelessPack: PgPack = {
  kind: 'extension',
  id: GADGET_PACK_ID,
  familyId: 'sql',
  targetId: 'postgres',
  version: '0.0.1',
  create: () => ({ familyId: 'sql', targetId: 'postgres' }),
};

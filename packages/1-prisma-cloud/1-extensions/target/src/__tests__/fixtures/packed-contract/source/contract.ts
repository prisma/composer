// TS-authored fixture contract — the packed-contract fixture only exercises
// config loading (resolvePrismaNextConfig / the pack preflight), so the contract is
// the widget shape verbatim; it is never emitted or migrated.
import { defineContract } from '@prisma-next/postgres/contract-builder';

export const contract = defineContract({ extensionPacks: {} }, ({ field: f, model: m }) => ({
  models: {
    Widget: m('Widget', {
      fields: {
        id: f.id.uuidv4String(),
        name: f.text(),
      },
    }),
  },
}));

// TS-authored fixture contract — the packed-contract fixture only exercises
// config loading (resolveOrmConfig / the pack preflight), so the contract is
// the widget shape verbatim; it is never emitted or migrated.
import { defineContract, gen } from '@prisma/orm-postgres/contract-builder';

export const contract = defineContract({ extensions: {} }, ({ field: f, model: m, type: t }) => ({
  models: {
    Widget: m('Widget', {
      fields: {
        id: f.column(t.UuidString()).id().onCreate(gen.uuid()),
        name: f.column(t.String()),
      },
    }),
  },
}));

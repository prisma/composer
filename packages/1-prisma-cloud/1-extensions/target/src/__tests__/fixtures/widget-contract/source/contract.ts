// TS-authored fixture: the widget contract covers Prisma ORM's TS no-emit
// `defineContract()` authoring mode (the gadget fixture covers the PSL-first
// mode), so the two together exercise both modes ADR-0022 says to support.
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

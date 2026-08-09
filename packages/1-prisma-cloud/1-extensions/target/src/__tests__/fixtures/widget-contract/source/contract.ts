// TS-authored fixture: the widget contract covers Prisma Next's TS no-emit
// `defineContract()` authoring mode (the gadget fixture covers the PSL-first
// mode), so the two together exercise both modes ADR-0022 says to support.
import { defineContract } from '@prisma/orm-postgres/contract-builder';

export const contract = defineContract({ extensions: {} }, ({ field: f, model: m }) => ({
  models: {
    Widget: m('Widget', {
      fields: {
        id: f.id.uuidv4String(),
        name: f.text(),
      },
    }),
  },
}));

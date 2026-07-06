// Bundle probe for the import-split guard: uses core's authoring entry the way
// a user service module would, with real value usage so nothing tree-shakes away.
import { configOf, Load, resource, service } from "../../index.ts";

const db = resource({
  type: "probe/db",
  connection: {
    params: { url: { type: "string", secret: true } },
    hydrate: (v) => ({ url: v.url }),
  },
});

const app = service({
  type: "probe/app",
  inputs: { db },
  params: { port: { type: "number", default: 3000 } },
  config: { get: async () => ({}) },
  handler: ({ db: client }) => client,
});

export const graph = Load(app, { id: "probe" });
export const manifest = configOf(app);

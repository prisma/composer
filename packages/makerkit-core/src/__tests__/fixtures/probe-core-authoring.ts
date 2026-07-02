// Bundle probe for the import-split guard: uses core's authoring entry the way
// a user service module would, with real value usage so nothing tree-shakes away.
import { Load, resource, service } from "../../index.ts";

const db = resource<{ query(): string }>({ type: "probe/db" });
const app = service({ type: "probe/app", inputs: { db }, handler: ({ db: client }) => client });

export const graph = Load(app, { id: "probe" });

import { compute, postgres } from "../../index.ts";

// Importing this module must not increment this counter — only calling
// `.run(...)` on the exported node should.
export let handlerCallCount = 0;

export default compute({ db: postgres() }, ({ db }) => {
  handlerCallCount += 1;
  return { db };
});

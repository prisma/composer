/** The (`./app-identity`) subpath: who the app is, from its config and entry, without Load or assemble, and the check a stage name must pass. For commands that read what an app has deployed. */
export type { AppIdentity } from '../pipeline.ts';
export { resolveAppIdentity } from '../pipeline.ts';
export { validateStageName } from '../validate-stage.ts';

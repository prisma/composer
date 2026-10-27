/** The (`./app-identity`) subpath: who the app is, from its config and entry, without Load or assemble, and the check an environment name must pass. For commands that read what an app has deployed. */
export type { AppIdentity } from '../pipeline.ts';
export { resolveAppIdentity } from '../pipeline.ts';
export { validateEnvironmentName } from '../validate-environment.ts';

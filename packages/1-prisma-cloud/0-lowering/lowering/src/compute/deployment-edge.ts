/**
 * The dependency edge that orders a deployment AFTER the environment rows it
 * boots with.
 *
 * The platform materializes a branch's environment variables INTO a deployment
 * when the deployment is created, and never re-reads them (gotchas.md,
 * PRO-211): a deployment created before its rows exist boots without them, for
 * as long as it lives. So the write must be scheduled first, and Alchemy
 * schedules on one thing only — the resource references a prop's VALUE is
 * built from.
 *
 * Upstream's `Prisma.Deployment` has no prop for the environment, so the edge
 * rides `app`: the app id is threaded through every variable's id, and the
 * value the platform receives is the app id itself.
 *
 * `app` is the only prop this can ride. Upstream's diff reads
 * `{portMapping, skipCodeUpload, artifactPath, artifactContentType}` as one
 * block and gives up — returning "no opinion", which the engine turns into a
 * plain update — as soon as ANY of them is unresolved. A brand-new variable
 * has no persisted state, so its reference resolves to a bare resource
 * expression rather than a value; threading it through one of those four props
 * would leave the whole block unresolved on exactly the deploys that add a
 * variable, skipping the artifact comparison. The deployment would then be
 * reused while the new artifact's fingerprint was recorded as deployed — so
 * the code change would be silently dropped, and every later deploy would
 * agree it had already shipped. `app` sits outside that block, and its own
 * check treats an unresolved app as "unchanged" rather than as a change.
 *
 * This edge is the ORDERING half only. Getting a changed environment value
 * into the running app is the other half, and it is not this edge's job:
 * the environment fingerprint (`deploy-fingerprint.ts`) makes a deploy whose
 * environment moved replace the deployment, so the fresh deployment
 * materializes the rows this edge ordered first.
 */

import * as Output from 'alchemy/Output';
import type { EnvironmentVariable } from 'alchemy/Prisma';

export const appAfterEnvironment = (
  app: Output.Output<string>,
  environment: readonly EnvironmentVariable[],
): Output.Output<string> =>
  environment.length === 0
    ? app
    : // The app id is inside the combined expression as well as returned from
      // it: Alchemy's dependency walker looks only at what an expression is
      // built FROM, never inside the function, so an app referenced only by
      // the closure would leave the deployment with no edge to its own app.
      Output.flatMap(
        Output.all(app, ...environment.map((variable) => variable.environmentVariableId)),
        () => app,
      );

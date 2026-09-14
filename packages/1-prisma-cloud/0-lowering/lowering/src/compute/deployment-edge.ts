/**
 * Orders a deployment AFTER the environment rows it boots with: the platform
 * materializes rows into a deployment at create time and never re-reads them
 * (PRO-211). Alchemy schedules only on resource references inside prop
 * values, and upstream's `Prisma.Deployment` has no environment prop, so the
 * edge rides `app`: every variable's id threads through it, and the platform
 * still receives the app id. `app` is the ONLY safe prop — upstream's diff
 * treats `{portMapping, skipCodeUpload, artifactPath, artifactContentType}`
 * as one block and returns "no opinion" if any is unresolved (a brand-new
 * variable always is), which would silently skip the artifact comparison.
 * Ordering only: shipping a CHANGED value is `Deployment.triggers`' job (the
 * compute descriptor declares one member per environment row).
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

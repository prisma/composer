/**
 * Orders a deployment AFTER the environment rows it boots with and after the
 * outputs of the services and resources it reads. The platform materializes
 * rows into a deployment at create time and never re-reads them (PRO-211), and
 * a service's deployment must go live after the deployments of the services
 * it reads, whose `serviceId` resolves only once they are promoted. Alchemy
 * schedules only on resource references inside prop values, and upstream's
 * `Prisma.Deployment` has no environment prop, so the edge rides `app`: whole
 * variable resources preserve their update edges; stable variable IDs alone
 * are folded away during planning. The platform still receives the app id.
 * `app` is the ONLY safe prop — upstream's diff treats `{portMapping,
 * skipCodeUpload, artifactPath, artifactContentType}` as one block and
 * returns "no opinion" if any is unresolved (a brand-new variable always is),
 * which would silently skip the artifact comparison, while an unresolved
 * `app` counts as unchanged. Ordering only: shipping a CHANGED value is
 * `Deployment.triggers`' job (the compute descriptor declares one member per
 * environment row), so waiting on a provider never replaces the deployment.
 */

import type { EnvironmentVariable } from '@alchemy.run/prisma';
import * as Output from 'alchemy/Output';

export const appAfter = (
  app: Output.Output<string>,
  environment: readonly EnvironmentVariable[],
  providerOutputs: readonly Output.Output<unknown>[],
): Output.Output<string> => {
  const waits = [...environment.map((variable) => Output.of(variable)), ...providerOutputs];
  return waits.length === 0
    ? app
    : // The app id is inside the combined expression as well as returned from
      // it: Alchemy's dependency walker looks only at what an expression is
      // built FROM, never inside the function, so an app referenced only by
      // the closure would leave the deployment with no edge to its own app.
      Output.flatMap(Output.all(app, ...waits), () => app);
};

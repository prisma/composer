/**
 * Orders a version AFTER the environment rows it boots with: the platform
 * materializes rows into a version at create time and never re-reads them
 * (PRO-211). Alchemy schedules only on resource references inside prop
 * values, and upstream's `Prisma.ComputeVersion` has no environment prop, so
 * the edge rides `service`: whole variable resources preserve their update
 * edges; stable variable IDs alone are folded away during planning. The
 * platform still receives the service id. `service` is the ONLY safe prop —
 * upstream's diff treats `{portMapping, skipCodeUpload, artifactPath,
 * artifactContentType}` as one block and returns "no opinion" if any is
 * unresolved (a brand-new variable always is), which would silently skip the
 * artifact comparison. Ordering only: shipping a CHANGED value is
 * `ComputeVersion.triggers`' job (the compute descriptor declares one member
 * per environment row).
 */

import type { EnvironmentVariable } from '@alchemy.run/prisma';
import * as Output from 'alchemy/Output';

export const serviceAfterEnvironment = (
  service: Output.Output<string>,
  environment: readonly EnvironmentVariable[],
): Output.Output<string> =>
  environment.length === 0
    ? service
    : // The service id is inside the combined expression as well as returned
      // from it: Alchemy's dependency walker looks only at what an expression
      // is built FROM, never inside the function, so a service referenced only
      // by the closure would leave the version with no edge to its own service.
      Output.flatMap(
        Output.all(service, ...environment.map((variable) => Output.of(variable))),
        () => service,
      );

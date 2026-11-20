/**
 * A deployment's `app` prop, ordered after its environment rows and after the
 * producer outputs the caller passes. The edges ride `app` because upstream
 * treats an unresolved `app` as unchanged, while an unresolved artifact prop
 * would skip the artifact comparison.
 */

import type { EnvironmentVariable } from '@alchemy.run/prisma';
import * as Output from 'alchemy/Output';

export const appAfter = (
  app: Output.Output<string>,
  environment: readonly EnvironmentVariable[],
  producerOutputs: readonly Output.Output<unknown>[],
): Output.Output<string> => {
  const waits = [...environment.map((variable) => Output.of(variable)), ...producerOutputs];
  return waits.length === 0
    ? app
    : // The app id is inside the combined expression as well as returned from
      // it: Alchemy's dependency walker looks only at what an expression is
      // built FROM, never inside the function, so an app referenced only by
      // the closure would leave the deployment with no edge to its own app.
      Output.flatMap(Output.all(app, ...waits), () => app);
};

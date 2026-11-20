/**
 * A deployment's `app` prop, ordered after the producer outputs the caller
 * passes. The edges ride `app` because upstream treats an unresolved `app` as
 * unchanged, while an unresolved artifact prop would skip the artifact
 * comparison.
 */

import * as Output from 'alchemy/Output';

export const appAfter = (
  app: Output.Output<string>,
  producerOutputs: readonly Output.Output<unknown>[],
): Output.Output<string> =>
  producerOutputs.length === 0
    ? app
    : // The app id is inside the combined expression as well as returned from
      // it: Alchemy's dependency walker looks only at what an expression is
      // built FROM, never inside the function, so an app referenced only by
      // the closure would leave the deployment with no edge to its own app.
      Output.flatMap(Output.all(app, ...producerOutputs), () => app);

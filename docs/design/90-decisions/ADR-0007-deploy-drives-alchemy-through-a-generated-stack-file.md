# ADR-0007: Deploy drives Alchemy through a generated stack file

## Decision

`prisma-compose deploy` materializes its work as a small, human-readable stack
module at `.prisma-compose/alchemy.run.ts` — regenerated on every run,
gitignored — and shells out to the `alchemy` CLI against it. It does not
embed Alchemy's provisioning engine programmatically. `prisma-compose destroy`
drives
`alchemy destroy` against the same generated file.

## Reasoning

Here is the file the CLI generates for a single-service app (the deploy root
is always a module — see ADR-0003):

```ts
// .prisma-compose/alchemy.run.ts — generated; do not edit
import { lower } from '@prisma/compose/deploy';
import { fromEnv } from "@prisma/compose-prisma-cloud/target";
import app from "../src/module.ts";

export default lower(app, fromEnv(), {
  name: "hello",
  bundles: { hello: { dir: "/…/hello/dist/bundle", entry: "server.js" } },
});
```

By the time the deploy pipeline reaches its last step, all of its real work
is done: the graph is loaded, the target pack is inferred, every service is
assembled, and the bundle locations are known. What remains is executing the
lowered stack with Alchemy's engine — and the question this ADR answers is
how that execution is invoked.

The answer is to write the pipeline's results down first. The file above *is*
the CLI's work product: which module is the app, which pack's target, what
the application is named, where each assembled bundle landed. Written as a
runnable module, that product becomes inspectable — a failing deploy prints
the file's path, and running `alchemy deploy .prisma-compose/alchemy.run.ts`
directly bisects the failure into "the framework computed the wrong thing" versus
"Alchemy/the platform rejected the right thing". No debugger, no verbose
mode: the artifact between the two modules is a file you can read.

Two properties of the file matter. It carries the *computed* values as
literals (the bundle directories, the name) so what you read is exactly what
ran — but it calls `fromEnv()` rather than embedding the target's
configuration, so credentials and workspace identifiers never land on disk.
And it is regenerated from scratch on every run, so it can never drift from
the pipeline that produces it; it is output, not configuration.

Shelling to the `alchemy` CLI, rather than importing the engine, follows
from the same posture: the alchemy CLI's command surface (`deploy`,
`destroy`, `--stage`) is the engine's stable public interface, and the
generated file is exactly the input that interface consumes. The `--stage`
flag passes straight through — stage semantics belong to Alchemy, so the
generated file carries no stage of its own.

## Consequences

- Failures are bisectable by construction: the error output names the
  generated file, and the file is independently runnable.
- The framework depends only on the alchemy CLI's command surface, not on its
  programmatic API.
- `destroy` evaluates the same stack program as deploy, and evaluating it
  packages the assembled bundles — so an app must be built before it can be
  torn down, and the destroy-path error says exactly that.
- The generated file imports the app's entry by relative path, so it runs
  correctly only from the directory it was generated into — which is the
  working directory, per ADR-0004's tool-state rule.

## Alternatives considered

- **Embedding Alchemy's engine programmatically** — no intermediate artifact
  to inspect when something goes wrong, and it couples the framework to the
  engine's programmatic API surface rather than its CLI contract. The
  bisectability argument alone decides this.
- **Requiring users to write the stack file themselves** — that is precisely
  the hand-maintained deploy wiring ADR-0003 eliminates as the standard path;
  it survives only as the escape hatch (`lower()` called from a hand-composed
  stack) for mixed topologies.

## Related

- [`ADR-0003`](ADR-0003-deploy-derives-everything-from-the-root-node.md) —
  the pipeline whose results the file records.
- [`ADR-0004`](ADR-0004-paths-resolve-relative-to-the-authoring-file.md) —
  where the file and Alchemy's state live.
- [`../10-domains/deploy-cli.md`](../10-domains/deploy-cli.md)

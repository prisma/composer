# ADR-0050: Composer runs as `prisma deploy` and `prisma dev`; it has no binary of its own

## Decision

Composer has no command-line binary of its own. The `prisma` CLI is its only command line, and it mounts exactly two Composer commands:

```sh
prisma deploy module.ts --stage staging   # deploy the app whose root module is module.ts
prisma dev module.ts                      # run the same app locally
```

Tearing an environment down and reading a local app's logs are not commands. They are the `destroy` and `log` operations on `@prisma/composer/control`, called from a short script:

```ts
// destroy-staging.ts
import { fileURLToPath } from 'node:url';
import { destroy } from '@prisma/composer/control';
import prismaConfig from './prisma.config.ts';

const result = await destroy({
  entry: 'module.ts',
  target: { kind: 'stage', stage: 'staging' }, // or { kind: 'production' }
  config: {
    value: prismaConfig.composer,
    file: fileURLToPath(new URL('./prisma.config.ts', import.meta.url)),
  },
});
if (!result.ok) {
  console.error(result.failure.message);
  process.exitCode = 1;
}
```

The script needs `PRISMA_SERVICE_TOKEN` and `PRISMA_WORKSPACE_ID` in the environment, and the app must be built first, as for a deploy. `entry` resolves against the directory the script runs in; `file` resolves against the script's own location.

The standalone `prisma-composer` binary, with its `deploy`, `destroy`, `dev` and `log` subcommands, is retired.

## Reasoning

`@prisma/composer-cli` used to declare a `bin` and also export a command family: a set of command definitions that the `prisma` host (the `prisma` package, built on the Prisma CLI engine) mounts into its own command tree. Two command-line entry points ran the same operations. Users had to learn which one to run, and the docs had to describe both. Composer's configuration already moved into the shared `prisma.config.ts` ([ADR-0049](ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md)), which the engine loads for every command family. A second binary that also loads that file adds nothing. So the package declares no `bin` and ships only the command family.

The family contributes two commands. Both run the pipeline the earlier ADRs describe; only the name a user types changes. `prisma deploy <entry>` takes `--stage`, `--name`, `--report` (write the deploy's outcome as JSON to a file) and `--build-id` (join a deploy record that CI already created). `prisma dev <entry>` takes `--name` and `--fresh`. Both are thin renderers over the matching `@prisma/composer/control` operations ([ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md)).

Most `prisma` commands follow a noun-then-verb grammar, `prisma <noun> <verb>`, such as `prisma auth login`. A few are mounted at the root as bare verbs, such as `prisma init`. `deploy` and `dev` are mounted at the root as bare verbs on purpose, and are not renamed to `prisma project deploy` and `prisma project dev`. They are the two commands a Composer user runs most, the short form is what users and agents will type, and a noun in front adds nothing a reader needs.

`destroy` and `log` get no command. For `destroy`, two things do not fit the CLI. The CLI's destructive verb is `delete`, so a `destroy` command would add a second one. And `destroy` would need a production flag that no other Composer command has: `prisma deploy` targets production when `--stage` is left out, and no Composer command takes `--production`. If teardown gets a command, it should name production the way the CLI already does elsewhere (`prisma project env` takes `--role production`). Where teardown and logs belong in the `prisma` command tree is not decided here; until it is, both stay operations.

A script that calls `destroy` cannot use the `prisma auth login` session; it reads `PRISMA_SERVICE_TOKEN` and `PRISMA_WORKSPACE_ID` from the environment, as the `deploy` operation does. The guides show one script for each operation.

## Consequences

- `@prisma/composer-cli` declares no `bin`. Its only consumer is the `prisma` host, which pins the Composer version it mounts.
- Earlier ADRs that show `prisma-composer deploy`, `destroy` or `dev` describe the same pipeline under the old command name. Their amendment notes point here.
- Teardown and logs need a script, and teardown needs service-token credentials. Before, each was one command. This is the main cost of the decision, and it falls on agents as much as on users: the Agent-first principle asks for tight feedback loops ([guiding principles](../01-principles/guiding-principles.md)), and an agent that wants to read `prisma dev`'s service logs or tear down a stage must now write and run a script, such as the ones in `docs/guides/running-locally.md` and `docs/guides/deploying.md`. It is accepted until teardown and logs get a place in the `prisma` command tree.
- Inside this repository, examples and CI run the published `prisma` host. A root pnpm override points `@prisma/composer-cli` at the workspace package, so they exercise the code in the checkout. Teardown in CI is `scripts/composer-destroy.ts`, which calls the `destroy` operation.
- The examples' `destroy` package scripts pass `--production` or `--stage <name>` to `scripts/composer-destroy.ts`. Those flags name the operation's two targets, `{ kind: 'production' }` and `{ kind: 'stage', stage }`, for this repository's own scripts. They are not a public command grammar, and no `prisma` command takes them. This is accepted because the script is internal and the flags are the shortest way to name a target in a package script.
- A CI lint, `scripts/lint-retired-binary-name.mjs`, fails on the old binary's name in the guides, skills, examples, website, workflows and the packages' shipped source. Files that name it on purpose are listed with an exact count of mentions. The design docs under `docs/design/` are not scanned, because ADRs keep their history.

## Alternatives considered

- **Keep the `prisma-composer` binary alongside the family**: rejected. Two command-line entry points over one pipeline means two sets of docs, two install stories and two places for help text to drift.
- **Name the commands `prisma project deploy` and `prisma project dev`**, to follow the noun-then-verb grammar: rejected. The two most common commands would get longer for no gain in clarity.
- **Mount `destroy` in the `prisma` host**: rejected. It would add a second destructive verb next to `delete`, and a production flag that no other Composer command takes.
- **Mount `log` in the `prisma` host now**: rejected. Where logs belong in the command tree is not decided, and the CLI already has `prisma service logs` for deployed services. A Composer logs command shipped now would probably need renaming once that is decided.

## Related

- [ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md): the operations both commands render, and that the destroy and log scripts call.
- [ADR-0049](ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md): the shared `prisma.config.ts` that made the separate binary unnecessary.
- [ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md), [ADR-0006](ADR-0006-every-node-is-named.md), [ADR-0007](ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md), [ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md), [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md): the decisions whose command examples this renames.
- [`../10-domains/deploy-cli.md`](../10-domains/deploy-cli.md) and [`../10-domains/local-dev.md`](../10-domains/local-dev.md): the two commands' mechanics.
- [Guiding principles](../01-principles/guiding-principles.md): Agent-first, whose cost is weighed above.

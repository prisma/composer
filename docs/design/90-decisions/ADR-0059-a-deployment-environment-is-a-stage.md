# ADR-0059: A deployment environment is a stage, not a branch

## Decision

Composer's word for a deploy-time environment is **stage**. It is a concept of Composer's core and means the same thing on every deployment target. Every public surface uses it: the `--stage` flag, the `destroy` operation's `{ kind: 'stage', stage }` target, the guides, the error messages and the installed agent skill.

```sh
prisma deploy module.ts --stage staging  # the stage named staging
prisma deploy module.ts --stage pr-42    # the stage named pr-42
prisma dev module.ts                     # local development
```

A deployment target decides what a stage becomes on its platform. Prisma Cloud maps it like this:

| Composer stage | Prisma Cloud |
| --- | --- |
| `staging` | the Branch whose `gitName` is `staging` |
| the local development environment (`prisma dev`) | nothing: local dev creates no Branch |

A deploy without `--stage` is still resolved as ADR-0024 describes: at the Project level, on the Project's default Branch. This ADR records the term only and does not change how any stage resolves.

The target's own word appears only where Composer reports what the target did, such as naming the Branch a deploy landed on. It never replaces "stage" in a flag, an input, or a description of Composer's model.

## Reasoning

Composer's core knows nothing about deployment targets. A target's resource types, containers and vocabulary arrive in its extension pack, and the core never branches on which target it is talking to. The deploy-time environment is a core concept: the same module graph deploys unchanged to any stage, the stage is chosen on the command line and never written in the topology, and the deploy state is kept per stage. So its name has to be the core's, not one target's. Alchemy, the deploy engine Composer drives, uses the same word: its `--stage` flag selects the state namespace a run reads and writes.

A Prisma Cloud Branch is that target's container for one environment. It holds the environment's apps, databases, configuration and deploy state. It is the right thing for Prisma Cloud to map a stage to, but it is not the same concept, and the two don't line up one to one.

The clearest case is local development. A stage can name the developer's own machine: `prisma dev` runs the same graph against local emulators, with its own deploy state, under the stage `dev`. That environment is a stage like any other, but no Branch exists for it and none ever will. A Branch can only name an environment on the platform; a stage names any environment the app runs in, local or deployed.

The word "branch" also carries a workflow with it. A Prisma Cloud Branch is named by `gitName` because the platform was built around one workflow: a git branch pushed to GitHub becomes a Branch. Not every project that deploys to Prisma Cloud with Composer works that way. A stage such as `staging` or `pr-42` need not be a git branch, and a flag spelled `--branch staging` reads as "the git branch called staging". Putting that term into Composer's public surface would tie Composer's model to one GitHub-shaped workflow on one target.

The cost is real. The rest of the `prisma` CLI talks about Branches, so a user moves between two words for one environment. Composer pays that cost by naming the mapping where the user needs it: the deploying guide says once that on Prisma Cloud a stage is a Branch, and output that names the platform container names it as a Branch. It does not pay it by adopting the target's term.

## Consequences

- `--stage` stays the public flag, and `{ kind: 'stage', stage }` stays the `destroy` target.
- Code inside the Prisma Cloud extension uses "Branch" for its own container: resolving it, scoping the state API to it, attaching resources to it. That is target vocabulary in target code, and it is correct.
- Anything Composer keys by environment is keyed by stage, never by a target's container name.
- Renaming the public term needs an ADR that supersedes this one.

## Alternatives considered

- **Rename `--stage` to `--branch`, keeping `--stage` as a deprecated alias.** This would remove the translation for Prisma Cloud users. Rejected: it puts one target's term into the core, it reads as a git branch, and the local development environment is a stage that can never be a Branch.
- **Accept both words as permanent synonyms.** Rejected: two names for one concept means guides, errors and agents drift between them, and readers wonder whether they differ.
- **Call it "environment".** Rejected: the word is already taken by environment variables, which Composer writes per stage, and it is too general to name the deploy-time choice precisely.

## Related

- [Guiding principles](../01-principles/guiding-principles.md): the core is agnostic of deployment targets.
- [ADR-0023](ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md): on Prisma Cloud, an app is one Project and a stage is a Branch.
- [ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md): how a stage resolves to its Project and Branch.
- [ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md): the `prisma deploy` flags and the `destroy` operation's targets.
- [Glossary: Stage](../03-domain-model/glossary.md#stage).

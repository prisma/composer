# ADR-0059: A place the app runs is called an environment, not a stage or a branch

## Decision

Composer's word for a place the app runs is **environment**. It is a concept of Composer's core and means the same thing on every deployment target. Every public surface uses it: the `--environment` flag, the `destroy` operation's target, the guides, the error messages and the installed agent skill. It replaces "stage", the word Composer used until now.

```sh
prisma deploy module.ts                        # the environment production
prisma deploy module.ts --environment staging  # the environment named staging
prisma deploy module.ts --environment pr-42    # the environment named pr-42
prisma dev module.ts                           # the environment dev, on this machine
```

A deployment target decides what an environment becomes on its platform. Prisma Cloud maps it like this:

| Composer environment | Prisma Cloud |
| --- | --- |
| `production` | the Branch the platform marks as the Project's default (created as `main`) |
| `staging`, or any other name | the Branch whose `gitName` is that name, created if absent |
| `dev` under `prisma dev` | nothing: local development creates no Branch |

Every environment has a name, and no environment is special. `prisma deploy` uses `production` when `--environment` is left out, and `prisma dev` uses `dev`; those are defaults of each command's parameter, not a privileged environment. How a named environment resolves to its Branch is unchanged from [ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md), which describes it under the old word.

The target's own word appears only where Composer reports what the target did, such as naming the Branch a deploy landed on. It never replaces "environment" in a flag, an input, or a description of Composer's model.

## Reasoning

**Why not "branch".** Composer's core knows nothing about deployment targets. A target's resource types, containers and vocabulary arrive in its extension pack, and the core never branches on which target it is talking to. The place an app runs is a core concept: the same module graph deploys unchanged to any environment, and the deploy state is kept per environment. So its name has to be the core's, not one target's.

A Prisma Cloud Branch is that target's container for one deployed environment. It is the right thing for Prisma Cloud to map an environment to, but the two don't line up one to one. The clearest case is local development: `prisma dev` runs the same graph against local emulators, with its own deploy state, as the environment `dev`. No Branch exists for it and none ever will. Production is another: it lives on a Branch the platform created as `main`, so `--branch production` would name a Branch that doesn't exist and `--branch main` would say nothing about production. "Branch" also carries a workflow with it. A Prisma Cloud Branch is named by `gitName` because the platform grew up around one workflow: push a git branch, get an environment. Not every team works that way; `staging` and `pr-42` need not be git branches, and `--branch staging` reads as "the git branch called staging". The simple sentence that still covers the branch workflow is "an environment per branch".

**Why not "stage".** It was Composer's and Alchemy's word, and it is target-neutral, but it is unnatural: nobody outside deployment tooling calls production or their laptop a stage. "Environment" is what users already say, and it is the word in the dotenv convention Composer's config adapters follow (`.env.production` is an *environment* file). The overlap with "environment variables" is real but weaker than the cost of an unfamiliar word on every surface.

**The cost.** The rest of the `prisma` CLI and Console talk about Branches, so a user moves between two words for one thing on Prisma Cloud. Composer pays that cost by naming the mapping where the user needs it: the deploying guide says once that on Prisma Cloud an environment is a Branch, and output that names the platform container names it as a Branch.

## Consequences

- `--environment` is the public flag on `prisma deploy` and `prisma dev`; `destroy` targets an environment by name. "Stage" disappears from guides, errors, the agent skill and public types. Earlier ADRs that say "stage" describe the same concept under the old word; their amendment notes point here.
- Code inside the Prisma Cloud extension uses "Branch" for its own container: resolving it, scoping the state API to it, attaching resources to it. That is target vocabulary in target code, and it is correct.
- Alchemy, the deploy engine underneath, keeps its own `--stage` flag; Composer passes the environment's name to it. That is engine vocabulary, not Composer's.
- Anything Composer keys by environment is keyed by the environment's name, never by a target's container name.
- Renaming the public term again needs an ADR that supersedes this one.

## Alternatives considered

- **Keep "stage".** Rejected: target-neutral, but unnatural, and it asks every user to learn a word for something they already have a word for.
- **Rename to "branch", keeping "stage" as a deprecated alias.** Rejected: it puts one target's term into the core, it reads as a git branch, production's Branch is called `main`, and local development can never be a Branch.
- **Accept two words as permanent synonyms.** Rejected: guides, errors and agents drift between them, and readers wonder whether they differ.

## Related

- [Guiding principles](../01-principles/guiding-principles.md): the core is agnostic of deployment targets.
- [ADR-0023](ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md): on Prisma Cloud, an app is one Project and an environment is a Branch.
- [ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md): how an environment resolves to its Project and Branch.
- [ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md): the `prisma deploy` flags and the `destroy` operation's targets.
- [Glossary: Environment](../03-domain-model/glossary.md#stage).

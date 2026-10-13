# S2 — A command path can also be a group

Repo: prisma/prisma-cli. Package: `packages/cli-engine` (`@prisma/cli-engine`). Branch `feat/engine-command-group` off `main`.

## At a glance

Today the engine refuses to build a CLI where one command is mounted at a path that is also the prefix of other commands (`packages/cli-engine/src/execution/command-tree.ts:157`, "collides with a command mounted at a prefix of it"). After this slice it accepts it:

```ts
createCli({
  groups: { dev: { brief: "…" } },
  commands: {
    dev: devCommand,          // prisma dev module.ts
    "dev url": devUrlCommand, // prisma dev url gateway
    "dev stop": devStopCommand,
  },
});
```

```bash
prisma dev module.ts      # runs devCommand with entry "module.ts"
prisma dev url gateway    # runs devUrlCommand
prisma dev --help         # devCommand's usage, then the subcommands under dev
prisma dev url --help     # devUrlCommand's help
```

A bare `dev` that also has subcommands is the established convention (`pnpm dev`, `next dev`). The project needs it so `prisma dev <entry>` keeps working while `prisma dev url` and `prisma dev stop` are added.

## Chosen design

- A path may carry both a command and child commands. The path still needs a group declaration in `groups`, because it has children; the group's brief is what appears in its parent's listing.
- Routing: when the next argument after the path is the name of a child, the child runs. Otherwise the path's own command runs with the remaining arguments. A child name therefore wins over a positional argument spelled the same. This is documented, and it is harmless for `dev`, whose positional is a file path.
- Help: `<path> --help` shows the path's own command help and lists the child commands.
- Every existing construction check still applies to both the command and its children. Only the prefix collision check is relaxed. Two commands at the same exact path are still refused.
- Everything else that walks the tree handles a node that is both: shell completion, the `commands` listing, unknown-command suggestions, redirects (a redirect still cannot sit on a mounted path), mount metadata, and anything in `packages/cli` that enumerates mounted paths (`mount-coverage.test.ts`, `e2e-coverage.test.ts`'s key reader).
- If Stricli's route maps support a default command for a route, use that. Otherwise implement the routing in the engine's adapter. The implementer checks which.

## Coherence rationale

One engine capability, proven with stand-in commands. No product command changes. Composer's `dev url` and `dev stop` mount later, in S4.

## Scope

In: the engine change, its tests, the engine's docs (README and AGENTS.md where they describe the tree), the version bump or changeset that the repo's release process expects for an engine change, and docs in `docs/architecture` or `docs/product` that state the old rule.

Out: mounting any Composer command; changing `prisma dev`; output formats.

## Slice-specific done conditions

- [ ] Engine tests with a stand-in `dev` command and `dev url` child cover: the parent runs with a positional; the child runs; `--help` on each; a child name winning over the same-spelled positional; and two commands at one exact path still being refused.

## References

- `docs/architecture/cli-engine-requirements.md` (R12: the shell defines the command tree), `docs/product/command-principles.md`, `docs/product/cli-help-standard.md`.
- Project: `../../spec.md`, `../../design-notes.md`.

## Dispatch plan

1. One dispatch: tests first, then the change, then docs. *Hands to:* the PR.

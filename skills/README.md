# Prisma Composer skills

Agent skills for [Prisma Composer](https://github.com/prisma/composer) — one
`SKILL.md` that teaches an LLM agent how to write, test, and deploy a Prisma
App without re-deriving the API from documentation each time.

## What's in the box

One skill, `prisma-composer`, covering the whole story: the mental model
(Modules, `compute()`, `service.load()`), RPC contracts, databases, reusable
modules (cron/storage/streams), config params, secrets, testing
(`mockService`/`bootstrapService`), deploying (`prisma-composer deploy`,
stages, destroy), and the production pitfalls. Composer's surface is small
enough for one skill; there is no router or per-topic cluster.

## Install

```bash
npx skills add prisma/composer --skill prisma-composer
```

The [`skills` CLI](https://npmjs.com/package/skills) installs it at the
project level for the agent runtimes it detects (`-a <agent>` to pick one).
Install the git ref matching your `@prisma/composer` version — the skill's
surface tracks this repo's packages.

## Authoring rules

The skill is the agent-condensed mirror of the human guides in
[`docs/guides/`](../docs/guides/) — the guides are canonical for humans; a
surface change lands in both. For anyone editing the skill:

- **Verify every claim while drafting, not in a final pass.** Every import
  must resolve against a `packages/9-public/*` export map, and every CLI
  flag/command against `packages/0-framework/3-tooling/cli/`. If ripgrep finds
  nothing, the surface doesn't ship — name it under *What Composer doesn't do
  yet* instead of extrapolating.
- **The skill must be self-contained.** It gets installed into other repos, so
  no link may resolve outside `skills/prisma-composer/`. Repo docs may be
  named in prose ("`docs/design/10-domains/testing.md` in the prisma/composer
  repo"), never linked relatively.
- **Teach concepts, not procedures.** Name the moving parts and the command
  that reveals each piece of state; reserve numbered steps for one-safe-path
  operations.
- **Folder name and frontmatter `name` must match** — the runtimes key on the
  frontmatter, humans on the folder.

Maintainer-facing skills (release process, commit conventions) live in
[`../skills-contrib/`](../skills-contrib/), not here.

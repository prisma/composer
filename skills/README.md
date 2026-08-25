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

The skill ships inside the `@prisma/composer` tarball, so installing the
package is what brings it in. `prisma skills sync` (from the `prisma` CLI)
copies it out of `node_modules` into the skill directories the agent runtimes
read — `.claude/skills/`, `.cursor/skills/`, `.agents/skills/`,
`.windsurf/skills/`:

```bash
pnpm add @prisma/composer
pnpm add -D prisma
pnpm prisma skills sync
```

Add it to your project's `postinstall` so an upgrade brings the matching skill
with it:

```jsonc
// package.json
"scripts": {
  "postinstall": "prisma skills sync || exit 0"
}
```

The version you read is then always the version you installed: the skill's
frontmatter carries `metadata.library: "@prisma/composer"` and a
`metadata.library_version` stamped by the release that built the tarball
([`scripts/set-version.ts`](../scripts/set-version.ts);
[`scripts/check-skill-packaging.mjs`](../scripts/check-skill-packaging.mjs)
proves it against the packed artifact).

### Without installing the package

The GitHub source stays available for anyone who wants the skill without
`@prisma/composer` in their project:

```bash
npx skills add prisma/composer
```

The [`skills` CLI](https://npmjs.com/package/skills) installs it at the
project level for the agent runtimes it detects (`-a <agent>` to pick one).
Nothing keeps this copy in step with your packages, so pick the git ref
matching your `@prisma/composer` version by hand and re-do it on every
upgrade.

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
- **Leave the `metadata` stamp alone.** `metadata.library` names the npm
  package the skill ships inside, and `metadata.library_version` is rewritten
  by [`scripts/set-version.ts`](../scripts/set-version.ts) on every release —
  hand-editing the version, or dropping either key, breaks the release script
  and [`scripts/check-skill-packaging.mjs`](../scripts/check-skill-packaging.mjs).
  They live under `metadata` because the Agent Skills spec defines the
  top-level keys and reserves that map (string → string) for publisher
  extensions. A new skill needs both keys, with any placeholder version.
- **Folder name and frontmatter `name` must match** — the runtimes key on the
  frontmatter, humans on the folder.

Maintainer-facing skills (release process, commit conventions) live in
[`../skills-contrib/`](../skills-contrib/), not here.

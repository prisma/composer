# The Alchemy change: specification and plan

## Specification

The contract is [../../design.md](../../design.md), sections 2 to 4, 6, 8 and 9. Where this file and the design disagree, the design wins, and the disagreement is reported, not resolved silently.

Done means:

- `Prisma.ComputeService` and `Prisma.ComputeVersion` exist under those names, with type aliases for the old ones, and old state rows still read correctly.
- A service has an active version. A second active version for one service fails the plan.
- A replaced `Prisma.ComputeVersion` is left on the platform.
- `Prisma.Compute` declares a service, one environment variable per key, a version and, when it builds, an artifact, as child resources, and has no Management API code of its own.
- A stack deployed with the old `Prisma.Compute` either keeps its service or stops with a clear error. It is never deleted or duplicated.
- A live test deploys a service, deploys a new artifact, calls the platform's rollback, and sees the first version serving.
- The package's shape tests, type check, lint, export check and JSDoc check pass. The hand-written docs and examples use the new names.
- A description file for the pull request exists, with the breaking changes listed at the top.

Out of scope: any change to Composer; converting the existing fake-based test suites to live tests; fixing plain-text secrets in Alchemy state.

## Rules for every step

- Read `AGENTS.md` in the checkout, and `.agents/skills/alchemy-provider/SKILL.md` with its `review.md` and `docs.md`, before writing code. Follow them over habit.
- Small commits, each building and passing the gate below. Commit as the bot with both sign-offs: `git commit -s --trailer "Signed-off-by: Will Madden <madden@prisma.io>"`. No co-author trailer.
- Push to the remote `bot` only. Never push to `origin`. Never open a pull request.
- Never print credentials. Live tests load `~/.config/prisma-compose/deploy.env` and set `CI=true`; projects they create are named for the test and destroyed by it.
- Stop and report when the design does not cover a choice that changes behaviour a user would see. Do not guess.

## The gate

Run from the checkout root, and report each command's result:

1. `pnpm exec tsrs -b` (type check)
2. `pnpm lint`
3. `pnpm exports:check`
4. `pnpm docs:check-jsdoc`
5. `pnpm test:integration test/Prisma --tags unit` and `--tags local` (the fake-based and local suites), with `CI=true` and a fake token as `scripts/with-fake-profiles.sh` sets it
6. From step 2 onward, the live tests the step adds: `pnpm test:integration test/Prisma/<file> --retry 0` with the real token

If a command cannot run in this environment, say exactly why. Do not report a skipped command as passed.

## Steps

Each step is one dispatch to the implementer, then a review.

1. **Checkout and renames.** Create the checkout and branch. Rename `Prisma.App` to `Prisma.ComputeService` and `Prisma.Deployment` to `Prisma.ComputeVersion`, with type aliases; rename props and attributes (`app` to `service`, `appId` to `serviceId`, `deploymentId` to `versionId`, `appEndpointDomain` to `serviceEndpointDomain`, and the same on `Prisma.Compute`), reading old names from old rows. Update the shape tests, docs and examples for the names. No behaviour change. Find out from the history why the root modules `ComputeService` and `ComputeVersion` were removed. (Design 3.1.)
2. **The version and the service's active version.** `Prisma.ComputeVersion`: default removal policy `retain`, own-URL check, replacement when the artifact is unknown, `promote` removed, the `skipCodeUpload` check. `Prisma.ComputeService`: the active version, with `precreate`, promote, the stable-endpoint check, restore on failure, and refusal of a second active version. The monolith calls the same code. Live test: deploy, new artifact, rollback. (Design 3.2 to 3.4.)
3. **The build artifact.** `Prisma.ComputeArtifact`, and skipping unchanged work in it and in `Prisma.WebsiteArtifact`. (Design 4.6.)
4. **Old `Prisma.Compute` stacks.** The new host refuses an old state row with a clear error that says what to do, and never runs the old delete for it. (Design 6, and the plan's standing decision.)
5. **The composition.** `Prisma.Compute` declares its children; the monolith's code is deleted; dev mode moves to `Command.Dev`; the `service` and `triggers` props. (Design 4.)
6. **Tests, docs, examples, description.** Remaining live tests, the docs pages, the examples, and the pull request description file. (Design 8 and 9.)

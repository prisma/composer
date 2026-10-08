---
name: upgrade-alchemy-effect
description: >-
  How to upgrade `alchemy` and `effect` across this repo and keep them
  consistent for consumers: which packages declare what, what breaks in a
  typical upgrade, and how to verify a standalone `npm install` still resolves
  a single `effect`. Use when asked to upgrade or bump alchemy or effect, when a deploy
  dies inside an alchemy provider with a `TypeError` naming a missing
  combinator, when `check:npm-effect-resolution` fails, or when deciding
  whether the alchemy patch is still needed.
---

# Upgrade alchemy and effect

## Audience

Maintainers changing the `alchemy` or `effect` versions in this repo.

## Read this first

**Check what upstream ships before working around what we pin.** The pinned
version is not a constant, and treating it as one is expensive: TML-3158 was a
long chase through pinning, peer dependencies, and a CLI preflight (since
retired), all to keep
a consumer's tree away from an `effect` that alchemy 2.0.0-beta.59 could not
run — while a newer alchemy that had already fixed it sat on the registry the
whole time. One command would have shown it:

```bash
npm view alchemy dist-tags
npm view alchemy@<latest> peerDependencies
```

If alchemy's `effect` peer range has moved past ours, the upgrade *is* the
fix. Reach for workarounds only after that check says otherwise.

## How the versions are declared

alchemy pins its own `effect`-family dependencies and declares `effect` as a
peer with a semver range (`^4.0.0` at beta.81). The repo follows that range:

- `alchemy` is pinned exactly everywhere. It is a beta and its API moves.
- `effect`, and `@effect/platform-node` (which lowering imports), use
  alchemy's `effect` range. Nothing else in the `@effect/*` family is
  declared: we only list packages we import.
- `@distilled.cloud/prisma`, which the provider wiring imports, stays at the
  exact version alchemy depends on so npm installs one copy.

Before `effect` 4.0.0 shipped, this repo pinned `effect` and every companion
alchemy pulled in (`@effect/vitest`, `@effect/sql-*`, the platform adapters)
exactly. Release-candidate versions do not satisfy caret ranges the way stable
ones do, so that was the only way to keep npm on one `effect`. Do not bring
those pins back unless the npm check below fails without them.

## Two audiences, two failure modes

- **This workspace** uses pnpm, which only *warns* on a peer mismatch and keeps
  our pinned copy. A broken constellation is therefore invisible in-repo — CI
  and local dev stay green while consumers break.
- **Consumers** use npm, which hoists a satisfying version to the root of
  `node_modules`. alchemy imports whatever is at the root. Nothing we declare
  prevents this: an exact `peerDependencies` entry does **not** make npm fail —
  verified empirically, it warns, hoists the other copy anyway, and exits 0.
  Only the consumer's own `overrides` can force alchemy's copy.

That asymmetry is why `scripts/check-npm-effect-resolution.mjs` installs real
tarballs with real npm.

## What a consumer sees when the tree is wrong

Composer has no check of its own for a wrong `effect`. The app's
`prisma.config.ts` imports the extensions' `/control` entries in its `composer`
section, and those import alchemy, so a wrong `effect` fails the moment the
engine evaluates the config file, before any command runs. The error is the
engine's `CLI.CONFIG_UNREADABLE`, naming the file and carrying the module error,
for example `prisma.config.ts could not be evaluated: Schema.TaggedError is not
a function`. Only the consumer's package manager can fix that tree, usually
with an `overrides` entry that forces an `effect` 4.x
(`docs/guides/deploying.md`).

## Steps

1. **Pick the target.** Take alchemy's latest release and read its `effect`
   peer range and its `@distilled.cloud/prisma` version:

   ```bash
   npm view alchemy dist-tags
   npm view alchemy@<version> dependencies peerDependencies
   ```

   Use that `effect` range for `effect` and `@effect/platform-node`. Check the
   new alchemy's `alchemy/Prisma` still loads from a plain npm install: in
   beta.79 it imported the optional peer `@alchemy.run/frontend-frameworks`
   and failed.

2. **Find every pin.** They are spread across public packages, framework
   packages, examples, `test/integration`, and `website`:

   ```bash
   grep -rln '"alchemy"\|@effect/\|"effect"' --include=package.json . | grep -v node_modules
   ```

3. **Clear the patch key first.** `pnpm.patchedDependencies` is keyed by the
   exact version, so an alchemy bump leaves it pointing at a version that is no
   longer installed and the next install fails or silently skips the patch.
   Remove the entry now and re-create it in step 5 once you know whether it is
   still needed.
4. **Bump all of them**, then `pnpm install`. Nothing may be left behind — a
   single stale `effect` declaration can reintroduce a second `effect`.
5. **Decide the patch** (see below): typecheck without it, and only re-create
   it against the new version if upstream still needs the fix.
6. **`pnpm typecheck`.** Expect real API breakage; see the classes below. Note
   that turbo stops at the first failing package, so run `pnpm exec tsc
   --noEmit` per package to see the true scope.
7. **`pnpm check:npm-effect-resolution`** (after building the two public
   packages). This is the consumer-facing proof.
8. **The E2E deploy jobs are the real bar.** An alchemy upgrade changes the
   deploy engine; a green typecheck says very little about it.

## The npm check

`check-npm-effect-resolution` installs the tarballs bare and fails when the
install backtracks or resolves a second `effect`. It installs once more with
npm 10, the npm that Node 22 bundles. If it ever fails because alchemy pulls in
an `effect`-family package whose newest release needs an `effect` that does not
exist yet (2026-09-11: `@effect/*@4.0.0-rc.114` published ahead of `effect`),
pin that one package exactly in `@prisma/composer`'s `dependencies` and say why.

## Breakage classes seen in practice

- **Removed `effect` combinators.** `Schedule.both`/`Schedule.either`
  (intersection/union) disappeared at beta.97. `Schedule.both(spaced(x),
  during(y))` becomes `Schedule.spaced(x).pipe(Schedule.upTo({ duration: y }))`;
  `Schedule.max`/`Schedule.min` are the general replacements.
- **New required fields on alchemy's resource-handler context** (e.g. `fqn`).
  These surface only in the test fixtures that build the context by hand.
- **`exactOptionalPropertyTypes` vs alchemy's types.** See the patch section.
- **Error counts that go *up* after a fix.** TypeScript stops at the first bad
  argument, so repairing it exposes the next one. Rising counts mid-upgrade are
  normal, not a sign the fix was wrong.

## The alchemy patch

`patches/alchemy@<version>.patch` fixes one upstream type declaration:
`ResourceClassLike.Aliases` is `readonly string[]` (exact-optional) while
`ResourceClass.Aliases` is `readonly string[] | undefined`. Under this repo's
`exactOptionalPropertyTypes`, the second is not assignable to the first, so
**every** `Provider.effect` and `Provider.collection` call fails to compile —
45 errors across three packages at the time of writing. alchemy carries
`@ts-expect-error` at its own equivalent call sites, so this is upstream's
inconsistency, not our misuse.

**Do not work around it at the call sites.** That was tried: it needs a cast at
roughly twenty sites, and narrowing the argument type also destroys inference
for the second argument, which surfaces a fresh wave of errors. Adding
`| undefined` to the optional property fixes all of them at the source.

On every upgrade, check whether upstream has fixed it. With the
`pnpm.patchedDependencies` entry already removed in step 3:

```bash
pnpm install && (cd packages/1-prisma-cloud/0-lowering/lowering && pnpm exec tsc --noEmit)
```

Clean means the patch is obsolete: delete `patches/alchemy@<old>.patch` and
leave the config entry out. Still failing means re-create it against the new
version:

```bash
pnpm patch alchemy@<version>   # edit lib/Resource.d.ts, then patch-commit
```

History: alchemy 2.0.0-beta.67 needed the patch (`lowering` alone reported 17
errors without it); upstream fixed the declaration by 2.0.0-beta.74 and the
patch was deleted with that bump. The check above stays — the inconsistency
could regress in a future release.

## The @alchemy.run/node-utils patch

**Resolved — the patch was deleted with the beta.74 bump**: alchemy no longer
ships a file-lock module at all (`@alchemy.run/node-utils` 2.x exports only
`ignore`), so there is nothing left to patch. The history and the standing
check below stay, because the property it protected still matters.

The patch was
[alchemy-run/node-utils#6](https://github.com/alchemy-run/node-utils/pull/6)
("fix(lockfile): scope exit hooks to owned locks"), vendored against
node-utils 0.0.5. Without it, `lib/lockfile.js` called `exitHook(...)` at module scope, so merely
importing `alchemy` registered a SIGINT, a SIGTERM, and an `exit` listener on
the process. Composer's commands run inside the Prisma CLI engine, and the
engine owns the whole signal policy: the first Ctrl-C aborts the command and
waits for teardown, a second one force-exits. A stray SIGINT listener that
calls `process.exit(130)` on its own pre-empts that, killing the process while
the engine's cleanup is still running. The engine's family test suite asserts
that after a composer command's config evaluation the engine is the sole
SIGINT/SIGTERM listener, and that assertion is what fails if a stray listener
is ever reintroduced.

On every alchemy bump, re-run the standing check (the CLI's signal-listeners
test suite runs the same probe):

```bash
node -e 'const c=()=>process.listenerCount("SIGINT")+process.listenerCount("SIGTERM");const b=c();import("alchemy").then(()=>console.log(c(),"listeners registered by a bare import (must be 0)"))'
```

## Keeping the regression check honest

`scripts/check-npm-effect-resolution.mjs` has three shapes: two healthy
installs and one adversarial tree where alchemy resolves an `effect` outside
our range. Two things about it are easy to get wrong after an upgrade:

- **Do not assert the presence of a specific combinator.** That only ever stood
  in for "alchemy can run on this `effect`", and it breaks the moment upstream
  removes it for good reasons. `importAlchemy` answers the same question
  directly: it imports alchemy's root, `Output`, `Provider` and `Stack` entries
  from the installed app, which must succeed in the healthy shapes and fail in
  the adversarial one.
- **`WRONG_EFFECT` must stay a published version outside our range.** The
  shape sets it with an npm `override`, so it does not depend on what the
  registry publishes.

## Gotchas

- **A clean install before believing a failure.** Switching branches around a
  dependency change leaves stale `node_modules` that produce failures unrelated
  to the diff. `rm -rf node_modules && pnpm install` before diagnosing.
- **Compare against `main` before blaming the upgrade.** Some suites fail only
  under the fully parallel `turbo run test` and pass in isolation, on `main`
  too; and `@internal/streams` reports a large pre-existing typecheck error
  count from a third-party package's own source.
- **`pnpm dedupe` after the pins move**, so stale peer-resolution keys do not
  linger in the lockfile — but commit it separately, since it touches
  resolutions beyond the ones being upgraded.

## What this skill does NOT do

- **Decide when to upgrade.** alchemy is pre-1.0 and moves fast; this is the
  procedure, not a schedule.
- **Upgrade unrelated dependencies.** Keep the constellation bump its own
  change so a deploy regression has one obvious suspect.
- **Publish.** See [`publish-npm-version`](../publish-npm-version/SKILL.md).

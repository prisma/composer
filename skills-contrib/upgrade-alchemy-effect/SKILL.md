---
name: upgrade-alchemy-effect
description: >-
  How to upgrade `alchemy` and the `effect` constellation across this repo and
  keep them consistent for consumers: which packages pin what, why `effect` and
  every `@effect/*` companion move as one set, what breaks in a typical
  upgrade, and how to verify a standalone `npm install` still resolves a single
  `effect`. Use when asked to upgrade or bump alchemy or effect, when a deploy
  dies inside an alchemy provider with a `TypeError` naming a missing
  combinator, when `check:npm-effect-resolution` fails, or when deciding
  whether the alchemy patch is still needed.
---

# Upgrade alchemy and effect

## Audience

Maintainers changing the `alchemy` or `effect` pins in this repo.

## Read this first

**Check what upstream ships before working around what we pin.** The pinned
version is not a constant, and treating it as one is expensive: TML-3158 was a
long chase through pinning, peer dependencies, and a CLI preflight, all to keep
a consumer's tree away from an `effect` that alchemy 2.0.0-beta.59 could not
run — while a newer alchemy that had already fixed it sat on the registry the
whole time. One command would have shown it:

```bash
npm view alchemy dist-tags
npm view alchemy@<latest> peerDependencies
```

If alchemy's `effect` peer range has moved past our pin, the upgrade *is* the
fix. Reach for workarounds only after that check says otherwise.

## Why the versions move as a set

`effect` and its companions — `@effect/platform-node`, `@effect/platform-bun`,
`@effect/platform-node-shared`, `@effect/vitest` — each declare a peer on their
**own exact version**:

```jsonc
// @effect/platform-bun@4.0.0-beta.103
"peerDependencies": { "effect": "^4.0.0-beta.103" }
```

So a companion one beta ahead of `effect` is unsatisfiable, and npm resolves it
by installing a *second* `effect`. Every pin in this repo must name the same
beta. Treat them as one constellation, never as individual bumps.

alchemy sits on top with a deliberately loose range (`>=4.0.0-beta.100 ||
>=4.0.0` at beta.67). That range is what lets a stray dependency drag a
different `effect` in, and it is why the CLI preflight exists.

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
tarballs with real npm, and why the CLI refuses to run when alchemy's resolved
`effect` is not our pin (`check-effect-resolution.ts`).

## Steps

1. **Pick the target.** Read alchemy's latest peer range, then choose the
   newest beta where *every* companion publishes a matching version:
   ```bash
   npm view alchemy dist-tags
   npm view alchemy@<version> peerDependencies
   for p in effect @effect/platform-node @effect/platform-bun \
            @effect/platform-node-shared @effect/vitest; do
     echo "$p $(npm view $p dist-tags.beta)"
   done
   ```
2. **Find every pin.** They are spread across public packages, framework
   packages, examples, `test/integration`, and `website`:
   ```bash
   grep -rln '"alchemy"\|@effect/\|"effect"' --include=package.json . | grep -v node_modules
   ```
3. **Bump all of them to the same versions**, then `pnpm install`. Nothing may
   be left behind — a single stale companion reintroduces the second `effect`.
4. **Revisit the patch** (see below). `patchedDependencies` is keyed by exact
   version, so the old key is now wrong either way.
5. **`pnpm typecheck`.** Expect real API breakage; see the classes below. Note
   that turbo stops at the first failing package, so run `pnpm exec tsc
   --noEmit` per package to see the true scope.
6. **`pnpm check:npm-effect-resolution`** (after building the two public
   packages). This is the consumer-facing proof.
7. **The E2E deploy jobs are the real bar.** An alchemy upgrade changes the
   deploy engine; a green typecheck says very little about it.

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

On every upgrade, check whether upstream has fixed it:

```bash
# with patchedDependencies removed from the root package.json
pnpm install && (cd packages/1-prisma-cloud/0-lowering/lowering && pnpm exec tsc --noEmit)
```

Clean means delete the patch and the `pnpm.patchedDependencies` entry. Still
failing means re-create it against the new version:

```bash
pnpm patch alchemy@<version>   # edit lib/Resource.d.ts, then patch-commit
```

## Keeping the regression check honest

`scripts/check-npm-effect-resolution.mjs` has three shapes: two healthy
installs and one adversarial tree where alchemy resolves an `effect` we did not
pin. Two things about it are easy to get wrong after an upgrade:

- **Do not assert the presence of a specific combinator.** That only ever stood
  in for "alchemy can run on this `effect`", and it breaks the moment upstream
  removes it for good reasons. `assertCliStarts` answers the same question
  directly, because starting the built bin loads alchemy's provider tree.
- **`WRONG_EFFECT` must stay a published version other than the pin.** The
  adversarial shape used to depend on a release whose peer sat *above* our pin;
  that stopped existing once the pin reached the newest beta, and the shape
  quietly stopped being adversarial. It now sets the version with an npm
  `override` instead, so it does not depend on what the registry publishes.

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
- **The CLI preflight reads `@prisma/composer`'s `dependencies.effect` and
  compares with `===`.** That pin must stay an exact version;
  `check:npm-effect-resolution` enforces it.

## What this skill does NOT do

- **Decide when to upgrade.** alchemy is pre-1.0 and moves fast; this is the
  procedure, not a schedule.
- **Upgrade unrelated dependencies.** Keep the constellation bump its own
  change so a deploy regression has one obvious suspect.
- **Publish.** See [`publish-npm-version`](../publish-npm-version/SKILL.md).

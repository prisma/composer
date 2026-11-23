# Plan

**Spec:** [spec.md](spec.md). **Design:** [design.md](design.md).

Three slices, one pull request each. Slice 1 has no outside dependency. Slices 2 and 3 are built now and merged when the platform is ready.

## Slice 1: deploys stop writing the `DATABASE_URL` placeholder, and Composer names itself on every API call

Design sections 4.3 and 4.4. Builds on: nothing. Hands to slice 2: the client view that adds Composer's headers, used by preflight. Merges as soon as it is reviewed.

## Slice 2: preflight asks the platform what the environment receives

Design section 4.1. Builds on: slice 1. Merges when the new read is live in production with the missing-group-id defect fixed. Until then the pull request is a draft.

Before merge: check again whether `prisma variable` has shipped (if it has, the custom-group hint becomes its command), and run manual QA once more against the platform's real read.

Note for any later read by `serviceId`: for a key set both as a branch override and as a service variable, the platform's read reports the override (it layers overrides last), while its deployment gives the service the service variable (it layers service variables last). A trigger built from that read would miss a change to the service variable. Raise it with the platform team before relying on that read.

## Slice 3: a service's `COMPOSER_` keys travel with its deployment

Design section 4.2. Builds on: the open pull request "an unchanged deploy no longer replaces a service that depends on another service", merged. Independent of slice 2. Opened early as a draft, with `pnpm` patches standing in for the upstream packages, for Ty to align his interface against. Needs one pull request on Distilled and one on Alchemy once the platform's field is final. Merges when the platform accepts `variables` in production and both upstream packages have released.

## Release

0.40.0 after slices 1 and 2, with slice 3 if it is ready.

## Close-out

- [ ] Check every "Done when" condition in the spec.
- [ ] Delete `.drive/projects/variable-groups-compat/`; each slice has already landed its docs.

## What each pull request description must tell Ty

Will, 2026-11-20: the response to Ty is sent and is not edited again. What changed since goes in the pull request descriptions, where Ty reads it.

- **Slice 2 (preflight):** the defect on his branch that blocks it. A variable written without a `groupId`, which is what `prisma project env add --role preview` does, is stored with no group. A deployment receives it, but resolved-variables does not list it (`resolved-variables.ts` filters on `groupId` only; `setConfigVariable.ts` stores `input.groupId ?? null`). Preflight would report it missing.
- **Slice 3 (service variables):** the interface we built against, for him to align; that "keys not sent keep their value" is what we want, and we do not want a way to replace a service's full set, because it would delete values a user set in Console; that we rely on `null` for a key that is not stored being accepted and doing nothing; and the two minimum versions: 0.40.0 for custom groups, and the release with this change for the day branch override writes stop, unless this change is ready in time for 0.40.0.

# Slice 3: a service's `COMPOSER_` keys travel with its deployment

Design: [design.md](../design.md) section 4.2, with the tests in section 9 and in the principal engineer's design review. One pull request, opened as a draft for the platform team to align the create-deployment field against.

This branch starts from `main` with the open pull request "an unchanged deploy no longer replaces a service that depends on another service" merged in. When that pull request merges, the branch is rebased onto `main`.

## Dispatches, in order

1. **The upstream prop, as local patches.** `pnpm` patches for `@alchemy.run/prisma` (the `variables` prop on `Prisma.Deployment`: sent on create, hashed for `diff`, replaces when changed, unresolved or first declared, never sent on update) and `@distilled.cloud/prisma` (the field on the create-deployment request). The same change is prepared as source diffs against the upstream clones, for the two upstream pull requests later.
2. **The hosted deploy.** `serialize` returns the map; every key boot reads is a value or `null`; the per-service record of key names and the `null`s it produces; the limit of 50; `deploy` passes `variables`; triggers keep only platform variable members; `appAfter` keeps the producer wait; the key-clash check is deleted; the hosted variable provider stays registered. Tests with the real engine, including the upgrade from state written by today's code.
3. **`prisma dev`.** The local deployment provider takes the service's keys from `variables`; `reserve` keeps rows for dev servers, never writes a `null`, and fails outside the local application.
4. **Docs.** The new decision record and every record, guide and glossary entry the design's section 8 lists for 4.2.

## Not in this slice

The upstream pull requests themselves, which wait for the platform's field to be final.

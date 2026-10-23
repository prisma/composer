# System design review — A1, fully qualified node identity (round 2)

Range: `origin/main...HEAD` on `a1-full-platform-names` (pushed as `drive/fully-qualified-node-addresses`), 33 commits, 109 files.

Read for this review: the repo `CLAUDE.md`; `docs/design/01-principles/`; the ADR index; ADR-0057 in full; ADR-0051, and the amendment notes on ADR-0006, ADR-0019, ADR-0048, ADR-0052 and ADR-0053; ADR-0056 (merged from main); the glossary entry "Address and logical ID"; the changed parts of `core-model.md`, `deploy-cli.md`, `config-params.md`, `local-dev.md`, `alchemy-lowering.md` and `pdp-data-model.md`; the project `spec.md`, `design-notes.md` and `handover.md`; the spike findings; the slice `spec.md`, `plan.md` and `upgrade-effects.md`; the round-1 reviews.

## Verdict

The design is now coherent. Round 1's main concern, that the address without the app name survived in two helpers and in four platform labels, is gone: one helper (`addressBelowApp`) remains, used only to build the IDs the previous release wrote, and every platform name is the full address. The local record's old-versus-new decision is a version marker, not a guess. The merge with main and the renumber to ADR-0057 are clean: the index keeps main's ADR-0056 and lists ADR-0057 once, and no reference to the identity record as ADR-0056 remains outside the plan's own history.

One design gap remains. ADR-0057 argues that env keys cannot collide, which is true for one format, but the move between the two formats can make a new key equal an old key of another node. The ADR records this as a consequence, but the remedy it gives contradicts its own consequence about renames (S01).

## What changes, and the invariants it relies on

1. Every address starts with the deployed app name; the name matches `[A-Za-z0-9][A-Za-z0-9_-]*` (`core/src/graph.ts`), and below the root, segments are letters and digits.
2. A node's main resource ID is its address; other pieces are `<address>.<role>[.<which one>]` (`target/src/resource-ids.ts`). Roles are nouns.
3. No resource ID is a node address, because modules have no resources and services and resources have no children.
4. Every resource declares the ID the previous release built (`target/src/legacy-resource-ids.ts`), computed by removing the known `<app>.` prefix.
5. Every platform name is the address, checked against that kind's limit, never shortened.
6. Local dev: the record key, the main resource ID and the address are one string; both the emulators hook and the local providers go through `resourceId`.

Invariant 6 was the round-1 cross-package concern (S05). Both sides now call the same function, so it holds by construction.

## Subsystem fit and boundaries

- Core changed only in how Load builds an address and in refusing a bad app name. Resource IDs, names, env keys and the migration live in the Prisma Cloud target and `local-target`. Dependency direction is unchanged.
- The compatibility code is isolated in two files whose headers say when to delete them (`legacy-resource-ids.ts`, `legacy-address-keys.ts`). Good.
- `ProvisionEdge` gains `app` so provisioners can build former IDs. It is the root's ID, already on the graph; passing it is the least change.
- The env key segment function is duplicated in `local-target/src/compute.ts` for the existing layering reason. Acceptable.

## Naming and typology

| Name | Assessment |
| --- | --- |
| `resourceId(address, ...role)` | Says what it builds. |
| `addressBelowApp(address, app)` | Says exactly what it returns, and throws for an address outside the app. Replaces round 1's `resourceLabel`/`legacyAddress` pair. |
| `legacyNodeResourceId`, `legacyEnvVarId`, `legacy*Key` | Accurate and removable. |
| `fromLegacyId` | An alias of `renamedFrom`; one search target for removal. Keep. |
| `validatePlatformName(kind, address)` | Names the concept (a platform name) and the kind; replaces `validateName`, which checked one limit for every kind. |
| `EMULATOR_INSTANCES_FORMAT_VERSION` | Accurate. |
| Roles `deployment`, `env`, `generated`, `servicekey`, `streamkey`, `connection`, `warmup`, `migration`, `accesskey` | All nouns; round 1's `conn` and `key` are gone. |

## ADR-0057 against the code

Accurate: the address rule and app-name grammar; the resource-ID table, which matches the code and the tests; the env key rule; the platform-name rule, including the 13-character Connection suffix and why the limit is 52; that App, Database and Bucket names update in place and Connections and access keys are replaced; that replacement deletes only the stored object; the `serviceOrigin` and `--name` cost; what a failing `serviceOrigin` has already changed; local dev's version marker.

Inaccurate or incomplete:

- Line 136, the env key clash (S01).
- Line 119 and `upgrade-effects.md` do not say that an in-place Database update can rotate the database's default connection when the state holds no connection secrets. That connection is outside the graph. See code-review F03.

Doc consistency: the principle, glossary, `deploy-cli.md`, `config-params.md`, `pdp-data-model.md`, `local-dev.md`, `alchemy-lowering.md` and the index agree with the ADR. `core-model.md` has one stale sketch comment (code-review F04).

## Test strategy at the architectural level

- Literal former IDs per node kind are the right evidence for a compatibility rule, and they exist.
- Limits per kind are tested at, and one over, each boundary.
- Nothing automated can prove the former IDs equal real v0.34.0 state; only QA can. The QA plan must also cover what the spike did not: App, Bucket and access key name changes, planted out-of-graph state, and the default connection (code-review F02).
- No test covers the env key clash. With S01's detection, one unit test over a graph with a module named like the app would.

## Findings

**S01 — The format change can make keys collide, and the recorded remedy re-identifies a node**
- Location: ADR-0057 lines 88 and 136; `upgrade-effects.md` line 37.
- Issue: Line 88 says the `-` to `_` replacement cannot make two keys collide. Within one format that holds. Across the two formats it does not: a new key of one node can equal an old key of another while the old row still exists. That happens when a module or service directly below the root has the app's name in any letter case, or when modules spell an app name containing `-` or `_`. Line 136 records only the module case, and its remedy, renaming a node, gives that node a new identity, which by line 127 deletes its rows and, for a database or bucket, its data.
- Suggestion: Say in line 88 that the guarantee is for one format, and that the move between formats is handled separately. In line 136, state the full condition, have the deploy detect it before applying (see code-review F01 for how), and give a remedy that changes no identity: delete the superseded `COMPOSER_` variable, then deploy again.

**S02 (low) — The glossary says a Connection's name is the address, but on the platform it is the address plus a suffix**
- Location: glossary "Address and logical ID".
- Issue: Upstream appends `-` and a 12-character token to every Connection name. ADR-0057 and `alchemy-lowering.md` say so; the glossary does not, so a reader looking for a Connection named `shop.catalog` in Console will not find one.
- Suggestion: Add one clause: a Connection's platform name is the address followed by upstream's suffix.

## Out of scope for this pass

Implementation correctness, failure modes and AC verification are in `code-review.md`.

---

# Round 3

Read: the diffs of `b6a2b273`, `82afb495` and `0c8e807e`; ADR-0057 lines 88, 123 and 138; the glossary entry; `upgrade-effects.md`; the upgrade guide.

- **S01 (the env key clash): fixed.**
  - Line 88 now limits the no-collision claim to one format.
  - The new paragraph states every form of the clash, and the check matches it.
  - The consequence no longer tells the user to rename a node, and says why renaming is wrong.
  - The check consults the platform, so a new stage or a stage that has moved never fails. That deviates from the round-2 suggestion; the coordinator accepted it, and it is correct.
  - `env-key-clash.ts` is a compatibility file with a deletion note, next to `legacy-resource-ids.ts`. That is the right place.
- **S02 (the Connection name suffix): fixed** in the glossary.
- **New, low:** the clash paragraph (line 123) and consequence (line 138) say the deploy fails "before changing anything". At that point the topology is already replaced, which the `serviceOrigin` paragraph states correctly. Use the same wording in both places (code-review R3-F01).

Verdict for this pass: the design is coherent; one wording fix remains.

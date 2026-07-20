# S1 — ADR-0034 + documentation corrections

Docs-only slice. Records the settled decision so S2's code is
principle-compliant when it lands. The content source is
[design-notes.md](../../design-notes.md) — the ADR is a transcription into the
repo's ADR voice, not a re-derivation; where design-notes and this spec are
silent, the repo's existing ADR conventions decide, nothing else.

## At a glance

One PR touching only `docs/`:

1. **New `docs/design/90-decisions/ADR-0034-deploy-state-lives-in-the-stage-branch.md`.**
   Sections and required content:
   - **Decision** — the containment rule (design-notes § The decision), naming:
     per-stage database `prisma-composer-state` attached to the stage's
     Branch; production on the implicit default Branch; workspace store
     retired.
   - **Rationale** — the supersession case verbatim in substance
     (design-notes § Why the inputs changed): circularity dissolved by
     ADR-0023/0024, fragmentation moved to the platform, two new forces
     (teardown correctness, credential scoping). Must state explicitly this
     supersedes ADR-0009 because its inputs changed, not because its reasoning
     was wrong.
   - **The ordering rules** — CLI deletes state last-among-members and
     before the container; platform teardown deletes it like any child, and
     the severed lock is a kill switch (design-notes § Destroy ordering,
     § teardown matrix).
   - **The teardown-path matrix** (design-notes § Teardown-path matrix),
     including the documented limitation: platform-side teardown covers
     platform resources only.
   - **Consequences** — per-stage DB cost (OQ-1 noted), state DB visible in
     Console per stage (platform ask: protected flag), manual cutover for the
     legacy store, ADR-0010/0011/0012 survive.
2. **ADR-0009** — status line → superseded by ADR-0034 (repo's existing
   supersession convention).
3. **ADR-0010** — consequence note: lock now lives in the per-stage database;
   `(stack, stage)` key retained though redundant; state-DB deletion severs
   the lease (kill-switch property).
4. **ADR-0024** — correction note: "lives at the Project level" describes
   Composer's addressing (no Branch ensured or named); physically the platform
   attaches default-stage resources to the Project's implicit default Branch
   (post-#3902 invariant, confirmed with PDP 2026-07-17).
5. **`docs/design/90-decisions/README.md`** — index entry for ADR-0034.
6. **`docs/guides/deploying.md`** — upgrade note with the 4-step manual
   cutover (design-notes § Legacy workspace store).
7. **`docs/design/10-domains/deploy-cli.md`** — state section updated: where
   state lives, destroy-tail ordering.

## Coherence rationale

One reviewer, one sitting: a single new ADR plus five surgical edits, all
tracing to one design record. Rollback is one revert.

## Scope

**In:** the seven document changes above. **Deliberately out:** any code;
platform-ask.md additions beyond the protected-DB flag mention if the file
convention requires an entry (implementer checks `platform-ask.md`'s existing
format and adds the protected-flag + reserved-name asks there if that is where
asks live).

## Slice-specific done conditions

- ADR-0034 contains the ordering rules and teardown matrix (S2's tests cite
  them).
- No document still describes the workspace store as current except ADR-0009
  itself, which is marked superseded.

## Dispatch plan

Single dispatch (designer agent per repo convention, model per operator's
global rule for implementer/reviewer subagents does not apply to the designer
persona — use the designer agent as configured):

1. **D1 — author the seven document changes.** Outcome: the PR-ready docs
   diff. Builds on: design-notes.md (read-only source). Hands to: PR open.
   Completed when: all seven items exist, `git grep -l "prisma-composer-state"
   docs/` shows no doc presenting the workspace store as current outside
   ADR-0009, and the ADR index lists 0033.

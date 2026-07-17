# Learnings — SPI inversion & deployment results

Working ledger. Reviewed with the operator at close-out; cross-cutting
lessons migrate to durable docs, project-local ones drop with this folder.

## A cast in the code you are specifying against is evidence that someone
## made a claim — NOT evidence that the claim was true

**The pattern.** Across S1's three dispatches the implementer pushed back on
pinned spec text three times, and was right all three times:

1. `ComputeProvisioned.serviceId: string` — actually `Output<string>`. I read
   the existing `provisioned.outputs['serviceId'] as string` as evidence of
   the real type.
2. `computeDescriptor`'s return type `NodeDescriptor` — contradicted the
   spec's own "compose-over-base stays", because the erased type would have
   forced s3-store to cast `P`/`S` back in.
3. My pinned `isCloudApplication` body — contained a bare `as`, which would
   have *relocated* a cast in a cast-removal slice. `'projectId' in value`
   narrows without one.

**The common root, in the reviewer's words:** each pushback surfaced
something the spec got wrong by reading an existing cast as evidence of a
real type, when the cast was what made the wrong type compile.

**Why it bit here specifically.** This project's whole subject is a seam
where casts hid type lies. So the code I was specifying *against* was
maximally untrustworthy as a source of type facts — the casts were the
disease, and I used them as the diagnosis.

**How to apply it to S2 and S3.** When pinning a type, derive it from the
producing expression's real type (compile a probe), never from an adjacent
cast or a declared prop type that accepts a union. This is already why S3's
spec was pre-emptively amended: `DeployedPrimitive.id: string` had the
identical defect, caught by applying this lesson rather than by paying a
second halt.

**Candidate for migration:** this generalizes past this project. Any
refactor that removes casts is specified against code whose casts are lying.
Worth a line in the repo's cast rules (`.agents/rules/no-bare-casts.mdc`) at
close-out — the rule currently governs *writing* casts, not *reading* them.

## Halts earn their cost when the spec claims to be zero-freedom

The "zero creative freedom" framing put all the risk on the spec being
right. That only worked because the halt conditions were explicit and the
implementer used them instead of improvising. The `serviceId` halt cost one
round-trip and prevented a laundered type; it also taught me the class of
bug, which I then found pre-emptively in S3's spec. A dispatch that had
"just made it compile" would have buried both.

**Corollary:** zero-freedom specs need *more* halt discipline, not less. The
freedom removed from implementation has to reappear as permission to stop.

## Verification beats relay — twice, in both directions

- The reviewer refuted the implementer's ergonomics claim with a compiled
  probe (D1). Had I relayed it unchecked, D2 would have hand-annotated five
  descriptors for no reason.
- The implementer re-derived every alchemy citation against installed source
  rather than copying `design-notes.md`, and most had drifted (D3). The
  reviewer then independently re-verified all eight.

Both times the cheap move was to trust the upstream artifact. Neither agent
took it. **`design-notes.md` is now known to be a lossy source for line
numbers** — it carries a correction header pointing at ADR-0033 as the
authority.

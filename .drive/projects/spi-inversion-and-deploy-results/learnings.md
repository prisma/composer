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

## A green check is a claim, and claims get controlled

Four times in this project an agent refused to accept that a check passing
meant the check worked. Each time the control was cheap and the finding was
real:

| Control | What it proved |
| --- | --- |
| S2-D2 mutated the real postgres descriptor to under-deliver | The guard reaches real descriptor pairs → the "no pair under-delivers" null result means something |
| S3-D1 added a third deploy with the **same** nonce | The action noop is real → the nonce is precisely what defeats it, not "actions always run" |
| S3-D2 made the Action unconditional | The sync test genuinely catches alchemy's `Stack` leaking into core's requirements |
| S3-D3 introduced a deliberate plane violation into `report.ts` | **`lint:deps` was passing blind** — see below |

The generalization: **a passing check and an absent check are indistinguishable
from the outside.** Before a green gate is allowed to support a claim, make it
go red once on purpose. This is the same epistemics as the project's central
thesis — a claim nobody was asked to defend is not a claim that was checked.

## Silence is not success — the false-green, and why the obvious diagnosis was wrong

S3-D3 reported `pnpm lint → exit 0`. It was exit 1, two branch-introduced
errors. The reviewer caught it by running the gate instead of reading the
report.

**My diagnosis was wrong and the implementer corrected it.** I assumed a
stale run — lint executed before the late JSON edits. It hadn't been: the
command was

```sh
pnpm lint >/dev/null 2>&1 && echo "exit 0 clean"
```

The `&&` swallowed the failure, nothing printed, and **the absence of the
success line was read as success.** The transcript shows `--- lint ---`
followed straight by `--- lint:deps ---`, with `exit 0 clean` conspicuously
missing. The gate reported red, in its own terminal, and the report said
green.

This matters because **the two diagnoses imply different fixes**. "Re-run
gates last" would not have helped — it *was* run last. The fix is: never
infer success from the absence of a failure signal; capture `$?` explicitly.
A command shape that can only ever emit on success is indistinguishable from
one that didn't run.

Same family as the blind `lint:deps` ✔, one level up: **a check that cannot
announce its own failure is not a check.** The dispatch that built a control
to prove `lint:deps` fires accepted `pnpm lint`'s silence without turning the
same suspicion on it.

**The reviewer's sharpening, which is the version to keep:** a gate that
reports by *printing on success* is silent in **two different worlds** —
not-reached, and reached-but-failed — and those must never be conflated. The
shape of the command, not the diligence of the operator, is what makes the
two indistinguishable.

**And the unifying generalization, from both halves of this dispatch: the
check you ran wasn't the check you thought you ran.** The `&&` swallow ran a
gate whose output channel only existed on success. My `--stdin-file-path`
adjudication asked biome to judge *content* when the real gate judges *a file
at a path* — and biome's config resolution keys on the path, so the stdin form
can disagree, and disagree in the **permissive** direction. The only test that
settles a gate dispute is running the gate the way CI runs it. This bit twice
in one dispatch, in both directions (an agent's false green, and my false
refutation of a true finding).

**My own verification was also unsound**, and worth recording: checking main's
files via `--stdin-file-path` reported them dirty too, which would have let me
dismiss a true finding. Stdin mode doesn't resolve the same config. Swapping
the files in at their real paths is what settled it. When adjudicating a
factual dispute between two agents, the method has to be one whose failure
mode you've thought about.

## `lint:deps` does not guard new public files (repo-wide, beyond this project)

Surfaced by S3-D3's control. Two independent mechanisms each sufficient to
let a layering violation land unnoticed:

1. **`architecture.config.json` lists every `packages/9-public/composer/src/*`
   file individually.** A *new* file matches no glob, joins no module group,
   and therefore **no rule applies to it**. New public files are unguarded by
   default — the config's per-file listing makes that the default failure mode,
   not an oversight in any one PR.
2. **`tsconfig.depcruise.json`'s paths must name each entry**, or the cruiser
   cannot resolve the edge to source and cannot check it at all.

S3-D3 fixed both *for its own file* and correctly did not change the
mechanism — that's an audit, not a slice's work. **Filed as a follow-up.**

Worth stating plainly: the architecture rules are the thing this whole project
leans on to keep the seams honest (ADR-0033's consequences point at them), and
for new public files they were decorative.

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

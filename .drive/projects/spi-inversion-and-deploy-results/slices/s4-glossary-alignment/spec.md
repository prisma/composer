# S4 — Align the new names with the repo's ubiquitous language

## At a glance

Post-review rework on PR #117, operator-directed (2026-07-17). The branch
coined names for concepts the repo's glossary already covers. This slice
renames them to the established vocabulary and records the one genuinely
new noun ("Deployment entity") in the docs. **Pure rename + wording — zero
behaviour change.** Every gate that is green before this slice must be
green after, with identical counts.

Grounding (operator-ratified):

- The glossary (`docs/design/03-domain-model/glossary.md`) names what a
  node provides to its dependents **Outputs** (:136, :365-370). "Wiring" was
  a coinage.
- The check S2 added enforces the **connection** contract (glossary
  :121-127; the domain doc is literally `connection-contracts.md`).
  "Wiring contract" was a second name for it.
- The planes are authoring / provisioning / hosting (`layering.md:16-29`).
  Naked "primitive" carries no meaning without a plane qualifier
  (ADR-0014 "authoring primitive" vs layering.md "hosting primitives"), and
  "Deployed" is not a plane — so `DeployedPrimitive` said nothing. The
  operator's chosen noun for a thing on the deployment target:
  **Deployment entity**.
- `DeploymentResult` is legitimate **only** as the result of the Deploy
  operation. Today it names a per-node record; the actual operation result
  is an unnamed array. Fixed by promoting it.

## The rename set (complete — nothing else changes name)

| Current | New | Notes |
| --- | --- | --- |
| `WiringOutputs` | `Outputs` | Verified collision-free in core + public. Doc comment: "The values a node provides to its dependents — what a consumer's declared connection params resolve against. Name-keyed and unknown-valued of necessity…" (keep the existing rationale text, minus the word "wiring"). |
| `LoweredResult.wiring` | `LoweredResult.outputs` | Type `Outputs`. |
| `LoweredResult.primitives` | `LoweredResult.entities` | Type `readonly Input<DeployedEntity>[]`. |
| `DeployedPrimitive` | `DeployedEntity` | Same shape: `kind`, `id`, `url?`, `details?`. `kind` string values (`'compute-service'`, `'postgres-database'`) are hosting-plane nouns and DO NOT change. |
| `ReportedPrimitive` | **deleted** | Two use sites become `Input<DeployedEntity>` written literally — Alchemy's own idiom for "this shape, fields possibly unresolved". No replacement alias. |
| `DeploymentResult` (per-node) | `DeployedNode` | `{ address, node, entities }` (field `primitives` → `entities`). |
| — (new) | `DeploymentResult` | **The result of the Deploy operation**: `{ readonly app: string; readonly nodes: readonly DeployedNode[] }`. Core's Action runner constructs it with `app = opts.name`. |
| `LowerOptions.report` | signature change | `(result: DeploymentResult) => void`. |
| `joinDeployment(graph, entries)` | returns `readonly DeployedNode[]` | Same join semantics (skip unknown addresses). The runner wraps it into `DeploymentResult`. Keep it pure and exported. |
| `renderDeployment(appName, results)` | `renderDeployment(result: DeploymentResult)` | App name now rides in the result. |
| `deploymentReport(appName)` factory | `deploymentReport(result: DeploymentResult): void` | No longer a factory — it IS the callback. Generated stack template passes `report: deploymentReport` (no call, no name argument). `generate-stack.ts` template + snapshot tests update; the name option the template previously threaded to the factory is no longer emitted there. |
| Action input `entries[].primitives` | `entries[].entities` | Nonce mechanics unchanged. Action name `composer-deployment-report` unchanged. |

## Wording sweeps (exact)

**S2 error text** (`deploy.ts`, `buildConfig`) — new pinned message:

```
Connection input "auth.main" declares param "url", but its producer "data"
did not supply it — the producer's outputs carry [nothing]. Add "url" to
the outputs the producer returns from its lowering, or declare the param
optional on the connection.
```

(Substitute the real interpolations; "[nothing]" fallback behaviour
unchanged.) The S2 tests asserting message fragments update to match.

**Renderer empty case**: `(no primitives reported)` → `(no entities reported)`.
Renderer tests update; tree format otherwise byte-identical.

**Guides + skill** (`docs/guides/deploying.md`, `skills/prisma-composer/SKILL.md`):
"wiring contract" → "connection contract"; "wiring outputs" → "outputs";
the deploying.md section currently titled around a "wiring gap" retitles to
name the actual event, e.g. "When a deploy stops on a missing connection
value"; SKILL.md heading "The wiring contract is checked at deploy" →
"The connection contract is checked at deploy". Quoted error text in both
updates to the new message. "primitive(s)" referring to our report types →
"entities". Guide and skill must not disagree; skill rules
(`skills/README.md`) still bind — re-verify the quoted error text is a true
prefix of the live template after the reword.

**ADR-0033** (`ADR-0033-lowering-types-are-defined-by-their-readers.md`):
sweep coined-noun "wiring" → Outputs/connection vocabulary; our-type
"primitive(s)" → "entities"/type names. **Keep** "hosting primitives" where
it cites layering.md's own vocabulary. Substance, taxonomy, citations
untouched.

**Docs record the new noun** — one addition, pinned: in
`docs/design/03-domain-model/layering.md`, hosting-plane bullet (:26-29),
append: *"The framework's deploy report calls a thing on this plane a
**Deployment entity** (`DeployedEntity`): its kind, platform id, and — only
when the target says it is publicly reachable — its URL."* Mirror one line
in the glossary's Planes section if it reads naturally; skip if forced.

**Code comments/tests** added by this branch that say "wiring" or use
"primitive" for our types: sweep on branch-added lines only. Pre-existing
files' vocabulary (e.g. `core-model.md`'s broader text, `testing.md`) stays
— except `core-model.md` lines this branch already edited, which follow the
rename (and note: the half-migrated `deploy` signature there — reads
`WiringOutputs`, code returns `LoweredResult` — gets fixed to the RENAMED
truth in the same pass; that closes the review's B5 defect).

## Out of scope

Behaviour of any kind. The review's F01 (report runner try/catch) — separate
decision, not bundled into a rename. The `.drive/` transient docs and the
`reviews/pr-117/` artifacts (snapshots of a round; they keep the old names).
The PR body (orchestrator owns it).

## Completed when

- `git grep -in "wiring" -- packages/ docs/guides/ skills/` shows no
  coined-noun uses on branch-added lines (plain verb "wire up" in
  pre-existing text is fine).
- `git grep -n "Primitive" -- packages/` returns nothing.
- Full suite green with **identical counts** (typecheck 58, test 48, lint 0,
  lint:deps clean, lint:casts ≤ 30) — a rename that changes a count changed
  behaviour. `pnpm lint` last, exit code read.

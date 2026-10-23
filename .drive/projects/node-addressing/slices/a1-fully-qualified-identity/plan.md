# A1 — dispatch plan

Spec: [spec.md](spec.md). Dispatches run in order on branch `drive/fully-qualified-node-addresses`. Commits stay on the branch; the PR opens after review and QA.

### D1. Design records describe the new identity

- **Outcome:** a new decision record replaces the node-identity decision, and the principle, glossary and the four domain docs listed in the spec describe fully qualified addresses, dotted resource IDs, the env key rule and the automatic migration. The ADR index marks the old record replaced.
- **Builds on:** design notes and spike findings.
- **Hands to:** the written contract the code dispatches implement. Docs-only; `pnpm lint` for markdown, if any, passes.

### D2. Addresses are fully qualified everywhere they are read or written

- **Outcome:** Load gives every node its full address, using the deployed app name for the root on both the CLI pipeline graph and the deploy lowering. `logicalIdProp` and the topology builder write full addresses. `COMPOSER_` keys are built from the full address with `-` replaced by `_`, in the serializer and its local-dev copies. `serviceOrigin`, `dev url`, reports, log labels and errors use the full address. Unit tests are updated to the new form.
- **Builds on:** D1.
- **Hands to:** a graph whose addresses are fully qualified. Resource IDs are still built by the old string pattern on top of the new address, so they are temporarily wrong; D3 fixes them. Typecheck and unit tests pass.

### D3. Resource IDs are dotted, and every resource renames from its current ID

- **Outcome:** every Alchemy resource Composer declares has ID `<address>` (main resource) or `<address>.<role>`, and carries `renamedFrom(<the ID today's release builds>)`. Generated values, service keys and stream keys are renamed, not recreated. Connections keep their current `name` prop. Unit tests assert both the new IDs and the declared old IDs for every node kind.
- **Builds on:** D2.
- **Hands to:** a deploy that migrates an existing stage in place. Typecheck and unit tests pass.

### D4. Local dev keeps its instances and data across the upgrade

- **Outcome:** on the first `prisma dev` after upgrading, `emulator-instances.json` keys are rewritten to full addresses, and bucket data directories and local database lookups follow, so existing local instances, ports and data are reused. A test starts from a record written in today's format.
- **Builds on:** D2 and D3.
- **Hands to:** local dev that survives the upgrade. Tests pass.

### D5. Examples, guides, skill and READMEs use full addresses

- **Outcome:** every user-facing example of an address (`serviceOrigin(...)`, `dev url ...`, reports) in examples, guides, the agent skill and package READMEs uses the full form, and the examples' own tests pass.
- **Builds on:** D2.
- **Hands to:** a branch ready for review.

### Review

`/drive-code-review` on the branch (no walkthrough); fix findings in follow-up dispatches.

### D6. QA on the real platform

- **Outcome:** the slice's done conditions are checked with evidence on a fabricated app: deploy with the current published release, write rows, objects, and record the generated secret and RPC key; redeploy from this branch; confirm everything is unchanged and the state and rows use the new form; deploy the same app to a new stage from scratch; run `prisma dev` on a directory last used with the current release and confirm local data survived. Every test Project is deleted afterwards.
- **Builds on:** review fixes.
- **Hands to:** evidence for the PR description.

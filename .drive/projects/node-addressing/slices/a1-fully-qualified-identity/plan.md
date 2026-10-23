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

### D7. Merge main and renumber the identity decision

- **Outcome:** `origin/main` (v0.34.0 and the dev-server decision record numbered 0056) is merged in. The branch's identity decision record becomes ADR-0057, and every reference to it on the branch says 0057; main's ADR-0056 keeps its number and meaning. The three conflicting docs (ADR-0053, the ADR index, `docs/guides/deploying.md`) keep both sides' content.
- **Builds on:** the review fixes.
- **Hands to:** a branch current with main.
- **Gate:** `pnpm typecheck`, `pnpm lint`; no reference to the identity record as ADR-0056 remains.

### D8. Every platform name is the full address

- **Outcome:** the App `displayName`, the local Database `name`, and the Connection, Bucket and bucket access key `name` are the full address. `addressBelowApp` survives only for building legacy resource IDs. Name validation checks each kind against the platform's real limit (Connection 65, Bucket 100, App 256, access key none) and names the address on failure. ADR-0057, the glossary, the principle and `alchemy-lowering.md` say every platform name is the address, and that the upgrade recreates Connections and access keys with new credentials. Unit tests assert the full names.
- **Builds on:** D7.
- **Hands to:** a deploy that writes one form of name everywhere.
- **Gate:** `pnpm typecheck`; tests for core, cli, lowering, local-target, target; `test/integration`.

### D9. Review round 2 fixes

- **Outcome:** the findings in `reviews/code-review.md` and `reviews/system-design-review.md` are fixed. The env key clash is caught before anything changes, by a preflight check that computes every new `COMPOSER_` key from the graph and fails naming both node addresses and the variable. The documented fix loses nothing: delete that one old `COMPOSER_` variable, then deploy again. The ADR no longer says to rename a node, and no longer says keys cannot collide during the move. `upgrade-effects.md` states when a Database update can rotate its default connection.
- **Builds on:** D8.
- **Gate:** typecheck, lint, tests for core, cli, lowering, local-target, target.

### D6. QA on the real platform

QA starts from scratch with a new test Project. The Project from the earlier attempt, `qa-a1-qsgn6n`, is deleted. Before the upgrade deploy, QA plants state the Composer graph doesn't represent, and checks after the upgrade that each item is unchanged:
- a custom domain on a service;
- an environment variable set by hand;
- a Connection made by hand on the database, which must still connect afterwards;
- a bucket access key made by hand, which must still read objects afterwards;
- the database's default connection.

QA also checks what the spike didn't: that the App, Bucket and access key name changes apply, that each service's endpoint domain is unchanged, and that the names are dotted.

- **Outcome:** the slice's done conditions are checked with evidence on a fabricated app: deploy with the current published release, write rows, objects, and record the generated secret and RPC key; redeploy from this branch; confirm data, objects, the generated secret and RPC key are unchanged, that the Connection and access key were recreated under full-address names and the services work with their new credentials, and that the state and rows use the new form; deploy the same app to a new stage from scratch; run `prisma dev` on a directory last used with the current release and confirm local data survived. Every test Project is deleted afterwards.
- **Builds on:** review fixes.
- **Hands to:** evidence for the PR description.

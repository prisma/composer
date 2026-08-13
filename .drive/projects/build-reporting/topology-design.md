# Settled design: the platform holds the topology

Outcome of the design discussion between Will and the orchestrator, 2026-08-13, on top of Will's "Platform resource model" proposal (claude.ai artifact `81dcbfff`, pasted into the session). Will writes the platform implementation. This records what was decided, why, what was rejected, and what falls out on the Composer side.

## The two models, and the line between them

**Build Job is a run journal.** Workspace-scoped because a first deploy can create the project it targets, purely informative, written by every run (CI, laptop, Console — a `source` field is the only difference). Build Resources are the receipt: id-keyed links to what the run touched and the immutable Versions it produced. The record names its reporter and is as trustworthy as its reporter. Jobs are audit records that outlive what they link to.

**The topology is the application's declared shape**, held platform-side as first-class records under the Branch, beside the operation state store. It is not Build's child; a run journal records events, the topology records structure.

## The persisted topology

Full fidelity — everything in Composer's graph persists, including module structure and boundary-port forwarding. The domain map's uniform rule ("one port mechanic, uniform at every level") makes the schema three record types with no special case for forwarding:

```
Node { branch, address, kind: module|service|resource, type: extension vocab ('compute','postgres','s3','prisma-next',…) }
Port { branch, address, direction: in|out, name, contract? (kind + hash, opaque to the platform) }
Edge { branch, from (address, port), to (address, port), family: communication|data, style? }
```

- Containment lives in the hierarchical address (`storefront.auth.api`); no parent column.
- Module forwarding is ordinary edges touching boundary ports: input flowing down = boundary input port → child slot; output up = child port → boundary output port; pass-through = a module's own input port → its own output port.
- The **flattened view is derived at read time** (transitive closure through boundary ports), never stored. Storing flat and reconstructing authored is lossy when a module exposes one inner port under two names; the authored form is the information.
- **No platform ids in the payload.** The config address is the identity (Will's cross-branch identity rule), so the platform joins a Node to its typed row on `(branch, kind, key)` at read. A node whose join finds no row renders as "declared, not created", and the Build Job explains why.
- Params, input bindings, and secrets stay out — they are configuration, and configuration is not a node.
- Linked externals are not persisted because they are not in the graph — the domain map keeps them in configuration ("provision it or wrap it to bring it into the graph"). The governing principle: **if it's in the graph, persist it.** The moment a user wraps an external, it persists like anything else.

## The write protocol

One replace-set submission of the branch's graph per deploy, sent **post-Load, pre-apply**, under the deploy lease (which already serialises concurrent deploys to a branch). The graph is fully known before the apply, and with ids gone from the payload nothing needs waiting for. Same crash logic as creating the Build Job before containers: a run that dies mid-apply still recorded what it was deploying.

Three truths, three homes: declared shape = topology; materialised reality = the typed rows, converging per-resource; what this run did and why it stopped = the Build Job.

## Rejected alternatives

- **Topology as a JSON blob** (Composer's `--report` file): not queryable, not platform-owned, invisible to the Console. The file becomes transitional and dies once the Action reads the platform.
- **Topology coupled to Build** (provenance rows as the shape): couples structure to runs; history is the journal's job.
- **A single flattened edge list**: drops module structure, boundary forwarding, connection families and contracts — not a graph.
- **Flattened edges stored + forwarding as auxiliary records**: lossy in the two-names case; authored form is canonical instead.
- **End-of-run submission carrying platform ids**: waits on materialisation for nothing; join-by-key removes the need.
- **Per-link failure outcomes on Build Resources** (and config-key-keyed links): duplicative once the topology exists — run-level failure lives on the Build row, per-node "declared but not created" is derivable from topology minus typed rows. Today's id-keyed, success-only, existence-checked link shape stays.

## Work that falls out

**Platform (Will):** the three record types under Branch; the replace-set endpoint; read APIs with the `(branch, kind, key)` joins; Console surfaces. Plus the proposal's own items: the Deployment→Version rename (platform-wide or not at all), Build Job/Build Resource per the artifact.

**Composer (this repo, follow-up slices):**

1. **Core `Graph` keeps the authored form.** Load currently dereferences forwarded refs and discards the boundary traversal. Additive change in `load-module.ts` + `graph-types.ts`: retain boundary ports and pre-dereference edges alongside the flat view downstream consumers keep using. Will approved the shape.
2. **Topology submission.** A pre-apply write of the branch graph through the extension seam, once the platform endpoint exists. Natural home: beside the reporter hook's `begin`, after Load, before the stack file.
3. **Retire `--report`** once the Action reads Build + topology + Versions from the platform.
4. **Vocabulary follow-through.** The platform retires "Deployment" for "Version"; Composer's reporter vocabulary (`deployment` resource type, `deployedUrl`) follows the platform's rename when it lands — the SDK-derived types will surface it as a compile error, which is the point of deriving them.

## Left open, deliberately

- The rename affordance (a `moved`-block equivalent) for config-key identity across renames — named in the proposal, not designed here.
- Database Versions — reserved concept, future.
- Composer's coarse mid-apply `failingStep` (`DEPLOY.ENGINE_FAILED` swallows the real cause) — pre-existing follow-up, unchanged by this design.

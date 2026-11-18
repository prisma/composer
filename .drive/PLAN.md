# Planning failure modes

Checks to run when decomposing a project into slices.

- **Every slice serves the project's purpose.** Before the plan is final,
  read each slice against the spec's purpose sentence. A slice that came out
  of the same design discussion but solves a different problem is its own
  project or a deferred item, not a slice. Added 2026-10-28: the
  node-addressing project carried a cascading Branch delete and
  `prisma branch delete` because the discussion that started it was about
  teardown. Neither was about addresses; Will canceled both.
- **Read the owning team's recorded decisions before planning a slice in
  their repository.** A slice in another team's repository (pdp-control-plane,
  prisma-cli) needs that repository's specs and decision records read first.
  Added 2026-10-28: the cascading Branch delete was planned without reading
  pdp-control-plane's Branch spec, which records the platform team's decision
  against a cascade. The conflict surfaced only when the slice started.
- **Check a slice's mechanism against the principles, and the tests that enforce them, before dispatching it.** A mechanism agreed in conversation is not yet checked. Read each principle the mechanism touches and search the tests for the invariant that enforces it; if they forbid the mechanism, the question goes to Will before any implementer starts. Added 2026-11-18: the platform variables project dispatched a slice in which a Compute service reads `compute.bootstrap.json` itself. The implementer stopped twice before writing code: first because the plan put RPC keys on a core interface, then because reading a file needs Node's file system API, which the runtime-agnostic principle and two invariant tests forbid in a target's shipped code. Will dropped the slice.

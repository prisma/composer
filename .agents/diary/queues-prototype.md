# Queue prototype diary

- **Unrelated bug.** `prisma-composer dev` printed React "Invalid hook call"
  warnings twice before all local services became ready. The queue application
  still ran correctly, so investigating the CLI rendering issue is outside this
  prototype.

- **Scope tangent.** Composer should validate that `PRISMA_WORKSPACE_ID` matches
  the service token workspace before creating a project. A mismatch can make
  project discovery miss an existing project while creation still succeeds in
  the token workspace, producing an unwanted duplicate project.

- **Scope tangent.** The deployed demo relies on the `--name queues-demo`
  override while its root Module is named `queues-example`. A later deploy that
  omits the override creates a second project; the example should make its
  stable production name harder to omit.

- **Unrelated bug.** A deploy that changed an artifact together with its input
  document or dependency URL started the new artifact before the new binding was
  active. The queue service entered a restart loop with its previous input, and
  the dispatcher called previous queue and consumer routes. Reconciliation after
  the bindings settled fixed both cases; deployment ordering should prevent this
  state.

- **Scope tangent.** Promoting a new Compute deployment leaves every previous
  deployment running. This is unsafe for continuously polling drivers: six queue
  dispatcher revisions competed for work, and older revisions used stale
  bindings. Composer needs deployment retirement or a revision-fencing mechanism
  before always-running drivers are production-safe.

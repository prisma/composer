# Project conventions

- **Long-lived docs** go into the existing design docs, not a per-project
  folder: decisions into `docs/design/90-decisions/` as new or amended ADRs,
  terms into `docs/design/03-domain-model/glossary.md`, user-facing behaviour
  into `docs/guides/` and `skills/`. Each slice lands its own docs, so
  close-out usually migrates nothing.
- **Transient** at close-out: everything under `.drive/projects/<project>/`,
  including spikes' findings notes, QA records and review files. Their
  evidence belongs in the slice's PR description.
- **Tracking:** Will tracks Composer work outside Linear. Close-out PRs
  reference no Linear Project.

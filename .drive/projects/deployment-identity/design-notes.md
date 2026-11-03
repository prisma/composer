# Design notes — deployment-identity

## Principles

- A deploy's target is chosen by an identifier, never by a label.
- Nothing is created on the platform unless a human asked for it by name.
- Composer knows nothing about GitHub. Repo-to-Project knowledge lives on the platform's link record.

## The model

The Project's `logicalId` is the app name (ADR-0051). Container resolution matches on it and on nothing else. If no Project matches, the deploy stops unless `--create` was passed. The platform creates the Project when a repo is connected, so a connected repo's CI run always finds its Project and never needs `--create`.

```
prisma deploy module.ts            # finds Project by logicalId, or refuses
prisma deploy module.ts --create   # finds, or creates with that logicalId
```

The refusal message is the whole point: "No Project with logicalId `storefront` in this workspace. This deploy would create a new project rather than update one. Pass `--create` to do that. If this repository is connected in Console, the Project should already exist; check the connection."

## Alternatives considered

- **PR 355: Composer checks `GITHUB_REPOSITORY_ID` against the source-repository listing.** Rejected. Makes Composer GitHub-aware, re-verifies at deploy time what the platform decided at connect time, and is only a safeguard by its own admission.
- **The OIDC exchange returns the app name and the deploy action passes `--name`.** Rejected. Locks CI but hides the identity from the repo, so a developer cannot tell which Project a module file deploys to, and a local and a CI deploy of the same file can target different Projects.
- **CI passes `--create` on first deploy.** Rejected. Makes the flag meaningless in CI and couples the generated workflow to a Composer version. Creating at connect time needs no workflow change and no version coupling.
- **Keep the display-name fallback with a warning.** Rejected. The fallback is the mechanism that lets a name adopt an unrelated Project. The backfill removes the need for it.

## Open questions

- None at project level.

## References

- Full design, including the phases this project does not deliver: `.drive/projects/node-identity-and-consent/design-notes.md`.

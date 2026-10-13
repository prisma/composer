# ADR-0052: GitHub Project selection checks active repository connections

## Decision

The Prisma Cloud container resolver checks a GitHub Actions run's numeric
repository id against the Management API's active source-repository connections
before resolving any Branch or creating any container. If the repository is
connected to a Project, the Project selected by the root module name or
`--name` must have that same platform id. A mismatch fails rather than adopting
the other Project or creating a second one. A repository without a visible
active connection cannot adopt a Project actively connected to another repository.
Deploy and destroy use the same check.

The Prisma Cloud extension obtains the numeric id from `GITHUB_REPOSITORY_ID`
when `GITHUB_ACTIONS=true`. Missing or malformed identity fails. The resolver
pages the configured workspace's Project and source-connection listings;
transport, authorization and pagination failures are fatal. Core receives no
Prisma or GitHub-specific fields.

## Reasoning

Two repositories can deploy into one workspace with workspace-wide credentials.
Name selection alone lets a root-module rename select the other repository's
Project and its existing deploy state. The source connection provides a second,
independent identity to check before applying that graph.

The name remains the application's identity under ADR-0024 and ADR-0051. The
check rejects disagreement; it never silently overrides the name with the
connected Project or infers identity from a repository name or git remote.

## Consequences

- Active repository connections constrain CI Project selection. Local deploys
  and runs outside GitHub Actions retain the existing resolver behavior.
- The source-repository API currently returns active links only. Pending
  setup links do not yet constrain selection, so the first setup deploy can
  still create its Project. Protecting pending links requires a platform API
  that exposes their deploy destination.
- This is an accidental-destination safeguard, not an authorization boundary.
  GitHub environment values are caller-controlled and tokens keep their
  platform-defined permissions. Project-scoped CI credentials require a
  separate platform change.
- Connection reads add Management API requests during CI container resolution.

## Alternatives considered

- **Silently select the connected Project.** Rejected: a changed application
  identity would still reconcile against another application's saved graph.
- **Require an active link for every CI deploy.** Rejected: it blocks the
  pending setup PR whose first deployment establishes the Project.
- **Rely on workspace token permissions.** They permit both Projects, so they
  do not distinguish the intended destination.

## Related

- [ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)
- [ADR-0038](ADR-0038-containers-are-an-extension-descriptor.md)
- [ADR-0051](ADR-0051-a-nodes-address-is-its-logical-id-on-the-platform.md)

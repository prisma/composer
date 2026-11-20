# Composer works with the platform's variable groups

## Purpose

Prisma Cloud is replacing its two variable classes with variable groups and service variables, and is removing branch overrides. Every released Composer version gives wrong answers or fails under that model. This project makes new Composer releases deploy correctly under it, so a user's only step is to upgrade.

The whole design is in [design.md](design.md). The reviews it was revised against are in `reviews/`.

## Non-goals

- Patch releases on older Composer lines, and any special treatment of old Composer by the platform (Will, 2026-11-20).
- A way to set a user's value on one service through `prisma deploy`.
- Preflight seeing a value a user set on one service. Recorded in [deferred.md](deferred.md).
- Any change to how an app declares or reads a platform variable, or to core.

## Cross-cutting requirements

- Every change stays in the Prisma Cloud target, its lowering, its local target and the upstream provider.
- No platform deploy writes a variable row once the service variables change has landed.
- A deploy that changes nothing replaces no deployment.
- Nothing merges to `main` that calls a platform endpoint or sends a request field that production does not have yet, because every merge publishes a `dev` build.

## Done when

- A deploy to an environment whose branch receives a custom group reports missing and present platform variables correctly, and a value changed in that group replaces the services that read it. Checked against a real platform.
- A preview deploy makes no write that names a branch.
- An existing app upgraded from 0.39.0 keeps every service answering, and its old variable rows are gone.
- 0.40.0 is released, and the response to Ty states the minimum version or versions.

## Open question

- Whether 0.40.0 waits for the service variables change, or there are two minimum versions (design, section 10).

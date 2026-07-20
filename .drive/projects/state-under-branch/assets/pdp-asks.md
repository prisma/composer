# Two questions from the Composer team about the Management API

Context in three sentences: **Prisma Composer** is the TypeScript framework
that deploys multi-service apps onto Prisma Cloud through the public
Management API — one app becomes one Project, each environment (production,
staging, per-PR preview) is a Branch, and the app's services and databases are
that Branch's Apps and Databases. We're changing where Composer keeps its own
deploy state (the record of what it has provisioned, used to diff deploys and
drive destroys): instead of a separate workspace-level project, each
environment will keep its state in one small, framework-owned Prisma Postgres
database named `prisma-composer-state`, attached to that environment's Branch
and created through the ordinary database-create endpoint. The point is
lifecycle containment: deleting a Branch (or the Project) then cleans up our
state automatically, with no special handling on your side.

Two things we'd like to confirm before we ship it:

## 1. Quota / billing for one extra small database per Branch

Every environment gets one additional database (tiny: a handful of rows of
JSON state). For apps using per-PR preview environments, these come and go
with the PR — created on first deploy of the branch, deleted when the branch
is destroyed.

- Does this count against any per-project or per-workspace database quota we
  should design around?
- Is there a billing floor per database that would make "one small extra DB
  per PR preview" surprising for customers, or is a mostly idle database
  effectively free?

## 2. The dependency contract of `DELETE /v1/projects/{id}`

When Composer destroys an app's production environment, it deletes the
resources it created, then makes a best-effort `DELETE /v1/projects/{id}` so
empty projects don't accumulate toward the workspace plan limit. We rely on
the API's own 400 ("still has dependencies") to keep the project when other
environments still exist.

What we observe: the delete succeeds when the project holds only its implicit
default Branch and the auto-provisioned default database, and 400s when more
exists. We'd like to confirm that's the contract, not incidental behavior:

- Which children count as blocking dependencies? Specifically: does an
  **empty non-default Branch** block deletion? Does a **non-default
  database** block it (we assume yes — we delete our state database before
  calling project-delete)?
- Is "implicit default Branch + default database don't block deletion"
  guaranteed, or should we delete anything else first?

## FYI, not asks (yet)

Two things we'll likely bring to you later, flagged now so they're not a
surprise: a way to mark a database as framework-owned/protected (so users
don't hand-delete their environment's state DB from Console), and — for the
future GitHub App integration of Composer repos — short-lived,
project-scoped service tokens. Nothing needed on either today.

— Composer team (Will)

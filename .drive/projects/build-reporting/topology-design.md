# The topology design moved

The canonical design lives in **pdp-control-plane** at `projects/branch-topology/spec.md` (branch `feat/application-topology-root`, PR [pdp#4977](https://github.com/prisma/pdp-control-plane/pull/4977)), with its division of work in `plan.md` beside it. The wire schema and endpoint implementation live on branch `feat/branch-topology-api` (PR [pdp#4895](https://github.com/prisma/pdp-control-plane/pull/4895)): `PUT /v1/projects/{projectId}/branches/{branchId}/application-topology` — the qualified name `application-topology`, per pdp ADR-012. Composer's own work items from that plan are mirrored in this project's [plan.md](plan.md) follow-up section.

This file is a pointer, not a mirror — the mirror kept drifting and the design has one home now.

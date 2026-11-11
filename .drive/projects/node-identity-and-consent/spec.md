# Purpose

Make every change to a Composer node's identity deliberate, and make every deploy that would delete a database or bucket ask a person first. The design is in [design.md](design.md); this spec is the project contract the slices are planned against.

# At a glance

- Every node is declared with a required `id`, the last segment of its address. `name` no longer gives identity. `prisma deploy --name` is removed.
- A deploy that would delete a database or bucket asks one question per database or bucket, answered by `--delete <address>` or `--rename <old address>:<new address>`, following the ORM's rules for destructive operations. Non-interactive runs fail with `CLI.CONSENT_REQUIRED` and change nothing.
- On the platform, later: CI tokens scoped to one Project, then answering a CI deploy's questions in Console.

This project builds on `deployment-identity`, which makes a deploy find its Project by `logicalId` only and create one only with `--create`.

# Non-goals

- Defaulting `id` from `name`.
- Consent written into the code by the author, or a committed consent file.
- Questions about services, environment variables or connections, which hold no data.
- A deprecation period for `name` as identity.
- Any change to the deploy action or the generated workflow in parts 2 and 3.

# Place in the larger world

- Composer: every node constructor, Load (which builds each address), `prisma deploy`, and the plan step before a deploy changes anything.
- The ORM's CLI Style Guide, "Destructive operation confirmation": the consent rules to follow exactly, including `CLI.CONSENT_REQUIRED`, `CLI.CONSENT_UNUSED` and the control API's answer callback.
- Control plane: Console's setup pull request generator and its reader of the module file must write and read `id`. Part 4 narrows the CI token the control plane mints today for a whole workspace.

# Cross-cutting requirements

The requirements table in [design.md](design.md#requirements-this-design-meets) is the contract. In particular:

- One identity per node: the `id`s form the address, and the address is the platform `logicalId`.
- No code path matches a platform row by display name.
- No deploy deletes a database or bucket without a statement naming it; `--yes` never answers.
- Composer stays unaware of GitHub.

# Transitional-shape constraints

- Part 2 lands in one Composer release, because it breaks every module. Console's setup files and module reader ship before or with it.
- In part 3, `--delete` may ship before `--rename`. Until `--rename` ships, a changed address of a database or bucket is answered only by `--delete`.

# Project DoD

- [ ] A module declared with `id` deploys; a node declared with `name` and no `id` fails to load with an error saying to write `id`.
- [ ] Against a real Project: changing a database's `id` and deploying without a statement fails with `CLI.CONSENT_REQUIRED` and changes nothing; with `--rename` the same database keeps its rows under the new `logicalId`; with `--delete` it is deleted and a new one created.
- [ ] A push-to-deploy run that would delete a database fails and names the flags; no row changes.
- [ ] Console's setup pull request writes `id`, and Console reads `id` from a repository that brings its own module.
- [ ] A connected repository's CI token cannot read or write another Project in the workspace.
- [ ] The decision records listed in [design.md](design.md#what-this-changes-in-the-recorded-design) are amended or superseded; the guides, examples and the agent skill use `id` throughout.

# Open questions

See [design.md](design.md#open-questions). None blocks part 2 except the first (whether `name` survives as a label), which decides part 2's API.

# References

- [design.md](design.md)
- prisma/orm `docs/CLI Style Guide.md`, "Destructive operation confirmation".
- Linear: "Node identity and consent" (Terminal team).

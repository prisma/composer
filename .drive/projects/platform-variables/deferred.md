# Platform variables: deferred

Items this project does not do, and why.

## Waiting on the platform

Each needs a Management API change. None blocks this project (design section 3).

- **A platform record of which variables each service reads.** Composer's input documents already name them; the target would also send them to the platform, which could then deliver only those. Until then every deployment receives every row of its class.
- **A service scope.** Today a name resolves at two scopes, project class and branch, and preflight lists both. Will expects the platform to add a service scope. When it does, preflight's existence check gains one list call per reader; nothing else in the deploy changes, because the node never says where its value lives and preflight is the only part of the deploy that knows which scopes exist. `prisma dev` supplies one value per name from local files, so reproducing two readers with two values locally needs a per-reader local source, decided when the scope exists.
- **A void value.** Let an operator set a variable to "deliberately nothing", so the deploy report stops listing an intended absence as not set. Today the platform refuses an empty value.
- **Workspace variables and rules.** Values shared across projects, with rules for which branches see them. Composer does not create platform variable values today, so this needs nothing from Composer.
- **A topology entry for a platform variable node.** The platform's application topology has a fixed list of node kinds, owned by the Portal team. The node is not sent to it until the platform has a kind for it.

## Later Composer work

- **Destroying production deletes the operator's platform variables.** Destroying an app's production environment deletes its Prisma Cloud project, and with it every variable the operator set; the platform never returns a value, so an operator who kept no copy must make a new secret. Options: keep the project when it holds rows that are not Composer's, or warn before deleting. Waits because destroy's behaviour is not this slice's and needs its own decision.
- **An author-declared per-reader variable,** one that maps to the service scope the platform is expected to add, so that two readers of one name are guaranteed different values. Not built: where a value lives is the operator's choice on the platform, and nobody has a case that needs the author to force it. Wait for a real case.
- **A warning when the app names a variable another module expects under a different name.** Not needed: the deploy report lists every name with its readers, so a module wired to the wrong name shows up there.
- **An edge kind for "a service reads a platform variable".** Core's edges are dependencies (ADR-0063 names two relationships: depends on, exposes). The reads relation is recorded as a list beside each service's binding, not as an edge, because adding an edge kind changes core's graph types and the platform's edge families at once. Reason to wait: nothing reads the relation as an edge yet; the deploy report and errors read the list.
- **`schema` on a platform secret.** A secret box whose content is not text is undefined in this design and in module-input's. A `secret(inner)` field already checks a secret's text at boot. Needs a generic box type first.
- **An explicit way to set platform variables through `deploy`.** The operator names the values and the environments they go to, and the deploy writes those rows. Expected later. Not now: it needs its own design, and an implicit copy of local values is what slice 2 removed.
- **Isolating a service's environment on Prisma Cloud** without a platform record of who reads what, for example by having boot remove variables a service does not read. Not planned: it would hide variables an app reads directly from `process.env`.
- **Reading a deployment's logs from `prisma deploy`.** Composer does not tail deployment logs, so a boot error on the platform is read with `prisma service logs <service>`. The guide says so; tailing is a later change.
- **A value given by a resource that also provides a contract.** A value resource holds its value under a core-only key, so the node itself has no clash. The conflict is the return of `provision()`, which would have to carry both the contract's ports and the value. Allowed only on a resource with no contract until a second case needs both.
- **A report channel for preflight checks that are not about platform variables.** `PreflightInput.report` carries platform-variable findings and a count only. Designing a general channel waits for a second preflight check that needs one.
- **The CI script's deep imports from source paths.** `scripts/e2e-first-deploy.ts` imports from `packages/1-prisma-cloud/0-lowering/lowering/src/`, as four other scripts already do. Changing it is a change to that existing practice, not to this project.
- **The platform variables with no value in the `--report` run report.** The printed deploy report and the JSON output carry the list; the run report file holds steps, timings and the failure cause, and does not. Found in slice 2 QA. Reason to wait: no CI consumer reads the list from that file yet.
- **Moving Prisma's other repositories off `envSecret()` and `envParam()`.** Slice 3 removes both. Six internal apps call them: the `prisma/streams` deploy apps, `prisma/asks`, `prisma/program` and `prisma/pdp-control-plane`. `prisma/skills` and `prisma/web` document them. Each moves in its own repository when it upgrades Composer, following slice 3's migration guide.
- **A plain platform variable node added while `prisma dev` runs.** A rebuild after a code change runs no preflight, so the new node gets its value only when `prisma dev` restarts. Reason to wait: running the dev preflight on every rebuild is a separate change to the dev loop.

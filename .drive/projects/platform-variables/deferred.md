# Platform variables: deferred

Items this project does not do, and why.

## Waiting on the platform

Each needs a Management API change. None blocks this project (design section 3).

- **A platform record of which variables each service reads.** Composer's input documents already name them; the target would also send them to the platform, which could then deliver only those. Until then every deployment receives every row of its class.
- **A void value.** Let an operator set a variable to "deliberately nothing", so the deploy report stops listing an intended absence as not set.
- **Workspace variables and rules.** Values shared across projects, with rules for which branches see them. Composer creates no values, so this needs nothing from Composer.
- **A topology entry for a platform variable node.** The platform's application topology has a fixed list of node kinds, owned by the Portal team. The node is not sent to it until the platform has a kind for it.

## Later Composer work

- **An author-declared per-reader variable,** one that maps to the platform's service scope, so that two readers of one name are guaranteed different values. Not built: where a value lives is the operator's choice on the platform, and nobody has a case that needs the author to force it. Wait for a real case.
- **A warning when the app names a variable another module expects under a different name.** Not needed: the deploy report lists every name with its readers, so a module wired to the wrong name shows up there.
- **Preflight seeing a row set on a service.** If check 5 in design section 3 finds that the Management API cannot list service-scoped rows, preflight checks project and branch only, and a required value set only on the service makes preflight refuse. Closed when the API lists them.

- **An edge kind for "a service reads a platform variable".** Core's edges are dependencies (ADR-0063 names two relationships: depends on, exposes). The reads relation is recorded as a list beside each service's binding, not as an edge, because adding an edge kind changes core's graph types and the platform's edge families at once. Reason to wait: nothing reads the relation as an edge yet; the deploy report and errors read the list.
- **`schema` on a platform secret.** A secret box whose content is not text is undefined in this design and in module-input's. A `secret(inner)` field already checks a secret's text at boot. Needs a generic box type first.
- **A wait for the service to answer before a deployment is promoted.** Recorded only if check 4 in design section 3 finds that the platform promotes a deployment whose process exits at boot. Preflight already refuses the case the schema can show.
- **Removing `envSecret()` and `envParam()`** after their deprecation.
- **Removing `module()` as the deploy's entry.** S1 deprecates it with a warning instead of refusing it, because roots built with `module()` exist outside this repository. Do it after these have moved to `appRoot()`: the `create-prisma` template (`templates/create/_shared/module.ts.hbs`), the five apps under `compute/` in `prisma/prisma-examples`, `prisma/studio`'s `module.ts`, and `prisma/web`'s `module.ts` and its Composer docs (`apps/docs/content/docs/composer/`). Each repository moves when it next upgrades `@prisma/composer`.
- **A seeding command** that copies values from local files to the platform. Shelved by Will on 2026-11-05.
- **Isolating a service's environment on Prisma Cloud** without a platform record of who reads what, for example by having boot remove variables a service does not read. Not planned: it would hide variables an app reads directly from `process.env`.
- **Reading a deployment's logs when a deploy fails.** Composer does not tail deployment logs today, so a boot error on the platform is read in the Console. The guide says where; tailing is a later change.
- **A value given by a resource that also provides a contract.** `provision(resource)` flattens a contract onto the returned object, so a `value` member would collide. Allowed only on a resource with no contract until a second case needs both.

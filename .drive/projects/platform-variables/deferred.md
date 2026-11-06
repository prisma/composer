# Platform variables: deferred

Items this project does not do, and why.

## Waiting on the platform

Each needs a Management API change. None blocks this project (design section 3).

- **A platform record of which variables each service reads.** Composer's input documents already name them; the target would also send them to the platform, which could then deliver only those. Until then every deployment receives every row of its class.
- **A service scope.** Today a name resolves at two scopes, project class and branch, and preflight lists both. Will expects the platform to add a service scope. When it does, preflight's existence check gains one list call per reader; nothing else in Composer changes, because the node never says where its value lives and preflight is the only part that knows which scopes exist.
- **A void value.** Let an operator set a variable to "deliberately nothing", so the deploy report stops listing an intended absence as not set. Today the platform refuses an empty value.
- **Workspace variables and rules.** Values shared across projects, with rules for which branches see them. Composer creates no values, so this needs nothing from Composer.
- **A topology entry for a platform variable node.** The platform's application topology has a fixed list of node kinds, owned by the Portal team. The node is not sent to it until the platform has a kind for it.

## Later Composer work

- **An author-declared per-reader variable,** one that maps to the service scope the platform is expected to add, so that two readers of one name are guaranteed different values. Not built: where a value lives is the operator's choice on the platform, and nobody has a case that needs the author to force it. Wait for a real case.
- **A warning when the app names a variable another module expects under a different name.** Not needed: the deploy report lists every name with its readers, so a module wired to the wrong name shows up there.
- **An edge kind for "a service reads a platform variable".** Core's edges are dependencies (ADR-0063 names two relationships: depends on, exposes). The reads relation is recorded as a list beside each service's binding, not as an edge, because adding an edge kind changes core's graph types and the platform's edge families at once. Reason to wait: nothing reads the relation as an edge yet; the deploy report and errors read the list.
- **`schema` on a platform secret.** A secret box whose content is not text is undefined in this design and in module-input's. A `secret(inner)` field already checks a secret's text at boot. Needs a generic box type first.
- **Removing `envSecret()` and `envParam()`** after their deprecation.
- **A seeding command** that copies values from local files to the platform. Shelved by Will on 2026-11-05.
- **Isolating a service's environment on Prisma Cloud** without a platform record of who reads what, for example by having boot remove variables a service does not read. Not planned: it would hide variables an app reads directly from `process.env`.
- **Reading a deployment's logs from `prisma deploy`.** Composer does not tail deployment logs, so a boot error on the platform is read with `prisma service logs <service>`. The guide says so; tailing is a later change.
- **A value given by a resource that also provides a contract.** `provision(resource)` flattens a contract onto the returned object, so a `value` member would collide. Allowed only on a resource with no contract until a second case needs both.

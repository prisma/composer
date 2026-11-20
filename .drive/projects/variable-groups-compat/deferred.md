# Deferred

- **Preflight does not see a value a user set on one service.** A platform variable set only as a service variable, through Console's "Save and Deploy", is reported unset, and a required one fails the deploy. The fix is one `resolved-variables?serviceId=` read per reading service that already exists, with each key's `updatedAt` added to that service's triggers. Not built because Composer has no way to declare such a value. From the design, section 4.1.
- **Hints use `prisma project env` for the built-in groups.** Move them to `prisma variable` when it is the CLI most users have.
- **An app upgrading directly from a version before the address change** can have one service receive another's old row once. The guide tells it to deploy with a release from 0.35.0 to 0.39.0 first. A check in preflight against the deploy state would refuse it instead.
- **Ask the platform to put the limit and the count in its quota error for service variables.** Composer checks its own count, but cannot count variables a user set in Console.

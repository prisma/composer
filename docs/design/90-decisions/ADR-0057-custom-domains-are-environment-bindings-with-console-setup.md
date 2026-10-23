# ADR-0057: Custom domains are environment bindings with Console setup

## Decision

The Prisma Cloud target takes `domains[branchName][serviceAddress]`, containing exact hostnames. It reads the actual branch name from the platform, including for a default deploy. `main` is an ordinary name, and `production` has no special meaning. It selects only the deploying branch; changing the default branch never moves the old branch's hostnames automatically. The module graph and runtime inputs stay environment-neutral.

A hostname is a binding to an app in one environment, not a domain registration or DNS zone. Missing TXT ownership or routing records is an expected `setup_required` outcome. The service deploy succeeds and reports its generated URL, the hostname's status, and a Console setup link. Console validates that navigation hint and opens the DNS step. Verification remains an explicit mutation behind existing authorization. Authentication errors, conflicts, quotas and infrastructure failures are not setup outcomes.

Each declared hostname has its own resource in the existing per-stage deploy state. A declaration authorizes management of the matching binding on that app, including one completed in Console. Reads observe live status and absent bindings are retried on subsequent deploys without replacing the service. Removing a declaration or destroying a stage deletes that binding only. Domain registration, DNS records and zones outlive a stage. Undeclared bindings on surviving apps remain external.

## Reasoning

A hostname written on the reusable module would be claimed by every environment. Explicit deploy-target configuration preserves the stage boundary. DNS may take minutes or require a person; blocking a healthy deployment on that setup prevents the very app the person needs to configure from existing.

Console owns the setup interaction. Today it shows external TXT/CNAME instructions. In the future it can offer buying a domain, using a managed zone or entering external DNS, at the same link. Composer records the requested binding without encoding a registrar, DNS provider, purchase, renewal or billing operation.

Alchemy beta.83's `Prisma.CustomDomain` rejects every non-default branch and fails when registration requires DNS. Its required `customDomainId` cannot represent setup before registration. This is a narrow exception to ADR-0048: Composer supplies `PrismaComposer.CustomDomain` until upstream supports branch bindings and pre-registration setup outcomes. Existing upstream App, Deployment and EnvironmentVariable providers remain unchanged. The provider calls the existing authenticated Management API, so ownership verification, domain quotas and certificate issuance remain platform-owned.

## Consequences

- The public guide and installed skill describe explicit adoption: declaring an existing hostname makes its app binding Composer-managed.
- `setup_required` never reserves a hostname or issues a certificate. Another workspace still needs its own TXT proof.
- Console setup links target the canonical app IDs. Query values never authorize writes, transfers, DNS changes or purchases.
- An unlisted stage and local dev make no domain registration requests.
- Purchase and zone lifetimes must remain independent when managed DNS is added. Stage destruction must never cancel a purchase or delete a zone.

## Alternatives considered

- Use a `production` alias for whichever branch is currently default: rejected; it hides the branch identity and could move a hostname when the default changes.
- Fail deploy until DNS is configured: rejected; DNS setup is not deployment failure.
- Put domains on `compute()` or inherit production defaults: rejected; previews would compete for shared hostnames.
- Use upstream unchanged: rejected for its default-branch restriction and mandatory registration ID.
- Add registrar or DNS-provider APIs to Composer: rejected; these are Console operations with separate ownership, billing and consent.

## Related

- [Stage boundary](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md).
- [Upstream resource providers](ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md).
- [Shared configuration](ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md).
- [Deploy guide](../../guides/deploying.md#custom-domains).

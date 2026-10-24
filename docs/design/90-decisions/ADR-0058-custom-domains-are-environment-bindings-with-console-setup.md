# ADR-0058: Keep custom domains in branch deployment configuration and guard destructive changes

## Decision

Declare custom hostnames in the Prisma Cloud deployment target, keyed by actual branch name and service address. Keep reusable modules independent of the environment they run in.

```ts
// The Prisma Cloud extension in prisma.config.ts's composer section.
prismaCloud({
  domains: {
    main: { 'shop.web': ['example.com', 'www.example.com'] },
    staging: { 'shop.web': ['staging.example.com'] },
  },
})
```

Here, `shop.web` is the service's full address in the module graph, starting with the deployed app name (ADR-0057). The same prefix changes when `--name` overrides the app name. A branch is the platform container for one environment's services, data, configuration and deploy state. Only the deploying branch's entry is applied. An unlisted branch gets no declared custom domains. A default deploy reads the project's current default branch name from the platform; `main` is an ordinary name, and `production` is not a configuration alias. Changing which branch is default does not move hostnames.

Use **branch** as the public name for this concept. The public CLI spelling is:

```sh
prisma deploy module.ts                   # the project's current default branch
prisma deploy module.ts --branch staging  # the branch named staging
```

`--branch` replaces the public `--stage` spelling. During migration, `--stage` remains a deprecated alias with the same meaning; passing both is an error. Alchemy, the deployment engine Composer uses, may continue to call its internal state scope a stage. That internal scope remains keyed by the resolved branch ID. A public spelling change must not recreate resources or change their state namespace.

A hostname binding connects a hostname to a service's app on one branch. It is separate from registering a domain with a registrar or owning a DNS zone. Composer deploys the service before attaching its declared hostnames. When ownership TXT or routing DNS records are missing, or Cloudflare's proxy prevents registration, the app deployment completes with its generated URL and a domain result of **Setup required**. Only HTTP 422 `domain-ownership-required`, HTTP 400 `domain-dns-required` and HTTP 400 `domain-cloudflare-proxy` produce this result. It includes the API's setup hint when available and a Console link to the correct app, with the hostname prefilled. Opening the link makes no writes. The user adds the displayed DNS records and chooses **Verify and connect**. Certificate provisioning and an active domain are distinct results. Invalid declarations, ownership conflicts, quota limits and API failures remain errors.

Removing a declaration requests removal of its binding. It does not authorize the removal by itself. Before applying any planned resource mutation, a shared deployment safeguard inspects the complete plan for deletion or destructive replacement of managed resources. Detaching a serving hostname, deleting a database or bucket, and deleting an app whose children include them require explicit approval of the destructive plan. Show the resolved project and branch, whether it is the current default, the affected service or resource, and the consequences. Include indirect removals caused by deleting a parent or changing a resource's identity.

This safeguard applies to every branch and to the deploy and explicit teardown paths. Interactive use requires confirmation; non-interactive use returns a structured refusal unless the caller supplies approval for that exact destructive plan. A general `--yes`, omitted configuration or the label "preview" is not such approval. Recheck the plan against current state before applying it; a changed target or destructive action requires new approval. Routine code deployments and promotions that preserve app bindings and durable data continue without a destructive-change confirmation. A warning alone is insufficient. Composer runs Alchemy's plan and apply APIs in a guarded child process. It checks the full plan before calling apply. Preparation can still create containers, fill missing environment variables and record a deploy attempt. Those steps are outside the resource plan.

Automatic platform cleanup has its own guard. Git branch deletion and idle cleanup keep a Prisma branch with attached custom domains; Git deletion also respects a pin. A failed domain lookup leaves the branch intact. Registration and cleanup serialize on the platform's project lock so a binding cannot appear between the check and deletion. The cleanup response names the bindings and links to their Console setup pages. Console shows the current protection rule without claiming a Git deletion history.

The platform's GitHub Actions OIDC credentials must not auto-create a deleted environment. These credentials cannot auto-create a previously deleted branch name. A fresh GitHub branch event or explicit Console/API action establishes its next generation, followed by a new deployment. Credentials issued before a generation's deletion cannot mutate its replacement. Composer surfaces the platform refusal; it does not work around it by recreating the branch under another identity.

## Reasoning

The same module should deploy unchanged to a default branch, staging or a pull-request preview. Putting a concrete hostname on its `compute()` declaration would give every copy the same address. Branch-conditioned logic inside a module would make its topology depend on its deployment environment. The target configuration is the existing boundary where Composer translates reusable topology into a particular platform deployment, so the hostname-to-branch assignment belongs there. This extends that boundary with public deployment bindings; it does not add environment access to application code or a new source of runtime secrets.

The branch map is deliberately explicit. It makes routing assignments reviewable in code and prevents a new preview from inheriting a serving hostname. All branches still use the same module graph. Only the selected branch's bindings enter its deploy state. Runtime values continue to use the existing input and environment-source mechanisms. This is a limited use of environment-specific configuration in the deploy target, not a general facility for branching the module graph by environment.

A Composer stage already resolves to a platform branch. Calling it a branch removes the translation users and agents otherwise make between Composer and the rest of the Prisma CLI. The default branch is a mutable platform designation, not a fixed name or proof that another branch is safe to delete. This changes the public terminology in the earlier stage and CLI decisions; the branch containment and state model stay the same.

DNS setup can require a person and propagation time. A deploy should leave a working generated URL while that work is pending. Console owns the setup interaction and its authorization. It can later offer purchasing a domain, choosing a managed zone or configuring external DNS at the same entry point. Composer does not need registrar credentials, DNS-provider choices or billing operations to describe the requested binding.

A declaration opts that exact hostname's binding on that app into Composer management, including one completed in Console. The provider observes it on later deploys and reuses it without another registration. Bindings never declared to Composer remain externally managed while their app survives. This authority must be visible: the existence of an undeclared child does not make deleting its parent safe, so the shared safeguard must show cascades too.

Desired state alone cannot distinguish a deliberate removal from an accidental edit. A missing domain entry can interrupt traffic just as a missing database entry can destroy data. A domain-only or default-branch-only exception would leave the same error elsewhere in the topology. Checking the full plan before mutation both gives the user one decision and avoids partially applying a deployment before discovering a protected deletion. Hostname changes should normally add and verify the new binding, cut traffic over, then approve removal of the old one. A hostname conflict never silently transfers ownership.

The upstream Alchemy domain provider requires a registration ID and restricts creation to the default branch. It cannot represent a branch binding awaiting initial DNS setup. Composer therefore uses a small domain provider for that contract while retaining the upstream app and deployment providers. Registration still calls the authenticated Management API, which owns TXT verification, quotas and certificate issuance. This is a narrow exception to the upstream-provider decision, not a separate domain platform.

## Consequences

The branch configuration, Console setup links and domain status reporting can be implemented independently of buying domains or managing zones. The `--branch` migration must update the CLI, programmatic terminology, guides, installed agent skill and examples together, while preserving branch IDs and existing deploy state. Programmatic deploy accepts `branch`; `stage` remains a deprecated alias, and passing both is an error. Destroy accepts `{ kind: 'branch', branch }`, alongside its existing compatibility targets.

The shared destructive-change safeguard covers automatic detachment. Tests must prove that removing a hostname, renaming or removing a service, and deleting or destructively replacing a database or bucket cannot bypass it. Default and non-default branches, CI and programmatic callers, indirect cascades and stale approvals all need coverage. Explicit approved preview teardown remains possible. The CLI uses the engine's explicit-consent prompt: type the plan's token interactively or pass `--confirm <token>` in CI after review. `--yes` cannot satisfy it. Programmatic callers receive `DEPLOY.DESTRUCTIVE_APPROVAL_REQUIRED` with `failure.meta.plan` and can retry with `destructiveApproval: plan.token`, or obtain explicit consent through `approveDestructivePlan(plan)`. The token fingerprints the target, planned resource actions, prior resource state and replacement inputs. A retry computes a fresh plan and compares its token; the checked in-memory snapshot is then applied. A stale approval stops without applying any part of that plan. This is an explicit-consent check, not a substitute for serialized deployments or a platform-wide transaction.

Every deletion is protected, and every replacement is protected unless the target declares that resource type safe to replace. Retrying an interrupted replacement still requires approval before deleting its old resource. Prisma Cloud exempts only `Prisma.Deployment` replacement, which changes the code version while preserving its app, bindings and durable data. Parent app deletion warns that it also removes domain bindings managed outside Composer. Explicit teardown adds the branch or project container itself to the destructive plan, including the warning that default-deployment teardown attempts to remove the empty project. The platform keeps the project when another branch still has resources. Composer does not enumerate or manage external child resources individually. The guard covers resource lifecycle actions in the engine plan; it does not inspect SQL migrations or application-level data changes.

Approved Composer teardown removes its declared hostname bindings before deleting their apps and branch. The parent-deletion warning also covers bindings managed only in Console; remove those there first when retiring them separately. The platform branch API still requires an empty branch. Automatic Git or idle cleanup never supplies this approval and keeps a domain-bearing branch alive, including its apps and deploy state. Domain registration, DNS records and zones keep their own lifetimes. Once the next branch generation has been created deliberately, a new deploy can reconnect declarations using the same workspace's TXT ownership proof. Another workspace must publish its own proof. Retaining a DNS record alone never authorizes another workspace to claim the hostname.

Future Console-managed domains must preserve that separation. App deploys and branch teardown must never buy, renew, transfer or cancel a domain, delete a zone or remove shared DNS records. Those are separate Console operations with their own permissions, billing and explicit consent. Purchasing a domain does not bypass hostname ownership verification or the safeguard for removing a serving binding.

## Alternatives considered

- **Keep `stage` and `branch` as separate public names.** They refer to the same platform scope and impose a translation without adding a capability. Keep the deployment engine's internal term private.
- **Treat `production` as an alias in the domain map.** A default-branch change could silently reassign traffic. Exact branch names make that change explicit.
- **Put hostnames or environment conditions in reusable modules.** Copies would compete for a hostname, or the module graph would vary by environment.
- **Manage every binding only in Console.** Keep this available for externally managed bindings, but do not make it the only option: it loses the code-reviewed declaration and reproducibility for Composer-managed bindings.
- **Block a healthy app deploy until DNS is ready.** The app can serve on its generated URL while the user completes setup.
- **Delete on omission, or warn only for default-branch domains.** An accidental edit can remove live routing or durable data on any branch. Use the same explicit approval rule across resources.
- **Retain removed bindings silently.** That hides drift and weakens Composer's ownership model. Report the requested removal and stop for approval instead.
- **Use the upstream domain provider unchanged.** Its branch restriction and mandatory registration ID do not support this setup flow.
- **Add registrar and DNS-provider APIs to Composer.** Domain and zone ownership outlive individual deployments and require separate consent and billing.

## Related

- [Application and branch containment](ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md).
- [Environment-neutral modules and deploy-time stage selection](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md).
- [Public deploy command](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md).
- [Shared configuration file](ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md).
- [Full addresses and resource identity](ADR-0057-a-nodes-address-is-its-full-path-from-the-app-name.md).
- [Upstream resource providers](ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md).
- [Guiding principles](../01-principles/guiding-principles.md) and [architectural principles](../01-principles/architectural-principles.md).

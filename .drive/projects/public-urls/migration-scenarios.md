# Routing URL ownership: migration scenarios

Scenarios for how Composer takes ownership of routing URL rows that exist before it knows about them. Each gives the starting state, what the user does, and what must be true afterwards. Where the required outcome is itself an unmade decision, it says so. Use these to stress-test the options.

Background: old Composer versions wrote deploy state that knows only an App with an `endpointDomain`. Nothing in that state can say "this service has a routing URL", so every RoutingUrl the new version declares is a new resource to Alchemy. The only thing that can connect it to the row already serving traffic is the row itself, through the recorded rule that on the app's own Branch the row holding a node's `logicalId` is that node's row. Composer owns every piece of its topology that matters to the app's functioning.

## 1. Existing app, upgrade Composer, no code change

- **Start:** `shop` has `web` and `worker`, deployed by old Composer. Both have endpoints and both are public.
- **Action:** the user upgrades Composer and runs `prisma deploy` without touching the code. The code has no `publicUrl()` because the old API had none.
- **Must hold:** the deploy succeeds, and `web` keeps answering at `svc_123.cdg.prisma.build`.
- **Decision needed:** under the new model a service with no `publicUrl()` is private. Either the upgrade is allowed to keep both services public silently, or it refuses until the code says which services are public.

## 2. Existing app, upgrade and declare the assigned hostname

- **Start:** as scenario 1.
- **Action:** the user adds `publicUrl({ name: 'site', url: publicUrl.assigned(), target: web.http })`.
- **Must hold:** `web` keeps the same hostname with no interruption; the row that serves it is now owned by Composer; `worker`'s endpoint row is also owned and marked private.
- **Stress:** the backfilled row carries a `logicalId` derived from `web`'s, while the `publicUrl()` node's own address is `shop.site`. Whichever `logicalId` the lowering declares has to be the one the backfill wrote.

## 3. Existing app, a domain added in the Console, now declared in code

- **Start:** last year the user attached `shop.com` to `web` in the Console.
- **Action:** they write `publicUrl({ name: 'site', url: 'shop.com', target: web.http })`.
- **Must hold:** `shop.com` never stops serving, and after the deploy Composer owns the row.
- **Resolved:** no matching is needed. Composer creates its own row for `shop.com`; the Console row is undeclared and goes away under scenario 4's rule; the routing table ends up the same. The reconciler hands the existing Foundry registration to the new row instead of deleting and re-registering it, so the certificate is not issued again and the site stays up.

## 4. Existing app, a Console domain the code does not declare

- **Start:** as scenario 3.
- **Action:** the new code declares nothing for `shop.com`.
- **Must hold:** Composer owns every piece of its topology that matters to the app, so the deploy cannot leave the row unmanaged.
- **Decision needed:** whether the deploy removes the row or refuses until the code mentions it.

## 5. New app on the new Composer

- **Start:** no history.
- **Action:** `web` has a `publicUrl()`, `worker` does not. First deploy.
- **Must hold:** `web` gets one public row, `worker` gets one private row, the platform creates neither on its own, and both have `logicalId`s the next deploy finds.

## 6. A preview environment of an existing app

- **Start:** the upgraded app of scenario 2.
- **Action:** it deploys to `pr-42` for the first time. The Branch is new and has no backfilled rows.
- **Must hold:** identical to scenario 5. Nothing from production's history leaks in.

## 7. A user who has not upgraded

- **Start:** the platform change has shipped.
- **Action:** a user on old Composer keeps deploying. Old Composer creates services without the default-URL parameter.
- **Must hold:** every new service gets its default public row exactly as before, with the derived `logicalId` written by the platform at creation, so that when this user upgrades later they are in scenario 1 and not in a worse state.
- **Consequence:** the derivation rule lives in the platform, not only in the backfill.

## 8. An interrupted first deploy on the new version

- **Start:** scenario 2, mid-deploy.
- **Action:** the deploy adopts `web`'s row, then dies before Alchemy writes state.
- **Must hold:** the next deploy finds the row by its `logicalId` and carries on. This is the recorded rule for every row and needs nothing new, provided the `logicalId` is on the row.

## 9. Renaming a service

- **Start:** the new version, `shop.com` declared on `web`.
- **Action:** the user renames `web` to `storefront`. Its address changes, so by the recorded rule it is a new entity: a new service row and a new assigned URL row, and the old ones are deleted. `shop.com` is now declared on a node with a new address.
- **Must hold:** the deploy deletes the old row's registration before the new row registers, or `shop.com` is stuck behind the uniqueness rule and the site is down for the gap.
- **Stress:** ordering inside one deploy.

## 10. Destroying an environment

- **Action:** the user destroys `pr-42`, deployed by the new version.
- **Must hold:** the Branch is deleted and every row with it.
- **Production:** destroy deletes what deploy state records. Nothing is left behind only if every row was adopted in scenarios 1 to 4.

## 11. A Console user adds a URL to a managed service after migration

- **Start:** the app is fully on the new version.
- **Action:** someone adds `beta.shop.com` to `web` in the Console.
- **Must hold:** the same answer as scenario 4, applied on the next deploy.

## 12. A service nothing calls and nothing exposes

- **Start:** a cron-driven job on the new version.
- **Must hold:** it has one private assigned row like every managed service, and no public hostname.

## What falls out

- Two decisions: scenario 1 (what an upgrade without code changes does) and scenario 4 (what happens to a row the code does not declare). The second also answers scenario 11.
- Scenario 3 needs no `logicalId` derivation; it needs the reconciler to hand over a Foundry registration between rows for the same hostname.
- Scenario 7 puts the `logicalId` derivation rule in the platform's service-create path, not only in the backfill.

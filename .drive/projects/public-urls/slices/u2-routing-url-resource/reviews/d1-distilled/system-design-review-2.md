# System design review, round 2 — D1, distilled core change and Prisma regeneration

Branches: `feat/core-rest-response-code` at `44663aaba`, `feat/prisma-routing-urls` at `958e84988`. Round 1: [system-design-review.md](system-design-review.md).

## What changed

Core's generic REST protocol now supports a trait core already had: `T.ResponseCode()`. The Cloudflare protocol already honours it (`packages/cloudflare/src/protocol.ts`). Prisma's generator binds Smithy's own `smithy.api#httpResponseCode` trait to it, and patch 006 adds that trait to the two idempotent creates.

## Fit

- **It is the standard Smithy mechanism.** `httpResponseCode` is the Smithy trait for "this output member is the HTTP status". It is used, not invented. The core change only closes a gap: the generic REST protocol ignored a trait that the Cloudflare protocol already read.
- **Opt-in at two levels.** A package's generator must bind the trait, and the model must carry it on a member. Other REST clients are unaffected unless both happen. That keeps the blast radius to the two Prisma operations that need it.
- **Right layer.** Whether a create created something is protocol information. Exposing it in the SDK is better than having Alchemy re-list resources around every create to guess.
- **Name.** `httpStatus` names the mechanism, which is correct here: it is the HTTP status and nothing more. Consumers derive "created" from it themselves.

## Remaining design gap

Typed RoutingUrl errors are deferred to D3 by decision. When D3 adds them, they belong in a distilled patch, not in a check on error bodies inside the Alchemy resource, per Alchemy's typed-error rule. D3's spec should name the patch.

## Test strategy

The core property ("a marked member receives the status; nothing else changes") is tested at the protocol level. Alchemy's restored `CustomDomain` race test exercises it end to end through the fake API. Two branches of `withResponseCode` are untested; code review F05.

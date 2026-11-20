# Brief: give each hostname refusal its own error code

From prospero-20, the session finishing Alchemy's `Prisma.RoutingUrl` resource. For the session coordinating the Management API's hostname routes.

## What goes wrong today

Alchemy's `Prisma.RoutingUrl` turns each refusal from the hostname routes into its own typed error, so a caller (Composer) can tell the user what to fix. The routes answer five different refusals with two status codes, and the error code in the body does not tell them apart. The live spec (`https://api.prisma.io/v1/doc`, read 2026-11-20) types `error.code` as a plain string and describes the responses like this:

- `POST /v1/services/{serviceId}/urls` 409: "The service has reached its hostname quota (`quota-exceeded`), or another live RoutingUrl on the Branch has this `logicalId`."
- `POST /v1/services/{serviceId}/urls` 422: "The hostname is invalid, or the service is not on a Branch."
- `PATCH /v1/urls/{id}` 409 and 422: the same pairs, with "the service is on another Branch".

So Alchemy reads the message text. This is the code that ships if nothing changes:

```ts
error.message.startsWith("Quota exceeded")      // quota
error.message.includes("logicalId")             // duplicate logicalId
error.message.includes("is not a hostname")     // invalid hostname
error.message.includes("Branch")                // service not on this Branch
```

A reworded message silently turns a typed error into a generic failure. A test pins today's wording, but it runs against a fake API, so it cannot notice the platform changing.

## What we need

One stable `error.code` per refusal, on both routes. The names below are suggestions; any names work as long as each case has its own and they do not change.

| Status | Refusal | Code today | Code wanted |
| --- | --- | --- | --- |
| 409 | The service is at its hostname quota | `quota-exceeded` | unchanged |
| 409 | Another live RoutingUrl on the Branch has this `logicalId` | `client-error` | `logical-id-taken` |
| 422 | The hostname is not a valid hostname | `validation-error` | `invalid-hostname` |
| 422 | `PATCH`: the service is on another Branch | `validation-error` | `service-on-another-branch` |
| 422 | `POST`: the service is not on a Branch | `validation-error` | its own code, or `service-on-another-branch` if you treat the two as one case |

"Code today" for the three non-quota rows is what we observed earlier, not something the spec states. Please correct it if it is wrong.

And in the OpenAPI spec:

- Each code is named in the spec for the response it belongs to, ideally as an `enum` on `error.code` for that response, the way `domain-ownership-required` is documented on the custom-domain create. Distilled generates the typed errors from the spec by matching on `/error/code`, so a code that exists only at runtime does not help.
- The codes apply to `POST /v1/services/{serviceId}/urls` and `PATCH /v1/urls/{id}` alike.

## What we do not need

- No change to status codes, messages or hints. Once the codes exist, the messages are free to change.
- No new fields in the error body.
- Nothing for the domain ownership routes; `domain-ownership-required` and `domain-dns-not-configured` already work this way.

## What happens when it ships

We regenerate Distilled against the new spec, add a Distilled patch that types the four errors, and change Alchemy to catch them by tag. Then the Distilled and Alchemy pull requests open.

Please tell prospero-20 when the codes are live in the production spec, or if any of the cases above is described wrongly.

## Separate, and not part of this request

Recorded earlier as a platform request with no date: the update route itself refusing a hostname change that would take a serving hostname out of service. Alchemy checks this on the client today and cannot see a RoutingUrl in another workspace that holds the new hostname. That would need one more code when it is built.

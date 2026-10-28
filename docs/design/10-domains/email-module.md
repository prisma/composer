# The `email` module — why it is shaped the way it is

The `email` module (`packages/1-prisma-cloud/2-shared-modules/email`) sends
transactional email. A Compute service exposes two rpc ports: `send` delivers
a rendered email, and `outbox` reads back every email the module has handled.
Delivery goes to Resend, to an SMTP server, or nowhere (`none`), chosen per
environment. Every email is stored in the module's own Postgres first.

How to use it is in the package
[README](../../../packages/1-prisma-cloud/2-shared-modules/email/README.md).
This note records why the main decisions went the way they did.

## A separate Compute service, not a client library

Email is a module with its own service rather than a library each consumer
links in. Anything that satisfies the contract can stand in for it, and the
delivery provider's credential lives in one service instead of in every
consumer. This is the general rule that a module has the same boundary as a
service: dependencies in, exposed ports out
([ADR-0016](../90-decisions/ADR-0016-a-module-has-the-same-boundary-as-a-service.md)).

## Templates render on the consumer side

Consumers declare their templates with `defineTemplates` and render them in
their own process. The wire carries only rendered mail (subject, HTML,
optional text) through one generic `send` method.

The service cannot render consumer templates, because that would mean running
consumer code inside the email service, and the framework never bundles or
transforms the app's code
([ADR-0005](../90-decisions/ADR-0005-users-build-the-framework-assembles.md)).
The cron module works the same way: job ids travel as data, and the typed
surfaces live at the edges.

## One typed client method per template

`emailSender(templates)` hydrates to a client with one method per declared
template, and each method's `data` argument is typechecked against that
template's schema. The template declarations define the client's shape; that
was the design goal.

## Separate `send` and `outbox` ports

Sending and reading are two ports so they can be wired separately. A consumer
that can send must not automatically be able to read every email ever sent:
the outbox holds verification and magic links, and those are live
credentials. Each rpc binding carries its own service key
([ADR-0030](../90-decisions/ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md)),
so least privilege is a wiring choice.

Today `serve()` mounts every rpc method of a service under one flat
`/rpc/<method>` namespace, so method names must be unique across the two
ports, and a key minted for either port is accepted by the whole service. See
the wired-egress entry in [`.drive/deferred.md`](../../../.drive/deferred.md)
for the planned fix.

## The outbox is a production interface

The outbox is not a test hatch. It is meant to back an admin panel, so it gets
the same care as `send`: keyset pagination, filters, and a stable record
shape. The same property is what makes local dev and preview environments work:
with delivery set to `none`, an end-to-end test or an agent reads the
verification link out of the outbox instead of a mailbox.

## The delivery credential is always required

The delivery credential is a required secret even in environments where delivery is
`none` and the value is never read. The framework has no optional or
conditional secrets: every wired secret is required
([ADR-0029](../90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md)). Such
environments set a junk value. This was accepted as known friction, recorded in
[`gotchas.md`](../../../gotchas.md#composers-secret-model-has-no-optionalconditional-secrets--every-off-environment-still-needs-a-junk-credential),
rather than solved in the framework.

## No custom contract kinds

Both ports use the ordinary `rpc` contract kind. There are no `email-send` or
`email-outbox` kind strings. rpc contracts satisfy each other by identity, so
two distinct contract objects are already two distinct wiring targets; a new
kind string would add nothing.

## Related

- [`auth-module.md`](auth-module.md) — the first consumer, and the same
  multi-port conventions.
- [`connection-contracts.md`](connection-contracts.md) — how contracts match.

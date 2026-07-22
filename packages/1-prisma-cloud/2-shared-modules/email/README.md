# `@prisma/composer-prisma-cloud/email`

Transactional email as a Prisma Composer module. It is an ordinary module: a
Compute service backed by a module-provisioned Prisma Postgres (every email is
stored first, then delivery is attempted — the outbox), exposing two
independent ports: `send` (deliver a rendered email) and `outbox` (query every
email the module has handled). Templates are declared and rendered
**consumer-side**; the wire carries only rendered mail.

Ships as the `@prisma/composer-prisma-cloud/email` subpath (like `/storage`
and `/cron`).

## Contract scope

Two ports, three ops:

| Port | Op | Notes |
| --- | --- | --- |
| `send` | `send` | `{ templateId, to, cc?, bcc?, replyTo?, subject, html, text?, idempotencyKey }` → `{ id, status, error? }`. `to` 1–50 entries; `idempotencyKey` 1–256 chars. |
| `outbox` | `getEmail` | `{ id }` → `{ email }` (`null` for an unknown id — never an error). |
| `outbox` | `listEmails` | Optional `to`/`templateId`/`status`/`cursor`/`limit` filters (AND-combined; `to` matches any recipient) → `{ emails, nextCursor? }`, newest-first, keyset-paginated. `limit` 1–200, default 50. |

`status` is one of `stored` (mode `none`), `queued` (real modes, transient),
`sent`, `failed`. `send` never throws for a delivery failure — failure is
data (`status: 'failed'`, `error` set); it throws only for transport,
validation, or database errors.

`from` is not part of `send`'s input — the sender address is module config
(one per module instance); a template cannot override it.

## Envelope

**No attachments** in v1. service-rpc request/response bodies cap at **1
MiB**, so a rendered email (subject + html + text) must fit inside that.
**Retention: none** — every sent email's full body is stored, unredacted,
forever (no expiry, no deletion, no redaction). Do not put anything in a
template you would not want to live in the database indefinitely.

## Wiring

Provision `email()` in a module and declare template-typed dependencies on
its two ports:

```ts
// module.ts — the deploy root
import { module } from '@prisma/composer';
import { email } from '@prisma/composer-prisma-cloud/email';
import { envParam, envSecret } from '@prisma/composer-prisma-cloud';

export default module('app', ({ provision }) => {
  const mail = provision(email(), {
    id: 'email',
    params: {
      deliveryMode: envParam('EMAIL_DELIVERY_MODE'),
      from: envParam('EMAIL_FROM'),
    },
    secrets: { deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') },
  });
  provision(appService, { deps: { email: mail.send } });
  provision(adminService, { deps: { outbox: mail.outbox } });
});
```

```ts
// consumer service — templates declare the client's shape. Interpolated
// values are HTML-escaped before going into markup — `render` runs on
// whatever data the caller supplies, so treat it as untrusted the same way
// you would any other template.
import { defineTemplates, emailSender } from '@prisma/composer-prisma-cloud/email';
import { type } from 'arktype';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const templates = defineTemplates({
  verification: {
    data: type({ link: 'string' }),
    render: ({ link }) => ({
      subject: 'Verify your email',
      html: `<p><a href="${escapeHtml(link)}">Verify</a></p>`,
      text: `Verify: ${link}`,
    }),
  },
});

export default compute({ deps: { email: emailSender(templates) }, /* … */ });
```

```ts
// consumer server
const { email } = service.load();
await email.verification({ to: user.email, data: { link } });
```

The outbox port needs no custom factory — declare `deps: { outbox:
rpc(emailOutboxContract) }` and get the generated client directly.

## Using react-email

`render` may be synchronous or async — the sender method awaits either.
This module neither depends on nor imports react-email; a template's
`render` just calls react-email's own `render()` and returns its result:

```tsx
// emails/welcome.tsx — a plain react-email component
import { Body, Container, Html, Text } from '@react-email/components';

export function WelcomeEmail({ name }: { name: string }) {
  return (
    <Html lang="en">
      <Body>
        <Container>
          <Text>Welcome, {name}!</Text>
        </Container>
      </Body>
    </Html>
  );
}
```

```tsx
// templates.tsx
import { render } from '@react-email/render';
import { WelcomeEmail } from './emails/welcome.tsx';

const templates = defineTemplates({
  welcome: {
    data: type({ name: 'string' }),
    render: async ({ name }) => ({
      subject: `Welcome, ${name}!`,
      html: await render(<WelcomeEmail name={name} />),
      text: await render(<WelcomeEmail name={name} />, { plainText: true }),
    }),
  },
});
```

JSX interpolation (`{name}` above) escapes automatically — React escapes
text children by construction, so a react-email template needs no manual
`escapeHtml` the way a plain-function template does. See
[`examples/email`](../../../../examples/email)'s `welcome` template for
the full worked version, alongside `verification` as a plain function —
both authoring styles side by side.

One deploy caveat: `prisma-composer deploy` loads your module graph with
Node's own loader, which cannot transform JSX — a `.tsx` file imported by
your topology fails with `Unknown file extension ".tsx"`. Precompile the
templates file in your app's own build and import the compiled output, as
[`examples/email/scripts/build.ts`](../../../../examples/email/scripts/build.ts)
does (see the matching `gotchas.md` entry).

## Platform env vars (per stage)

`deliveryMode` and `from` are module-boundary params — the app binds a
source (`envParam`), so both vary per stage. `deliveryUrl` is a factory
option (`email({ deliveryUrl })`), static per app — it defaults to
`https://api.resend.com` and follows the mode, which already varies per
stage.

| Var | Production | Preview |
| --- | --- | --- |
| `EMAIL_DELIVERY_MODE` | `resend` (or `smtp`) | `none` |
| `EMAIL_FROM` | `noreply@myapp.com` | anything (unused when `none`) |
| `EMAIL_DELIVERY_CREDENTIAL` | Resend API key / SMTP password | **any non-empty junk** — required by preflight even though never read |

The junk-credential row on preview is a known wart: the framework has no
optional/conditional secrets (every wired secret is required, ADR-0029), so
a stage that never delivers still has to set a non-empty value. See
`gotchas.md` for the filed friction finding.

## Delivery policy

Shared by both real backings (`resend`, `smtp`):

- Per-attempt timeout: **10 s**.
- Up to **3 attempts** (1 initial + 2 retries), delayed **500 ms then
  2000 ms** between them (no jitter).
- Retryable: thrown/network errors, HTTP 429, HTTP 5xx (Resend); SMTP
  connection errors and response codes 421/450/451/452.
- Not retryable (fails immediately): any other Resend 4xx (including 409
  idempotency conflicts — those should be unreachable given the outbox's
  own row-level dedup; if one surfaces, it is not masked); any other SMTP
  response code, including permanent 5xx rejections.
- The outbox row's `attempts` accumulates the count each delivery
  invocation actually made (1–3 under the policy above) — a future
  redelivery from the outbox adds its own tries to the running total.
- Stored `error` string: `` resend <status> <name>: <message> `` (Resend,
  parsed from its error body; falls back to the raw response text if
  unparseable) or `` smtp <responseCode>: <message> `` (SMTP protocol
  rejection). A connection-level failure (no response code) stores the raw
  error message with no prefix, for either backing.

**SMTP: "accepted" is not "delivered".** `status: 'sent'` for an SMTP send
means the relay accepted the message for submission — nothing more. SMTP
gives no delivery confirmation; `providerMessageId` is nodemailer's
`info.messageId` (or `null`).

**SMTP: a timeout retry can duplicate a send.** The per-attempt timeout
only stops the module from waiting on a slow relay — it does not cancel
the in-flight SMTP transaction. If the timeout fires, the shared policy
retries; a slow relay can still accept the first attempt's message after
the retry has already started, delivering the same email twice. This is a
deliberate retry-semantics tradeoff (at-least-once, not exactly-once) and
stays as pinned — the only fix that removes the possibility is not
retrying on timeout, which would trade a rare duplicate for a more common
false failure on a merely slow relay.

## Idempotency

`idempotencyKey` is required on every `send` call and must be **unique per
logical send**. A repeated key returns the original row — status, id, and
all — with no new delivery attempt, even if the payload differs. This is a
durable, row-level guarantee (a unique constraint on `idempotency_key`),
independent of and stronger than service-rpc's own in-memory replay cache.

`emailSender`'s per-template methods make `idempotencyKey` optional: omit
it and a fresh UUID is minted on every call, so that call gets no dedup
protection against its own retries. If your own retry logic re-invokes a
send method after a transient failure, capture the key from the first
attempt and pass it explicitly on the retry — the module does not
remember it for you.

## Local development

`@prisma/composer-prisma-cloud/email/testing` boots the same handler map
over an in-memory store, `deliveryMode: 'none'`, loopback only, no auth —
no cloud credentials, no Postgres:

```ts
import { startLocalEmailServer } from '@prisma/composer-prisma-cloud/email/testing';

const server = await startLocalEmailServer(); // ephemeral port by default
// server.url — point emailSender()/rpc(emailOutboxContract) clients at it.
await server.stop();
```

[`examples/email`](../../../../examples/email) is the worked example: a
`mailer` app wired to `email()`, tested locally against this stand-in with
no cloud credentials, and deployed to Prisma Cloud in `none` mode as the
smoke test.

Tests that exercise the real Resend/SMTP backings point `deliveryUrl` at a
local fake instead of the real provider — a `Bun.serve` fake HTTP endpoint
for Resend, a minimal loopback SMTP responder for SMTP (see
`delivery-resend.test.ts`/`delivery-smtp.test.ts`).

## Manual resend check (not run in CI)

A one-off, by-hand verification that a real send actually delivers — not
part of the test suite or the deploy smoke, since it needs a real Resend
account:

1. Set the stage's `EMAIL_DELIVERY_MODE` to `resend`, `EMAIL_FROM` to an
   address on a domain verified with Resend, and `EMAIL_DELIVERY_CREDENTIAL`
   to a real Resend API key.
2. Send one template to a real inbox you control.
3. Confirm the message arrives, and that the outbox row for it reads
   `status: 'sent'` with a non-null `providerMessageId`.

## Non-goals (v1)

Attachments, cc/bcc size limits beyond the contract's, per-send `from`
override, batch/scheduled send, Resend webhooks, delivery-status polling,
open/click tracking, queue-backed async delivery (the outbox is the seam
for a later relay — no contract change needed), retention/redaction/
deletion, and an admin UI. react-email is not a dependency of this module
— see "Using react-email" above for how a consumer wires it in.

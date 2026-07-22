# Project: `email` module — implementation spec

> Status: settled design, 2026-07-21 (design session with Will). This spec is
> exhaustive by intent: every name, type, behavior, and file placement is
> pinned. An implementer who finds a genuine gap records it here and asks —
> they do not improvise.

## At a glance

Transactional email as a composed module: a Compute service behind a typed
boundary, exposing two service-rpc ports — `send` (deliver a rendered email)
and `outbox` (query every email the module has handled). Templates are
declared and rendered **consumer-side** with arktype-typed parameters; the
wire carries only rendered mail. Delivery goes to Resend (HTTP API) or an
SMTP server, chosen per stage by config — or nowhere (`none`), in which case
the email is stored in the module's own Postgres and readable back through
the outbox port. That stored mode is the local-dev and preview-stage story:
an e2e test or agent reads the verification link out of the outbox instead
of a mailbox.

First consumer: the `auth` module (verification, password reset, magic
links).

## Settled decisions (do not relitigate)

| # | Decision | Why |
|---|---|---|
| D1 | Dedicated Compute service, not a client library | Anything satisfying the contract can substitute; the provider secret lives in one place; ADR-0016 |
| D2 | Templates are declared and rendered consumer-side; the wire carries rendered mail through one generic `send` op | The service can never run consumer code (ADR-0005); mirrors cron's `trigger(jobId)` — ids travel as data, typed surfaces live at the edges |
| D3 | Each template becomes a **method** on the consumer's hydrated client, with its `data` typechecked | The design goal: template declarations define the client's shape |
| D4 | Two exposed ports: `send` and `outbox` | Least privilege — a consumer that can send must not automatically read every email ever sent (magic links are live credentials) |
| D5 | The outbox is a real production interface (future admin panel), not a test hatch | Will, 2026-07-21 |
| D6 | Every email is written to the module's own Postgres **first**, then delivery is attempted | One implementation for prod/preview/local; `delivery: none` is a config value, not a different module — topology never varies by stage |
| D7 | Config params are separate: `deliveryMode` (enum) and `deliveryUrl`, not one packed value | Will, 2026-07-21 |
| D8 | The delivery credential secret is unconditionally required, junk allowed when mode is `none` | Framework has no optional/conditional secrets (ADR-0029: "every wired secret is required"); accepted as a friction finding, not framework work in this project |
| D9 | Both wire contracts stay on the `'rpc'` kind — no `email-send`/`email-outbox` kind strings | rpc contracts satisfy by identity, so two distinct contract objects are already distinct wiring targets |
| D10 | Idempotency dedup is durable at the outbox row (unique key), plus pass-through of the key to Resend | service-rpc's LRU is per-instance/best-effort; the row insert is the real guarantee |
| D11 | Retention: none. V1 stores every email in full, forever | Punt until something real needs it |
| D12 | No attachments in v1 | service-rpc bodies cap at 1 MiB; state it in the README |

## Package layout

New workspace package `packages/1-prisma-cloud/2-shared-modules/email`,
name `@internal/email`, mirroring `@internal/storage` exactly (same
`package.json` shape, scripts, tsdown config via `@internal/tsdown-config`,
`type: module`, private).

```
packages/1-prisma-cloud/2-shared-modules/email/
├── package.json
├── README.md
├── tsdown.config.ts
├── tsconfig.json
└── src/
    ├── contract.ts              # contracts, schemas, defineTemplates, emailSender
    ├── email-module.ts          # email() module factory
    ├── email-service.ts         # emailService() compute definition
    ├── handlers.ts              # serve() handler map (send, getEmail, listEmails)
    ├── outbox-store.ts          # OutboxStore interface + row types + cursor codec
    ├── pg-outbox-store.ts       # Postgres store (DDL at connect, storage's pattern)
    ├── memory-outbox-store.ts   # in-memory store for tests / local server
    ├── delivery.ts              # Delivery interface + retry/timeout policy
    ├── delivery-resend.ts       # Resend HTTP backing
    ├── delivery-smtp.ts         # nodemailer backing
    ├── execution/
    │   ├── email-entrypoint.ts  # boots serve() (mirror storage's entrypoint)
    │   └── testing.ts           # startLocalEmailServer
    ├── exports/
    │   ├── index.ts             # authoring barrel: contract.ts + email-module.ts
    │   ├── email-service.ts
    │   ├── email-entrypoint.ts
    │   └── testing.ts
    └── __tests__/               # see Test plan
```

`package.json` `exports` map: `.`, `./email-service`, `./email-entrypoint`,
`./testing`, `./package.json` — same shape as storage's. Dependencies:
`@internal/core`, `@internal/node`, `@internal/prisma-cloud`,
`@internal/service-rpc`, `@internal/storage`-style workspace refs as needed,
`arktype`, and `nodemailer` (+ `@types/nodemailer` in devDependencies).
`nodemailer` is imported **only** from `delivery-smtp.ts` (execution plane);
it must never be reachable from the authoring barrel.

Public surface: add a `./email` entrypoint to `@prisma/composer-prisma-cloud`
in `packages/9-public/`, re-exporting `src/exports/index.ts` — copy exactly
how `./storage` and `./streams` are wired there (package.json exports,
tsdown entry, and the re-export file). Same for `./email/testing`,
`./email/email-service`, `./email/email-entrypoint` if and only if storage
exposes the analogous ones publicly — match storage's public surface
one-for-one.

Follow `.agents/rules/` (notably exports-entrypoint placement, no bare
casts, tsdown package-source-only) and `gotchas.md`.

## Public API — exact signatures

All in `src/contract.ts` unless noted. arktype only — never Zod.

### Template definitions

```ts
import { type Type, type } from 'arktype';

/** What a template's render produces. `text` optional; html required. */
export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text?: string;
}

export interface TemplateDef<D> {
  readonly data: Type<D>;
  readonly render: (data: D) => RenderedEmail | Promise<RenderedEmail>;
}

export type TemplateDefs = Record<string, TemplateDef<never>>;

/** Identity helper that preserves literal keys and each def's data type. */
export function defineTemplates<const T extends { [K in keyof T]: TemplateDef<any> }>(defs: T): T;
```

`defineTemplates` performs no validation and no transformation; it exists to
infer `T` with literal keys (the `defineSchedule` pattern,
`packages/1-prisma-cloud/2-shared-modules/cron/src/schedule.ts`). If the
`any` in the constraint fights the no-bare-casts/lint rules, use the repo's
sanctioned variance idiom — but the call-site inference behavior above is
non-negotiable: `defineTemplates({ verification: { data: type({ link: 'string' }), render } })`
must produce per-key `data` types without annotations.

`render` may be synchronous or async — the sender method awaits its result.
*(Amended 2026-07-22: originally sync-only; react-email's and jsx-email's
`render()` are async, so the sync-only signature forced consumers to
pre-render outside the template. Widening is backward-compatible.)* We
neither depend on nor mention react-email in module code; the README shows
the integration, and the example app demonstrates it (its `welcome`
template is a react-email component, while `verification` stays a plain
function — the two authoring styles side by side).

### Wire contracts

```ts
import { contract, rpc } from '@internal/service-rpc';
```

Method names are unique across both contracts because `serve()` flattens all
ports into one method namespace (see
`packages/0-framework/2-authoring/service-rpc/src/serve.ts` method table).

```ts
const emailStatus = type("'stored'|'queued'|'sent'|'failed'");

const sendInput = type({
  templateId: 'string',
  to: 'string[]',            // 1–50 entries; enforce via arktype bounds
  'cc?': 'string[]',
  'bcc?': 'string[]',
  'replyTo?': 'string',
  subject: 'string',
  html: 'string',
  'text?': 'string',
  idempotencyKey: 'string',  // 1–256 chars (Resend's accepted range)
});

const sendResult = type({
  id: 'string',              // outbox row id (uuid)
  status: emailStatus,
  'error?': 'string',
});

export const emailSendContract = contract({
  send: rpc({ input: sendInput, output: sendResult }),
});

const emailRecord = type({
  id: 'string',
  templateId: 'string',
  to: 'string[]',
  cc: 'string[]',
  bcc: 'string[]',
  replyTo: 'string | null',
  from: 'string',
  subject: 'string',
  html: 'string',
  text: 'string | null',
  status: emailStatus,
  providerMessageId: 'string | null',
  error: 'string | null',
  attempts: 'number',
  createdAt: 'string',       // ISO-8601 UTC
  updatedAt: 'string',
});

export const emailOutboxContract = contract({
  getEmail: rpc({
    input: type({ id: 'string' }),
    output: type({ email: emailRecord.or('null') }),
  }),
  listEmails: rpc({
    input: type({
      'to?': 'string',        // exact match against any entry in to_addrs
      'templateId?': 'string',
      'status?': emailStatus,
      'cursor?': 'string',
      'limit?': 'number',     // integer 1–200; default 50
    }),
    output: type({
      emails: emailRecord.array(),
      'nextCursor?': 'string',
    }),
  }),
});
```

Notes, all binding:

- `status` includes `'queued'` from day one. V1's synchronous path never
  *returns* it from `send` (rows pass through `queued` transiently), but a
  `listEmails` caller can observe it mid-flight, and the future
  relay-from-outbox delivery mode returns it without a contract change.
- `getEmail` of an unknown id returns `{ email: null }` — never an rpc
  error.
- `listEmails` orders newest-first (`created_at desc, id desc`), keyset
  pagination. `nextCursor` present iff more rows exist. The cursor is an
  opaque string: `base64(createdAtISO + '|' + id)`; the codec lives in
  `outbox-store.ts` and is not documented to consumers as parseable.
- `from` is not in `sendInput`. The sender address is module config (one
  sender per module instance); a template cannot override it in v1.

### Consumer dependency factories

```ts
/** Per-template send methods over the send port. */
export function emailSender<T extends TemplateDefs>(
  templates: T,
): DependencyEnd<EmailSender<T>, typeof emailSendContract>;

export type EmailSender<T extends TemplateDefs> = {
  readonly [K in keyof T]: (input: {
    readonly to: string | readonly string[];
    readonly data: T[K] extends TemplateDef<infer D> ? D : never;
    readonly cc?: readonly string[] | undefined;
    readonly bcc?: readonly string[] | undefined;
    readonly replyTo?: string | undefined;
    readonly idempotencyKey?: string | undefined;
  }) => Promise<{ id: string; status: 'stored' | 'queued' | 'sent' | 'failed'; error?: string }>;
};
```

Mechanism (mirror `durableStreams(contract)` in
`packages/1-prisma-cloud/2-shared-modules/streams/src/contract.ts` and the
`rpc(contract)` dependency in `service-rpc/src/rpc.ts`):

- Connection params and hydration reuse service-rpc's exactly: `url` plus
  the `serviceKey` param carrying the ADR-0030/0031 per-binding provisioning
  need (`perBindingToken()`). Do not invent a parallel channel — build the
  `DependencyEnd` the same way `rpc(emailSendContract)` would, then wrap.
- `hydrate` builds `makeClient(emailSendContract, url, { serviceKey })`
  once, then one method per `Object.keys(templates)`. Each method:
  1. Validates `input.data` with `templates[k].data`. On failure, throw
     `new Error(` + `` `email.${k}(): data does not match the template schema: ${summary}` `` + `)`
     where `summary` is arktype's problem summary. Validation happens before
     any network call.
  2. Calls `templates[k].render(validatedData)`.
  3. Normalizes `to` to an array; rejects an empty array with
     `` `email.${k}(): "to" must contain at least one recipient.` ``
  4. Uses `input.idempotencyKey` if provided, else `crypto.randomUUID()`.
  5. Calls the generic `send` op with
     `{ templateId: k, to, cc, bcc, replyTo, ...rendered, idempotencyKey }`
     and returns its result unchanged.
- `required` is `emailSendContract` (identity-satisfied).
- Optional input fields accept explicit `undefined` (`?: string |
  undefined`), so a caller under `exactOptionalPropertyTypes` can pass a
  maybe-undefined value directly instead of conditionally spreading it.
  Absent and `undefined` mean the same thing everywhere. *(Amended
  2026-07-22: the first consumer needed six conditional spreads without
  this.)*

The outbox port needs no custom factory: consumers declare
`deps: { outbox: rpc(emailOutboxContract) }` and get the generated client.
Do not add an `emailOutbox()` wrapper.

### Service definition — `src/email-service.ts`

```ts
import { compute, param, postgres, secret, string } from /* per repo conventions */;

const deliveryModeSchema = type("'resend'|'smtp'|'none'");

export function emailService(opts?: { deliveryUrl?: string }): /* ServiceNode */ {
  return compute({
    name: 'email',
    deps: { db: postgres() },
    params: {
      deliveryMode: param(deliveryModeSchema),
      deliveryUrl: string({ default: opts?.deliveryUrl ?? 'https://api.resend.com' }),
      from: string(),
    },
    secrets: { deliveryCredential: secret() },
    expose: { send: emailSendContract, outbox: emailOutboxContract },
    build: node({ module: import.meta.url, entry: '../dist/email-entrypoint.mjs' }),
  });
}
```

Match the `build`/entry mechanics to storage's service file exactly
(`storage/src/storage-service.ts`) — path shape, `node()` usage, and any
descriptor details are copied, not re-derived.

### Module factory — `src/email-module.ts`

```ts
export function email(opts?: { name?: string; deliveryUrl?: string }): ModuleNode<...> {
  return module(
    opts?.name ?? 'email',
    {
      params: { deliveryMode: paramNeed(), from: paramNeed() },
      secrets: { deliveryCredential: secret() },
      expose: { send: emailSendContract, outbox: emailOutboxContract },
    },
    ({ params, secrets, provision }) => {
      const db = provision(postgres({ name: 'db' }), { id: 'db' });
      const service = provision(emailService({ deliveryUrl: opts?.deliveryUrl }), {
        id: 'service',
        deps: { db },
        params: { deliveryMode: params.deliveryMode, from: params.from },
        secrets: { deliveryCredential: secrets.deliveryCredential },
      });
      return { send: service.send, outbox: service.outbox };
    },
  );
}
```

Pinned consequences:

- `deliveryMode` and `from` are **module-boundary param slots**: the app
  must bind sources (in practice `envParam(...)`), so both vary per stage.
  This is the first shipped module to use boundary params — the capability
  exists and is tested in core (`core/src/__tests__/params.test.ts`); if it
  breaks in practice, that is a framework bug to fix, not a reason to
  reshape this module.
- `deliveryUrl` is a **factory option**, static per app (default
  `https://api.resend.com`). Rationale: a boundary slot admits only sources
  (never literals), which would force every app to create a platform env var
  for a value that is almost always static; and the URL follows the mode,
  which already varies per stage.
- This module is the first shipped **multi-port** node. `provision(email())`
  hands back `{ send, outbox }` ref-ports; core supports this
  (`ProvisionedRef<E>`), no special handling needed.
- The db is invisible to consumers, exactly like storage's.

### Wiring example (goes in the README verbatim)

```ts
// app root
import { email, emailOutboxContract } from '@prisma/composer-prisma-cloud/email';
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

// consumer service
const templates = defineTemplates({
  verification: {
    data: type({ link: 'string' }),
    render: ({ link }) => ({
      subject: 'Verify your email',
      html: `<p><a href="${link}">Verify</a></p>`,
      text: `Verify: ${link}`,
    }),
  },
});
export default compute({ deps: { email: emailSender(templates) }, /* … */ });

// consumer server
const { email } = service.load();
await email.verification({ to: user.email, data: { link } });
```

Platform env vars the app sets per stage (README documents this table):

| Var | Production | Preview |
|---|---|---|
| `EMAIL_DELIVERY_MODE` | `resend` (or `smtp`) | `none` |
| `EMAIL_FROM` | `noreply@myapp.com` | anything (unused when `none`) |
| `EMAIL_DELIVERY_CREDENTIAL` | Resend API key / SMTP password | **any non-empty junk** — required by preflight even though never read (ADR-0029 has no optional secret) |

The junk-credential row is the accepted wart (D8). The README states it
plainly; the friction log entry is part of this project's deliverables.

## Service behavior — exact semantics

### Boot

Entrypoint (`execution/email-entrypoint.ts`) mirrors storage's: construct
the pg outbox store from the hydrated `db` binding, build the delivery
backing from `config()` + `secrets()`, and serve `handlers.ts`'s map via
`serve(emailService(...), handlers)`. Store DDL runs idempotently at first
connect behind the same cold-start retry storage uses
(`storage/src/pg-store.ts` pattern), `max: 1` connection semantics copied
from storage unless storage itself differs — copy, don't re-derive.

Backing selection is a switch on `deliveryMode` at boot: `resend` →
`delivery-resend.ts`, `smtp` → `delivery-smtp.ts`, `none` → no backing.
`deliveryCredential` is read (it always exists — D8) but only `.expose()`d
inside the two real backings.

### DDL — `pg-outbox-store.ts`

```sql
create table if not exists emails (
  id uuid primary key,
  template_id text not null,
  to_addrs text[] not null,
  cc_addrs text[] not null default '{}',
  bcc_addrs text[] not null default '{}',
  reply_to text,
  from_addr text not null,
  subject text not null,
  html text not null,
  text text,
  status text not null check (status in ('stored','queued','sent','failed')),
  provider_message_id text,
  error text,
  idempotency_key text not null unique,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists emails_created_at_id_idx on emails (created_at desc, id desc);
```

### `send` handler

1. Input is already schema-validated by `serve()`.
2. `id = crypto.randomUUID()`.
3. Insert the row with `on conflict (idempotency_key) do nothing`:
   - mode `none`: status `'stored'`.
   - mode `resend`/`smtp`: status `'queued'`.
4. If the insert affected 0 rows (conflict): select the existing row by
   `idempotency_key` and return `{ id, status, error? }` from it. **No
   delivery attempt.** This is the durable dedup (D10) — it applies across
   instances and restarts, unlike service-rpc's in-memory replay LRU, and it
   intentionally does not compare payloads (same key + different payload
   returns the original row; the README documents this as
   "idempotency keys must be unique per logical send").
5. Mode `none`: return `{ id, status: 'stored' }`. Done.
6. Otherwise attempt delivery (policy below), then update the row:
   `status = 'sent'` + `provider_message_id`, or `status = 'failed'` +
   `error` (a single human-readable string: provider status + provider
   error name/message when available). `attempts` increases by the
   invocation's reported try count; `updated_at = now()`. Timestamps are
   written truncated to milliseconds (`date_trunc('milliseconds', now())`
   at insert/update) so cursor comparisons survive the JS `Date`
   round-trip while `listEmails` still uses the raw-column index.
   *(Amended 2026-07-21 during D2 review.)*
7. Return `{ id, status, error? }`. `send` never throws for a delivery
   failure — failure is data. It throws (rpc error) only for transport /
   validation / database errors.

### Delivery policy — `delivery.ts`

Shared by both backings, pinned:

- Per-attempt timeout: **10 s** (`AbortSignal.timeout(10_000)`).
- Attempts: **up to 3** (1 initial + 2 retries). Delays between attempts:
  **500 ms, then 2000 ms**, no jitter.
- Retry on: thrown/network errors, HTTP 429, HTTP 5xx (Resend); connection
  and 4xx-temporary (421/450/451/452) SMTP errors.
- Fail immediately (no retry) on: any other HTTP 4xx (Resend); SMTP
  permanent 5xx rejections.
- The `Delivery` interface:
  `deliver(row): Promise<{ ok: true; providerMessageId: string | null; attempts: number } | { ok: false; error: string; attempts: number }>` —
  retries live inside the shared policy wrapper, not per backing; `attempts`
  is the number of provider tries this invocation made (1–3 under the
  policy above). *(Amended 2026-07-21 during D2 review: the original
  interface carried no attempt count, contradicting step 6's "records the
  count made". The row accumulates each invocation's `attempts`, so a
  future redelivery from the outbox adds its tries to the total.)*

### Resend backing — `delivery-resend.ts`

- `POST {deliveryUrl}/emails` with headers
  `Authorization: Bearer {credential}`, `Content-Type: application/json`,
  `Idempotency-Key: {row.idempotency_key}`.
- Body: `{ from, to, cc?, bcc?, reply_to?, subject, html, text? }` — omit
  empty optional fields entirely (do not send `[]`/`null`).
- 2xx → `providerMessageId = body.id`.
- Resend's error body is `{ statusCode, name, message }`; the stored
  `error` string is `` `resend ${status} ${name}: ${message}` `` (fall back
  to raw body text if unparseable).
- 409 `invalid_idempotent_request` / `concurrent_idempotent_requests`:
  treat as immediate failure with that error string (our own row-level dedup
  should make these unreachable; if seen, something is wrong — surface it,
  don't mask it).

### SMTP backing — `delivery-smtp.ts`

- nodemailer transport constructed from `deliveryUrl` (`smtp://` or
  `smtps://`; port from the URL; username from the URL userinfo if present;
  password = the credential). No other transport options.
- `sendMail({ from, to, cc, bcc, replyTo, subject, html, text })`.
- Resolved → `providerMessageId = info.messageId ?? null`. SMTP gives
  submission-accept only; `'sent'` here means "accepted by the relay" — the
  README states this limitation verbatim.
- Stored error string for a protocol rejection:
  `` `smtp ${responseCode}: ${message}` ``. A connection failure (no
  response code) takes the thrown-error path and stores the raw error
  message with no `smtp` prefix — same as a Resend network error.
  *(Amended 2026-07-21 during D3 review: the format was unpinned; it is
  outbox-visible production surface, so it is pinned like Resend's.)*

### `getEmail` / `listEmails` handlers

Straight store reads per the contract semantics above. `listEmails` filters
combine with AND; `to` matches `$1 = any(to_addrs)`. `limit` outside 1–200
is a validation error (enforce in the arktype schema, not handler code).

## Local dev & testing surface — `execution/testing.ts`

```ts
export interface LocalEmailServer {
  readonly url: string;
  stop(): Promise<void>;
}
export function startLocalEmailServer(opts?: { port?: number }): Promise<LocalEmailServer>;
```

Boots the same `handlers.ts` over the in-memory store with
`deliveryMode: 'none'`, no auth (the serve() accepted-keys pass-through when
the env set is absent), loopback only. Mirror
`streams/src/execution/testing.ts` for shape and option handling. Exported
only via `./testing` — never from the authoring barrel.

`memory-outbox-store.ts` implements the same `OutboxStore` interface as the
pg store and is the store under unit tests.

## Example app + smoke harness

`examples/email/`, mirroring `examples/storage`'s layout: a root module
provisioning `email()` plus one consumer service that tells a real app's
story — email sent as part of a business action, not an HTTP proxy over the
module's API. *(Amended 2026-07-22, Will: the first cut re-exposed the
module's send/outbox operations as generic HTTP routes; that demonstrates
plumbing, not usage.)* The consumer's surface:

- `POST /signup { email, name }` — the business action: record the user
  (in-memory suffices), mint a token, send the `verification` template with
  a `/verify?token=...` link built from the request's own origin. Responds
  with the send result's `id`.
- `GET /verify?token=...` — completes the story: following the link from
  the rendered email marks the user verified.
- `GET /emails/:id` — demo-only read-by-id through the `outbox` dependency,
  with a one-line comment that a real app guards or omits this. No list
  proxy, no filter/cursor/limit query parsing.
- Request bodies validated with arktype (`type({ email: 'string', name:
  'string' })`), never hand-written type guards.

The `welcome` template remains declared (two templates exercise
`defineTemplates`' shape) and is sent on successful verification. Tests:

1. Local: against `startLocalEmailServer` — the full signup loop: signup →
   read the stored verification email by id → extract the rendered link →
   follow it → verified → welcome email stored. (Dedup stays a module-test
   concern, not an example test.)
2. Deploy smoke (the `examples/smoke` harness pattern, creds via the
   gitignored root `.env`): deploy with `EMAIL_DELIVERY_MODE=none` and junk
   credential; run the same signup loop against the deployed app. This
   proves the preview-stage story — including the rendered link working —
   end to end without a Resend account.
3. Optional manual (documented, not CI): flip the stage to `resend` with a
   real key and send to a real address.

## Test plan (module package)

| File | Proves |
|---|---|
| `__tests__/contract.test-d.ts` | `defineTemplates` infers literal keys + per-template data types; `EmailSender<T>` method shapes; wrong `data` fails compilation |
| `__tests__/contract.test.ts` | schema acceptance/rejection at every bound (to 1–50, key 1–256, limit 1–200); status enum |
| `__tests__/module.test.ts` / `module.test-d.ts` | Load succeeds; boundary slots forward; two ports wire independently; db invisible (mirror storage's module tests) |
| `__tests__/handlers.test.ts` | send flow against memory store: stored mode, dedup-on-conflict returns the original row without re-delivery, failure recorded as data, getEmail null, list filters + keyset pagination order and cursor round-trip |
| `__tests__/delivery-resend.test.ts` | against a local fake HTTP endpoint: header set (auth, idempotency), body shape, omit-empty-optionals, retry on 429/5xx/network with pinned delays (fake timers), no retry on 4xx, error-string format |
| `__tests__/delivery-smtp.test.ts` | URL → transport mapping (host/port/user/secure), password from credential, sendMail arg shape; a lightweight local SMTP capture (nodemailer's stream transport or a loopback server) rather than a live relay |
| `__tests__/pg-outbox-store.integration.test.ts` | DDL idempotence, unique-key conflict path, array filters, pagination — against local Postgres via the repo's pg harness pattern |

Follow `.agents/rules/test-import-patterns.mdc` for import idioms.

## README — required contents

Contract scope (both ports, all ops), the wiring example above, the
env-var-per-stage table including the junk-credential wart, delivery
policy (attempts/timeouts), SMTP "accepted ≠ delivered" caveat, idempotency
semantics ("unique per logical send; conflicting payload returns the
original"), the 1 MiB / no-attachments envelope, `deliveryUrl` default and
how tests point it at a fake, local-dev usage of `startLocalEmailServer`,
and the statement that bodies are stored unredacted forever in v1 (D11).
Terse, factual, no strategy content.

## Non-goals (v1)

- Attachments, cc/bcc size games, per-send `from` override.
- Batch send, scheduled send, Resend webhooks, post-submission delivery
  status polling (`GET /emails/{id}`), open/click tracking.
- Queue-backed / async delivery (the outbox-first design is the seam; a
  relay draining `queued` rows is a later slice — no contract change).
- Retention, redaction, or deletion of stored bodies.
- An admin UI (the outbox contract is designed for one; building it is not
  this project).
- Optional/conditional secrets in the framework (D8 files the friction
  finding instead).
- react-email as a dependency (compatible via `render`, nothing more).
- Any change to `serve()` to namespace ports (unique method names suffice).

## Friction findings to record (deliverables alongside the code)

1. **No optional/conditional secrets** (ADR-0029): stages with
   `deliveryMode=none` must set a junk `EMAIL_DELIVERY_CREDENTIAL`. File in
   the friction log / gotchas per repo practice, referencing this spec's D8.
2. **Module-boundary param slots admit only sources** — a static-per-app
   value on a module boundary either becomes a platform env var or a factory
   option; record if this bites during implementation.
3. Anything else the first multi-port `serve()`/wiring surfaces.

## Acceptance criteria

1. `@internal/email` builds, typechecks, lints, and passes the test plan;
   repo-wide checks (dependency-cruiser layering, rules lint) pass.
2. `@prisma/composer-prisma-cloud/email` public entrypoint exports exactly:
   `email`, `emailService` (via its subpath), `defineTemplates`,
   `emailSender`, `emailSendContract`, `emailOutboxContract`, and the types
   named in this spec — nothing more.
3. `examples/email` local tests pass with no cloud credentials.
4. The deploy smoke passes against real Prisma Cloud in `none` mode: send →
   outbox read-back of the stored body.
5. A manual `resend`-mode send with a real key delivers (documented run,
   not CI).
6. README complete per the section above; friction findings filed.

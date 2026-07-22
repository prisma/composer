/**
 * The Resend HTTP backing (spec §"Resend backing"): `POST {deliveryUrl}/emails`,
 * classified for the shared retry policy in `delivery.ts`. Retryable: 429 and
 * 5xx. Not retryable: every other 4xx, including Resend's own 409 idempotency
 * conflicts (our row-level dedup should make those unreachable — surfaced as
 * a failure, not masked, if one is ever seen).
 *
 * Runtime engine code (`fetch`); NOT re-exported from the authoring barrel.
 */
import type { SecretString } from '@internal/foundation/secret';
import type { Attempt, AttemptOutcome, Delivery, RetryPolicyOptions } from './delivery.ts';
import { withRetryPolicy } from './delivery.ts';
import type { EmailRow } from './outbox-store.ts';

interface ResendErrorBody {
  readonly statusCode?: number;
  readonly name?: string;
  readonly message?: string;
}

function isResendErrorBody(value: unknown): value is ResendErrorBody {
  return typeof value === 'object' && value !== null;
}

interface ResendSendResult {
  readonly id: string;
}

function isResendSendResult(value: unknown): value is ResendSendResult {
  return (
    typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'
  );
}

/** Omits empty optional fields entirely rather than sending `[]`/`null` (spec). */
function buildBody(row: EmailRow): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from: row.from,
    to: [...row.to],
    subject: row.subject,
    html: row.html,
  };
  if (row.cc.length > 0) body['cc'] = [...row.cc];
  if (row.bcc.length > 0) body['bcc'] = [...row.bcc];
  if (row.replyTo !== null) body['reply_to'] = row.replyTo;
  if (row.text !== null) body['text'] = row.text;
  return body;
}

/** `resend <status> <name>: <message>` from the parsed error body; falls back to the raw response text if it doesn't parse as Resend's error shape. */
async function describeError(response: Response): Promise<string> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `resend ${response.status}: ${text}`;
  }
  if (isResendErrorBody(parsed) && parsed.name !== undefined && parsed.message !== undefined) {
    return `resend ${response.status} ${parsed.name}: ${parsed.message}`;
  }
  return `resend ${response.status}: ${text}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function resendAttempt(deliveryUrl: string, credential: SecretString): Attempt {
  return async (row, signal): Promise<AttemptOutcome> => {
    const response = await fetch(`${deliveryUrl}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.expose()}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': row.idempotencyKey,
      },
      body: JSON.stringify(buildBody(row)),
      signal,
    });

    if (response.ok) {
      const body: unknown = await response.json();
      if (!isResendSendResult(body)) {
        throw new Error('resend: 2xx response body did not include a string "id"');
      }
      return { ok: true, providerMessageId: body.id };
    }

    return {
      ok: false,
      error: await describeError(response),
      retryable: isRetryableStatus(response.status),
    };
  };
}

export function createResendDelivery(opts: {
  readonly deliveryUrl: string;
  readonly credential: SecretString;
  /** Overrides the shared retry policy's defaults — for tests only; production callers omit this. */
  readonly retryPolicy?: RetryPolicyOptions;
}): Delivery {
  return withRetryPolicy(resendAttempt(opts.deliveryUrl, opts.credential), opts.retryPolicy);
}

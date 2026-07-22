/**
 * The SMTP backing (spec §"SMTP backing"): a nodemailer transport built from
 * `deliveryUrl` alone (`smtp://`/`smtps://`; port and username from the URL,
 * password from the credential — no other transport options), classified for
 * the shared retry policy in `delivery.ts`. Retryable: connection errors (no
 * SMTP response code — these throw, which the policy always retries) and the
 * 4xx-temporary codes 421/450/451/452. Not retryable: every other response
 * code, including permanent 5xx rejections.
 *
 * `'sent'` here means "accepted by the relay", not "delivered" — SMTP gives
 * no delivery confirmation.
 *
 * Runtime engine code (`nodemailer`; the only file in this package that
 * imports it); NOT re-exported from the authoring barrel.
 */
import type { SecretString } from '@internal/foundation/secret';
import nodemailer from 'nodemailer';
import type { Attempt, AttemptOutcome, Delivery, RetryPolicyOptions } from './delivery.ts';
import { raceWithSignal, withRetryPolicy } from './delivery.ts';
import type { EmailRow } from './outbox-store.ts';

const RETRYABLE_RESPONSE_CODES = new Set([421, 450, 451, 452]);

interface SmtpProtocolError {
  readonly responseCode: number;
  readonly message: string;
}

/** Nodemailer's SMTP-level rejections carry `responseCode`; a connection failure (DNS, refused, timeout) does not — the caller lets those propagate so the shared policy's catch-all retries them. */
function isSmtpProtocolError(error: unknown): error is SmtpProtocolError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'responseCode' in error &&
    typeof error.responseCode === 'number'
  );
}

/** Exported for direct unit testing of the URL→transport mapping. */
export function transportOptionsFrom(
  deliveryUrl: string,
  credential: SecretString,
): {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly auth?: { readonly user: string; readonly pass: string };
} {
  const url = new URL(deliveryUrl);
  const secure = url.protocol === 'smtps:';
  const port = url.port !== '' ? Number(url.port) : secure ? 465 : 587;
  const auth =
    url.username !== ''
      ? { user: decodeURIComponent(url.username), pass: credential.expose() }
      : undefined;
  return { host: url.hostname, port, secure, ...(auth !== undefined ? { auth } : {}) };
}

/** Exported for direct unit testing of the row→sendMail field mapping. */
export function toMailOptions(row: EmailRow): {
  readonly from: string;
  readonly to: string[];
  readonly cc: string[];
  readonly bcc: string[];
  readonly replyTo?: string;
  readonly subject: string;
  readonly html: string;
  readonly text?: string;
} {
  return {
    from: row.from,
    to: [...row.to],
    cc: [...row.cc],
    bcc: [...row.bcc],
    ...(row.replyTo !== null ? { replyTo: row.replyTo } : {}),
    subject: row.subject,
    html: row.html,
    ...(row.text !== null ? { text: row.text } : {}),
  };
}

function smtpAttempt(deliveryUrl: string, credential: SecretString): Attempt {
  const transporter = nodemailer.createTransport(transportOptionsFrom(deliveryUrl, credential));

  return async (row, signal): Promise<AttemptOutcome> => {
    try {
      // raceWithSignal only stops WAITING on sendMail — it does not cancel
      // the in-flight SMTP transaction with the relay. If the per-attempt
      // timeout fires, the shared policy retries (a thrown error, always
      // retryable), but the first attempt's message can still be accepted
      // by a slow relay after the retry has already started: a timeout can
      // duplicate a send. See the README's SMTP caveat.
      const info: { messageId?: string } = await raceWithSignal(
        transporter.sendMail(toMailOptions(row)),
        signal,
      );
      return { ok: true, providerMessageId: info.messageId ?? null };
    } catch (error) {
      if (!isSmtpProtocolError(error)) throw error; // connection/timeout — policy retries thrown errors.
      return {
        ok: false,
        error: `smtp ${error.responseCode}: ${error.message}`,
        retryable: RETRYABLE_RESPONSE_CODES.has(error.responseCode),
      };
    }
  };
}

export function createSmtpDelivery(opts: {
  readonly deliveryUrl: string;
  readonly credential: SecretString;
  /** Overrides the shared retry policy's defaults — for tests only; production callers omit this. */
  readonly retryPolicy?: RetryPolicyOptions;
}): Delivery {
  return withRetryPolicy(smtpAttempt(opts.deliveryUrl, opts.credential), opts.retryPolicy);
}

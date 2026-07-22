/**
 * `checkDeliveryUrl`: mode `smtp` requires an smtp(s):// URL, mode `resend`
 * requires an http(s):// URL — pure, so no boot/service required to test.
 */
import { describe, expect, test } from 'bun:test';
import { checkDeliveryUrl } from '../execution/check-delivery-url.ts';

describe('checkDeliveryUrl', () => {
  test('mode smtp rejects the Resend default URL, naming the mode and the URL', () => {
    const error = checkDeliveryUrl('smtp', 'https://api.resend.com');
    expect(error).toContain('"smtp"');
    expect(error).toContain('https://api.resend.com');
  });

  test('mode smtp accepts smtp:// and smtps://', () => {
    expect(checkDeliveryUrl('smtp', 'smtp://mail.example.com:587')).toBeNull();
    expect(checkDeliveryUrl('smtp', 'smtps://mail.example.com:465')).toBeNull();
  });

  test('mode resend rejects an SMTP URL, naming the mode and the URL', () => {
    const error = checkDeliveryUrl('resend', 'smtp://mail.example.com');
    expect(error).toContain('"resend"');
    expect(error).toContain('smtp://mail.example.com');
  });

  test('mode resend accepts http:// and https://', () => {
    expect(checkDeliveryUrl('resend', 'https://api.resend.com')).toBeNull();
    expect(checkDeliveryUrl('resend', 'http://localhost:4010')).toBeNull();
  });

  test('mode none is never checked — deliveryUrl is unused', () => {
    expect(checkDeliveryUrl('none', 'not-a-url-at-all')).toBeNull();
  });
});

/**
 * Boot-time check: `deliveryMode` and `deliveryUrl` must agree on scheme —
 * `smtp:`/`smtps:` for mode `smtp`, `http:`/`https:` for mode `resend`.
 * `deliveryUrl` is a factory option, not a param (spec's recorded
 * decision — it stays static per app), so nothing validates it against the
 * per-stage `deliveryMode` before the first send silently fails against the
 * wrong protocol. Pure so it's unit-testable without booting the service.
 */
export function checkDeliveryUrl(
  deliveryMode: 'resend' | 'smtp' | 'none',
  deliveryUrl: string,
): string | null {
  if (deliveryMode === 'smtp' && !/^smtps?:\/\//.test(deliveryUrl)) {
    return `email: deliveryMode "smtp" requires an smtp:// or smtps:// deliveryUrl, got "${deliveryUrl}".`;
  }
  if (deliveryMode === 'resend' && !/^https?:\/\//.test(deliveryUrl)) {
    return `email: deliveryMode "resend" requires an http:// or https:// deliveryUrl, got "${deliveryUrl}".`;
  }
  return null;
}

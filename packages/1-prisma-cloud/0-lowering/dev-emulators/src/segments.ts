/**
 * API hygiene shared by both daemons (local-dev spec § 2): every `<app>`,
 * `<id>`, and `<name>` path segment must match this shape or the request is
 * a 400 naming the segment.
 */
export const SEGMENT_RE = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_SEGMENT_LENGTH = 63;

export function isValidSegment(segment: string): boolean {
  return segment.length <= MAX_SEGMENT_LENGTH && SEGMENT_RE.test(segment);
}

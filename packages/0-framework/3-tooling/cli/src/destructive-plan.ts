import * as fs from 'node:fs';
import type { DestructivePlan } from '@internal/core/config';
import { blindCast } from '@internal/foundation/casts';

/** Read the child guard's public report; malformed reports can never authorize a deploy. */
export function readDestructivePlan(file: string): DestructivePlan {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const record = (entry: unknown): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null;
  if (
    !record(value) ||
    typeof value['token'] !== 'string' ||
    !/^remove-[a-f0-9]{64}$/.test(value['token']) ||
    !Array.isArray(value['scopes']) ||
    !value['scopes'].every(
      (scope: unknown) =>
        record(scope) &&
        (scope['application'] === undefined || typeof scope['application'] === 'string') &&
        typeof scope['id'] === 'string' &&
        typeof scope['label'] === 'string' &&
        typeof scope['removalConsequence'] === 'string',
    ) ||
    !Array.isArray(value['changes']) ||
    value['changes'].length === 0 ||
    !value['changes'].every(
      (change: unknown) =>
        record(change) &&
        typeof change['resource'] === 'string' &&
        typeof change['type'] === 'string' &&
        (change['action'] === 'delete' || change['action'] === 'replace') &&
        typeof change['consequence'] === 'string',
    )
  ) {
    throw new Error('The deployment engine returned an invalid destructive plan.');
  }
  return blindCast<DestructivePlan, 'all public report fields are validated above'>(value);
}

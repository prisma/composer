import { quotedList } from '@internal/foundation/errors';
import type { ValueReadsChange } from './value-reads-change.ts';

/** Which reads changed, as a clause: `reads of "shop.port" were added and "shop.key" was changed`. */
export function valueReadsChangeText(change: ValueReadsChange): string {
  const clauses = [
    ...(change.added.length > 0 ? [`reads of ${quotedList(change.added)} were added`] : []),
    ...(change.removed.length > 0 ? [`reads of ${quotedList(change.removed)} were removed`] : []),
    ...(change.changed.length > 0
      ? [`${quotedList(change.changed)} ${change.changed.length === 1 ? 'was' : 'were'} changed`]
      : []),
  ];
  const [first, second, third] = clauses;
  return third !== undefined
    ? `${first}, ${second}, and ${third}`
    : second !== undefined
      ? `${first} and ${second}`
      : (first ?? '');
}

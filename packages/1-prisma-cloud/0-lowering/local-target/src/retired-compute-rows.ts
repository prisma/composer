/**
 * `prisma dev` converges against Alchemy's own file store, one JSON file per
 * resource under `.alchemy/state/<app>/<environment>/`. Rows written before
 * upstream renamed `Prisma.App` and `Prisma.Deployment` are rewritten here,
 * before Alchemy reads them, by the same function that rewrites hosted rows:
 * a service and the version attached to it read each other, and the engine
 * hands a saved row to the other one before its provider can rename it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { migrateLegacyResourceState } from '@internal/lowering/state';

const RETIRED_TYPES: ReadonlySet<string> = new Set(['Prisma.App', 'Prisma.Deployment']);

const isRetiredRow = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  'resourceType' in value &&
  typeof value.resourceType === 'string' &&
  RETIRED_TYPES.has(value.resourceType);

/** Rewrites every `Prisma.App` and `Prisma.Deployment` row in one Alchemy stage's folder; does nothing when the folder does not exist. */
export function renameRetiredComputeRows(stageDir: string): void {
  let files: string[];
  try {
    files = fs.readdirSync(stageDir).filter((file) => file.endsWith('.json'));
  } catch {
    return;
  }
  for (const file of files) {
    const location = path.join(stageDir, file);
    const text = fs.readFileSync(location, 'utf8');
    if (text.trim() === '') continue;
    const row: unknown = JSON.parse(text);
    if (!isRetiredRow(row)) continue;
    const staged = `${location}.rename`;
    fs.writeFileSync(staged, `${JSON.stringify(migrateLegacyResourceState(row), null, 2)}\n`);
    fs.renameSync(staged, location);
  }
}

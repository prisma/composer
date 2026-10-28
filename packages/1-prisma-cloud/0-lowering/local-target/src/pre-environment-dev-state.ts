/**
 * Releases before each environment had its own folder kept local dev state
 * directly in `.prisma-composer/dev/`. That state is the environment `dev`'s:
 * the first run after an upgrade moves the record, the environment variable
 * values, the placeholder secrets and the bucket objects into `dev`'s folder,
 * so its databases and objects are kept. Unpacked artifacts and the generated
 * stack file are regenerated, so they are removed instead. Delete this file
 * once no such folder remains.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEV_DIR, DEV_ENVIRONMENT_NAME_FILE, devEnvironmentDir } from '@internal/core/config';
import { BUCKETS_DIR } from './bucket.ts';
import { EMULATOR_INSTANCES_FILE } from './emulator-instances.ts';

const PRE_ENVIRONMENT_ENVIRONMENT = 'dev';
const MOVED = [EMULATOR_INSTANCES_FILE, 'env.json', 'secrets.json', BUCKETS_DIR];
const REMOVED = ['artifacts', 'alchemy.run.ts'];

function isFile(file: string): boolean {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true;
}

/** Moves a pre-environment `.prisma-composer/dev/` in `directory` into the environment `dev`; does nothing for any other folder. */
export function movePreEnvironmentDevState(directory: string): void {
  const root = path.join(directory, DEV_DIR);
  const target = path.join(directory, devEnvironmentDir(PRE_ENVIRONMENT_ENVIRONMENT));
  if (!isFile(path.join(root, EMULATOR_INSTANCES_FILE))) return;
  if (fs.existsSync(path.join(target, EMULATOR_INSTANCES_FILE))) return;
  fs.mkdirSync(target, { recursive: true });
  for (const entry of MOVED) {
    if (fs.existsSync(path.join(root, entry))) {
      fs.renameSync(path.join(root, entry), path.join(target, entry));
    }
  }
  fs.writeFileSync(
    path.join(target, DEV_ENVIRONMENT_NAME_FILE),
    `${PRE_ENVIRONMENT_ENVIRONMENT}\n`,
  );
  for (const entry of REMOVED) {
    fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }
}

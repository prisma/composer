/** Files in `<devDir>/` that concern secret values: the fingerprint key, and the cleanup of the retired value store. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Deletes `<devDir>/secrets.json`, where older versions of `prisma dev` stored secret values in plain text. */
export async function removeRetiredSecretsFile(devDir: string): Promise<void> {
  await fs.rm(path.join(devDir, 'secrets.json'), { force: true });
}

const FINGERPRINT_KEY_BYTES = 32;

function hasCode(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && err.code === code;
}

function keyError(keyPath: string, reason: unknown): Error {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return new Error(
    `prisma dev cannot use its fingerprint key at ${keyPath}: ${detail}. ` +
      'Delete the file or run `prisma dev --fresh`.',
  );
}

/**
 * Reads `<devDir>/fingerprint.key`, the random key `prisma dev` hashes secret
 * values with, or creates it with mode 0600. Creation links a finished file
 * into place, so two first runs agree on one key and no reader sees a partial one.
 */
export async function readOrCreateFingerprintKey(devDir: string): Promise<Uint8Array<ArrayBuffer>> {
  const keyPath = path.join(devDir, 'fingerprint.key');
  await fs.mkdir(devDir, { recursive: true });
  const candidate = crypto.randomBytes(FINGERPRINT_KEY_BYTES);
  const tmpPath = `${keyPath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, candidate, { mode: 0o600 });
    await fs.link(tmpPath, keyPath);
    return new Uint8Array(candidate);
  } catch (err) {
    if (!hasCode(err, 'EEXIST')) throw keyError(keyPath, err);
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
  let existing: Buffer;
  try {
    existing = await fs.readFile(keyPath);
  } catch (err) {
    throw keyError(keyPath, err);
  }
  if (existing.length !== FINGERPRINT_KEY_BYTES) {
    throw keyError(keyPath, `it holds ${existing.length} bytes, not ${FINGERPRINT_KEY_BYTES}`);
  }
  return new Uint8Array(existing);
}

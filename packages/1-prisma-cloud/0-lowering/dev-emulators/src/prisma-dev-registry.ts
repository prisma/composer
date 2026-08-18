/** A parsed value narrowed just enough to index by string key. */
interface StringKeyedRecord {
  readonly [key: string]: unknown;
}

function isStringKeyedRecord(value: unknown): value is StringKeyedRecord {
  return typeof value === 'object' && value !== null;
}

interface ServerStateScanner {
  scan(options: { readonly onlyMetadata: true }): Promise<unknown>;
}

/**
 * `ServerState` is exported by `@prisma/dev` as a class constructor, so its
 * static `scan` method lives on a function at runtime. Accept both that real
 * shape and an object-shaped compatible implementation.
 */
function isServerStateScanner(value: unknown): value is ServerStateScanner {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    'scan' in value &&
    typeof value.scan === 'function'
  );
}

function portOfUrl(value: string): number | undefined {
  try {
    const port = Number(new URL(value).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every port claimed by a persisted `@prisma/dev` server record. This scan
 * is best-effort because it relies on an internal Prisma Dev surface; callers
 * can still fall back to probing the operating system when it is unavailable.
 */
export async function registryClaimedPorts(internalState: unknown): Promise<Set<number>> {
  const ports = new Set<number>();
  const scanHost = isStringKeyedRecord(internalState) ? internalState['ServerState'] : undefined;
  if (!isServerStateScanner(scanHost)) return ports;

  try {
    const records = await scanHost.scan({ onlyMetadata: true });
    if (!Array.isArray(records)) return ports;
    for (const record of records) {
      if (!isStringKeyedRecord(record)) continue;
      for (const key of ['databasePort', 'port', 'shadowDatabasePort', 'streamsPort']) {
        const port = record[key];
        if (typeof port === 'number' && Number.isInteger(port) && port > 0) ports.add(port);
      }
      const experimental = record['experimental'];
      const streams = isStringKeyedRecord(experimental) ? experimental['streams'] : undefined;
      const streamsUrl = isStringKeyedRecord(streams) ? streams['serverUrl'] : undefined;
      if (typeof streamsUrl === 'string') {
        const port = portOfUrl(streamsUrl);
        if (port !== undefined) ports.add(port);
      }
    }
  } catch {
    // Unreadable registry — fall back to the OS probe alone.
  }
  return ports;
}

/** A parsed value narrowed just enough to index into by string key — real narrowing, not a cast: the interface's own index signature is what makes bracket access legal. */
export interface StringKeyedRecord {
  readonly [key: string]: unknown;
}

export function isStringKeyedRecord(value: unknown): value is StringKeyedRecord {
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

/** The port of a URL, when it names one explicitly. */
export function portOfUrl(value: string): number | undefined {
  try {
    const port = Number(new URL(value).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** The slice of `@prisma/dev`'s internal-state module the registry scan reads. */
export interface RegistryScanHost {
  readonly ServerState?: unknown;
}

let scanUnavailableLogged = false;

/**
 * Every port a FOREIGN persisted `@prisma/dev` server record claims. The
 * record named `ownInstanceName` is skipped — `@prisma/dev` exempts a
 * server's own record from port validation and prefers to reuse its ports,
 * so excluding them would move a persisted database off its recorded port.
 * Best-effort: when the internal surface is absent or unreadable this
 * degrades to an empty set (logged, so the degradation is visible), and
 * port picks fall back to the OS probe alone.
 */
export async function registryClaimedPorts(
  internalState: RegistryScanHost,
  ownInstanceName: string,
): Promise<Set<number>> {
  const ports = new Set<number>();
  const scanHost = internalState.ServerState;
  if (!isServerStateScanner(scanHost)) {
    if (!scanUnavailableLogged) {
      scanUnavailableLogged = true;
      console.error(
        'prisma-dev-registry: @prisma/dev exposes no usable ServerState.scan — port picks fall back to the OS probe alone',
      );
    }
    return ports;
  }

  try {
    const records = await scanHost.scan({ onlyMetadata: true });
    if (!Array.isArray(records)) return ports;
    for (const record of records) {
      if (!isStringKeyedRecord(record)) continue;
      if (record['name'] === ownInstanceName) continue;
      for (const key of ['databasePort', 'port', 'shadowDatabasePort']) {
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
  } catch (error) {
    console.error(
      `prisma-dev-registry: failed to read the @prisma/dev server registry — port picks fall back to the OS probe alone (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return ports;
}

/**
 * Temporary: finds the Compute instance that runs a service of the app run
 * from a directory by reading the labels Composer gives the instance when it
 * creates it. The per-directory mapping file replaces this module; Composer
 * must not identify instances by their labels.
 */
import * as path from 'node:path';
import { computeClient, type InstanceInfo } from '@internal/dev-emulators';

/** The app run from the directory that holds `devDir` (`<directory>/.prisma-composer/dev`). */
export interface ServiceInstanceScope {
  readonly devDir: string;
  readonly app: string;
}

const DIRECTORY_LABEL = 'composer.directory';
const APP_LABEL = 'composer.app';
const ADDRESS_LABEL = 'composer.address';

function directoryOf(devDir: string): string {
  return path.resolve(devDir, '..', '..');
}

function belongsTo(instance: InstanceInfo, scope: ServiceInstanceScope): boolean {
  return (
    instance.labels[DIRECTORY_LABEL] === directoryOf(scope.devDir) &&
    instance.labels[APP_LABEL] === scope.app
  );
}

export function serviceAddressOf(instance: InstanceInfo): string {
  return instance.labels[ADDRESS_LABEL] ?? instance.id;
}

export async function appServiceInstances(scope: ServiceInstanceScope): Promise<InstanceInfo[]> {
  const instances = await computeClient().listInstances();
  return instances.filter((instance) => belongsTo(instance, scope));
}

/** The instance that runs `address`, created when there is none. */
export async function ensureServiceInstance(
  scope: ServiceInstanceScope,
  address: string,
): Promise<InstanceInfo> {
  const existing = (await appServiceInstances(scope)).find(
    (instance) => serviceAddressOf(instance) === address,
  );
  if (existing) return existing;
  return computeClient().createInstance({
    labels: {
      [DIRECTORY_LABEL]: directoryOf(scope.devDir),
      [APP_LABEL]: scope.app,
      [ADDRESS_LABEL]: address,
    },
  });
}

export async function deleteAppServiceInstances(scope: ServiceInstanceScope): Promise<void> {
  const client = computeClient();
  for (const instance of await appServiceInstances(scope)) {
    await client.deleteInstance(instance.id);
  }
}

/**
 * The emulator's failure messages name instances by id; `prisma dev` names
 * services by address. Rewrites a plain `Error`'s message and leaves any other
 * error, such as a structured one, untouched.
 */
export function withServiceAddresses(error: unknown, instances: readonly InstanceInfo[]): unknown {
  if (!(error instanceof Error) || error.constructor !== Error) return error;
  let message = error.message;
  for (const instance of instances) {
    message = message.replaceAll(
      `instance "${instance.id}"`,
      `service "${serviceAddressOf(instance)}"`,
    );
  }
  return message === error.message ? error : new Error(message, { cause: error });
}

/**
 * The program `stopAppInstancesBeforeExit` runs: stops one app's recorded
 * service processes and database servers, then exits.
 *
 * Usage: `stop-app-main <devDir> <app> <environment>`.
 */
import { stopAppInstances } from './emulator-instances.ts';

const [devDir, app, environment] = process.argv.slice(2);
if (devDir === undefined || app === undefined || environment === undefined) {
  console.error('stop-app-main: usage: stop-app-main <devDir> <app> <environment>');
  process.exit(2);
}
await stopAppInstances({ devDir, app, environment });

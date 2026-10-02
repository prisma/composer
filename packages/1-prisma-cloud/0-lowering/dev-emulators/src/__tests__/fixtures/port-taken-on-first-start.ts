/**
 * Test fixture: the compute daemon, except that its first start under a
 * given `--state-dir` finds its allocated port taken at bind time, as when
 * a process outside the registry's bookkeeping binds the port between
 * allocation and spawn. That start binds the port itself, records it in
 * `<state-dir>/taken-port`, then runs the daemon, whose own bind fails.
 * Later starts run the daemon unchanged.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

function argValue(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined) throw new Error(`port-taken-on-first-start: missing ${name}`);
  return value;
}

const args = process.argv.slice(2);
const port = Number(argValue(args, '--port'));
const takenPortFile = path.join(argValue(args, '--state-dir'), 'taken-port');

if (!fs.existsSync(takenPortFile)) {
  fs.writeFileSync(takenPortFile, String(port));
  const holder = http.createServer();
  await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', resolve));
}

await import('@internal/dev-emulators/compute-main');

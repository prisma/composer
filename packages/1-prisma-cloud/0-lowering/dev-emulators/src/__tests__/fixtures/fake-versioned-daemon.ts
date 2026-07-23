/**
 * Test fixture: a minimal `/health` responder reporting a caller-chosen
 * version, standing in for a real daemon that was started by an OLDER build
 * of this package — the scenario `ensureDaemon`'s version-skew restart
 * handles. Run standalone via
 * `bun <this file> --port <n> --version <v>`.
 */
import * as http from 'node:http';

function argValue(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined) throw new Error(`fake-versioned-daemon: missing ${name}`);
  return value;
}

const args = process.argv.slice(2);
const port = Number(argValue(args, '--port'));
const version = argValue(args, '--version');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, '127.0.0.1');

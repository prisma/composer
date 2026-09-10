import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const cwd = process.cwd();
const require = createRequire(path.join(cwd, 'package.json'));
const next = process.argv[2] === 'next';
const { assemble } = await import(
  pathToFileURL(require.resolve(`@prisma/composer/${next ? 'nextjs' : 'node'}/control`)).href
);
const module = pathToFileURL(path.join(cwd, 'service.ts')).href;
const build = next
  ? { type: 'nextjs', module, appDir: '.' }
  : { type: 'node', module, entry: './dist/server.mjs' };
const result = await assemble({ build, address: 'app', cwd });
const entry = path.join(result.dir, result.entry);
if (!fs.existsSync(entry)) throw new Error(`Missing assembled entry: ${entry}`);
console.log(JSON.stringify({ assembled: true, entry }));

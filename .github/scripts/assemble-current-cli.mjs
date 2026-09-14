import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const cwd = process.cwd();
const require = createRequire(path.join(cwd, 'package.json'));
const { assemble } = await import(
  pathToFileURL(require.resolve('@prisma/composer/nextjs/control')).href
);
const module = pathToFileURL(path.join(cwd, 'service.ts')).href;
const result = await assemble({ build: { type: 'nextjs', module, appDir: '.' }, address: 'app', cwd });
const entry = path.join(result.dir, result.entry);
if (!fs.existsSync(entry)) throw new Error(`Missing assembled entry: ${entry}`);
console.log(JSON.stringify({ assembled: true, entry }));

#!/usr/bin/env node
/**
 * Fails on any tracked text file that contains a control character other than
 * tab, newline and carriage return (Unicode category Cc: 0x00–0x1F, 0x7F–0x9F).
 * See .agents/rules/no-control-bytes-in-source.mdc.
 *
 * Exits 1 (printing `file:line: <bytes>`) on any finding; else 0. An optional
 * CLI arg overrides the scanned repo root (used by the tests).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BINARY_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|eot|gz|tgz|zip|wasm|pdf|mp4|webm|mov)$/i;
const CONTROL_BYTE = /(?![\t\n\r])\p{Cc}/gu;

export function findControlBytes(root) {
  const files = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file.length > 0 && !BINARY_EXTENSIONS.test(file));
  const findings = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    text.split('\n').forEach((line, index) => {
      const bytes = line.match(CONTROL_BYTE);
      if (bytes !== null) {
        const hex = bytes.map((byte) => `0x${byte.charCodeAt(0).toString(16).padStart(2, '0')}`);
        findings.push(`${file}:${String(index + 1)}: ${hex.join(' ')}`);
      }
    });
  }
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const findings = findControlBytes(root);
  if (findings.length > 0) {
    console.error(
      `Control bytes found (see .agents/rules/no-control-bytes-in-source.mdc):\n${findings.join('\n')}`,
    );
    process.exit(1);
  }
}

// Q3: what each way of reading, comparing or branching on an input field does.
// Run: bun operators.ts   (also: node --experimental-strip-types operators.ts)
import { inspect } from 'node:util';
import { inputValues } from './input-value.ts';

// biome-ignore lint/suspicious/noExplicitAny: the probe deliberately misuses the value in ways its type forbids.
const input: any = inputValues('shop');

class Target {}

const cases: [string, () => unknown][] = [
  ['`${input.from}`', () => `${input.from}`],
  ["'x' + input.from", () => 'x' + input.from],
  ['input.port + 1', () => input.port + 1],
  ['input.port * 2', () => input.port * 2],
  ['input.port < 3', () => input.port < 3],
  ["input.from == 'a'", () => input.from == 'a'],
  ['String(input.from)', () => String(input.from)],
  ['Number(input.port)', () => Number(input.port)],
  ['input.from.toString()', () => input.from.toString()],
  ['JSON.stringify(input)', () => JSON.stringify(input)],
  ['JSON.stringify({ a: input.from })', () => JSON.stringify({ a: input.from })],
  ['Object.keys(input)', () => Object.keys(input)],
  ['Object.entries(input)', () => Object.entries(input)],
  ['{ ...input }', () => ({ ...input })],
  ['Object.assign({}, input)', () => Object.assign({}, input)],
  [
    'for (const k in input)',
    () => {
      for (const k in input) void k;
    },
  ],
  ['[...input.tags]', () => [...input.tags]],
  [
    'for (const t of input.tags)',
    () => {
      for (const t of input.tags) void t;
    },
  ],
  [
    'const [first] = input.tags',
    () => {
      const [first] = input.tags;
      return first;
    },
  ],
  ["'flag' in input", () => 'flag' in input],
  ['input.tags.length > 0', () => input.tags.length > 0],
  ['input.tags.map((t) => t)', () => input.tags.map((t: unknown) => t)],
  ['input.from.toUpperCase()', () => input.from.toUpperCase()],
  [
    'input.from = "x"',
    () => {
      input.from = 'x';
    },
  ],
  ['Object.freeze(input)', () => Object.freeze(input)],
  // The cases below never reach a trap.
  ['if (input.flag) …', () => (input.flag ? 'took the branch' : 'skipped the branch')],
  ['!input.flag', () => !input.flag],
  ["input.from === 'a'", () => input.from === 'a'],
  ["input.from !== 'a'", () => input.from !== 'a'],
  [
    "switch (input.kind) { case 'a': … }",
    () => {
      switch (input.kind) {
        case 'a':
          return 'case a';
        default:
          return 'default';
      }
    },
  ],
  [
    'input.hostname ?? "fallback"',
    () => ((input.hostname ?? 'fallback') === input.hostname ? 'the value itself' : 'fallback'),
  ],
  ['input.flag && "x"', () => input.flag && 'x'],
  ['typeof input.from', () => typeof input.from],
  ['input.from === undefined', () => input.from === undefined],
  ['Array.isArray(input.tags)', () => Array.isArray(input.tags)],
  ['input.from instanceof Target', () => input.from instanceof Target],
  ['input.from === input.from', () => input.from === input.from],
  [
    'const { from } = input',
    () => {
      const { from } = input;
      return from === input.from ? 'the same value as input.from' : 'different';
    },
  ],
  [
    'input.tags.length',
    () =>
      typeof input.tags.length === 'object'
        ? 'another value (path tags.length)'
        : input.tags.length,
  ],
  ['inspect(input.from)', () => inspect(input.from)],
];

const rows: string[] = ['| Operation | What happens |', '| --- | --- |'];
for (const [label, run] of cases) {
  let outcome: string;
  try {
    const result = run();
    outcome = `no error; result: ${typeof result === 'string' ? JSON.stringify(result) : String(result)}`;
  } catch (error) {
    const e = error as Error;
    outcome = `throws ${e.name}: ${e.message.split('. A module body')[0]}`;
  }
  rows.push(`| \`${label.replaceAll('|', '\\|')}\` | ${outcome.replaceAll('|', '\\|')} |`);
}
const awaited = await Promise.resolve(input.from);
rows.push(
  `| \`await input.from\` | no error; result: ${awaited === input.from ? 'the value itself (its then is not callable)' : 'something else'} |`,
);
console.log(rows.join('\n'));
console.log('\nOne full message:\n');
try {
  void `${input.smtp.host}`;
} catch (error) {
  console.log((error as Error).message);
}

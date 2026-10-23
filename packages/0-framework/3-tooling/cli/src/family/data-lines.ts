type DataField = string | number | boolean | null | undefined;

const ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
};

function fieldText(field: DataField): string {
  if (field === null || field === undefined) return '';
  return String(field).replace(/[\\\t\n\r]/g, (character) => ESCAPES[character] ?? character);
}

/**
 * One data line: the fields tab-separated, an absent field left empty so a
 * script reads the columns by position. A backslash, tab, newline or carriage
 * return inside a field is escaped as `\\`, `\t`, `\n` or `\r`.
 */
export function dataLine(fields: readonly DataField[]): string {
  return fields.map(fieldText).join('\t');
}

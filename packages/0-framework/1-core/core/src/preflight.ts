/** What an extension's deploy or dev preflight hands its own lowering, and what a deploy preflight found. */

/** A string only this extension reads back, or `undefined` when it has nothing to carry. Metadata only, never a secret value. */
export type PreflightPayload = string | undefined;

/** Where a platform variable is named: a service's input field, or a resource no service reads. */
export type PlatformVariableReader =
  | { readonly kind: 'field'; readonly service: string; readonly path: string }
  | { readonly kind: 'unread'; readonly node: string };

/** A platform variable with no value that nothing requires, with its readers and the commands that set it. */
export interface UnsetPlatformVariable {
  readonly name: string;
  readonly readers: readonly PlatformVariableReader[];
  /** How to set it, one line each, in the order to offer them: a shell command where one exists, otherwise an instruction. */
  readonly commands: readonly string[];
}

/** What a deploy preflight found that does not stop the deploy. Names and readers only, never a value. */
export interface PreflightFindings {
  readonly unset: readonly UnsetPlatformVariable[];
}

/** One reader as the deploy prints it, for example `read by service "shop.email", field "apiKey"`. */
export function platformVariableReaderText(reader: PlatformVariableReader): string {
  switch (reader.kind) {
    case 'field':
      return `read by service "${reader.service}", field "${reader.path === '' ? '(root)' : reader.path}"`;
    case 'unread':
      return `named by resource "${reader.node}", read by no service`;
  }
}

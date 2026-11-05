// Typed errors that only MCP tools throw. The tool wrapper in `src/mcp/define-tool.ts` turns them
// into tool errors. Errors that the HTTP layer also handles live in `src/lib/errors.ts`.

/**
 * Tool input that passed schema validation but can't be used, such as an ID that doesn't exist.
 * The `fix` hint tells the calling agent how to correct the input on its next attempt.
 */
export class ToolInputError extends Error {
  /** One sentence that tells the caller how to correct the input. */
  readonly fix: string;

  constructor(message: string, fix: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolInputError";
    this.fix = fix;
  }
}

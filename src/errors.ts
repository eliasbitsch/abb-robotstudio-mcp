// An error a tool reports to the MCP client as a tool error (isError: true), with the
// controller's or add-in's own words and any structured details.

export class ToolError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, extra: { status?: number; code?: string; details?: unknown } = {}) {
    super(message);
    this.name = "ToolError";
    this.status = extra.status;
    this.code = extra.code;
    this.details = extra.details;
  }
}

export function formatError(e: unknown): string {
  if (e instanceof ToolError) {
    let text = `Error: ${e.message}`;
    if (e.details !== undefined && e.details !== null) text += "\n" + JSON.stringify(e.details, null, 2);
    return text;
  }
  if (e instanceof Error) return `Error: ${e.message}`;
  return `Error: ${String(e)}`;
}

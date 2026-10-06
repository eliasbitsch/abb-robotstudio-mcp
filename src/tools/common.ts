import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError } from "../errors.js";

export interface Hints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export const READ: Hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
export const WRITE: Hints = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };
export const WRITE_IDEMPOTENT: Hints = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
export const SAFE_ACTION: Hints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };

export interface ToolSpec<S extends z.ZodRawShape> {
  title: string;
  description: string;
  input: S;
  hints: Hints;
}

// Register a tool whose handler returns plain data. Any thrown error becomes an MCP tool
// error (isError: true) carrying the controller's or add-in's own message, so a client
// can never mistake a failure for a result.
export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  spec: ToolSpec<S>,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): void {
  const callback = async (args: unknown) => {
    try {
      const data = await handler(args as z.infer<z.ZodObject<S>>);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: formatError(e) }] };
    }
  };
  server.registerTool(
    name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.input as any,
      annotations: { title: spec.title, openWorldHint: false, ...spec.hints },
    },
    callback as any,
  );
}

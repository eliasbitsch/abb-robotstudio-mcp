// The MCP server itself: identity, operating notes and every tool. Separate from index.ts
// (process setup, transport, shutdown) so tests can build exactly what a client connects to.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeClient } from "./bridge-client.js";
import { VERSION } from "./config.js";
import { INSTRUCTIONS } from "./instructions.js";
import type { RwsClient } from "./rws-client.js";
import { registerRsTools } from "./tools/rs.js";
import { registerRwsTools } from "./tools/rws.js";

export function createServer(bridge: BridgeClient, rws: RwsClient): McpServer {
  const server = new McpServer({ name: "abb-robotstudio", version: VERSION }, { instructions: INSTRUCTIONS });
  registerRsTools(server, bridge);
  registerRwsTools(server, rws);
  return server;
}

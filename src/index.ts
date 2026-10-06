#!/usr/bin/env node

// ABB RobotStudio MCP server.
//  - rs_*  tools: RobotStudio and the PC SDK, through the RobotStudioBridge add-in running
//          inside RobotStudio (stations, simulation, and any controller the PC SDK reaches).
//  - rws_* tools: Robot Web Services, straight to the controller at ABB_RWS_URL.
// Configuration is by environment variable; see README.md.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeClient } from "./bridge-client.js";
import { loadConfig, VERSION, type Config } from "./config.js";
import { RwsClient } from "./rws-client.js";
import { createServer } from "./server.js";

let cfg: Config;
try {
  cfg = loadConfig();
} catch (e: any) {
  console.error(`abb-robotstudio-mcp: configuration error: ${e.message}`);
  process.exit(1);
}

if (cfg.rwsTlsInsecure) {
  // OmniCore serves RWS over HTTPS with a self-signed certificate by default. This process
  // talks only to the RWS endpoint and the loopback add-in, so relaxing verification here
  // affects nothing else -- but it is still a deliberate opt-in, and it is announced.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.error("abb-robotstudio-mcp: ABB_RWS_TLS_INSECURE=1 -- the RWS server's TLS certificate is NOT verified.");
}

const bridge = new BridgeClient(cfg);
const rws = new RwsClient(cfg);
const server = createServer(bridge, rws);

let shuttingDown = false;
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // Release this server's RWS session (and with it any mastership it holds) instead of
  // leaving it to the controller's ~5 minute idle timeout.
  await rws.logout();
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.stdin.on("end", () => void shutdown(0));
process.stdin.on("close", () => void shutdown(0));

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error(`abb-robotstudio-mcp ${VERSION}`);
  console.error(`  RobotStudio add-in: ${cfg.bridgeUrl}`);
  console.error(`  Robot Web Services: ${cfg.rwsUrl}`);
}

main().catch((err) => {
  console.error("abb-robotstudio-mcp: fatal:", err);
  process.exit(1);
});

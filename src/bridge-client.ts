// Client for the RobotStudioBridge RobotStudio add-in (the rs_* tools).

import type { Config } from "./config.js";
import { VERSION } from "./config.js";
import { ToolError } from "./errors.js";

export type Params = Record<string, string | number | boolean | string[] | undefined | null>;

export interface BridgeCall {
  method?: "GET" | "POST";
  params?: Params;
  timeoutMs?: number;
}

function major(v: string): number {
  return parseInt(v.split(".")[0] ?? "", 10);
}

export class BridgeClient {
  private compat: Promise<void> | null = null;

  constructor(private readonly cfg: Config) {}

  get url(): string {
    return this.cfg.bridgeUrl;
  }

  // One raw call. Every rs_* tool goes through call(), which checks add-in compatibility
  // first; ping() uses this directly so it can report an incompatible add-in.
  async raw(path: string, call: BridgeCall = {}): Promise<any> {
    const method = call.method ?? "GET";
    const url = new URL(this.cfg.bridgeUrl + path);
    const headers: Record<string, string> = {
      "X-RobotStudioBridge-Client": `abb-robotstudio-mcp/${VERSION}`,
      Accept: "application/json",
    };
    if (this.cfg.sdkUser) {
      headers["X-ABB-User"] = this.cfg.sdkUser;
      headers["X-ABB-Password"] = this.cfg.sdkPass;
    }
    let body: string | undefined;
    const params = Object.fromEntries(Object.entries(call.params ?? {}).filter(([, v]) => v !== undefined && v !== null));
    if (method === "GET") {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(params); // always a body: the Windows HTTP stack answers a bodyless POST with 411
    }

    const timeoutMs = call.timeoutMs ?? this.cfg.bridgeTimeoutMs;
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e: any) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError")
        throw new ToolError(
          `The RobotStudioBridge add-in at ${this.cfg.bridgeUrl} did not answer ${path} within ${Math.round(timeoutMs / 1000)} s. ` +
          `RobotStudio may be busy or hung (a modal dialog, a long operation), or the operation is still running.`);
      const cause = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(e);
      throw new ToolError(
        `Cannot reach the RobotStudioBridge add-in at ${this.cfg.bridgeUrl} (${cause}). Is RobotStudio running with the ` +
        `RobotStudioBridge add-in installed? See the README's install section.`);
    }

    const text = await res.text();
    let json: any;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      throw new ToolError(
        `Unexpected non-JSON reply from ${this.cfg.bridgeUrl}${path} (HTTP ${res.status}): ${text.slice(0, 200)}` +
        (res.status === 400 && /Invalid Hostname|Bad Request/i.test(text)
          ? " -- Windows rejected the request's host name; ABB_BRIDGE_URL must use http://localhost:<port>." : ""));
    }
    if (!res.ok) {
      const msg = json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
      throw new ToolError(msg, { status: res.status, code: json?.code, details: json?.details ?? undefined });
    }
    return json;
  }

  // Refuse to talk to an add-in of a different major version: the endpoints changed
  // between majors, and a mismatch would otherwise surface as confusing 404s or field errors.
  private ensureCompatible(): Promise<void> {
    if (!this.compat) {
      this.compat = this.raw("/ping", { timeoutMs: 15000 }).then((p) => {
        const addin = String(p?.version ?? "0");
        if (major(addin) !== major(VERSION))
          throw new ToolError(
            `The RobotStudioBridge add-in in RobotStudio is v${addin} but this MCP server is v${VERSION}. ` +
            `Install the matching add-in package (AbbRobotStudioMcp.RobotStudioBridge-${VERSION}.rspak) and restart RobotStudio.`);
      }).catch((e) => {
        this.compat = null; // retry on the next call (RobotStudio may simply not be up yet)
        throw e;
      });
    }
    return this.compat;
  }

  async call(path: string, call: BridgeCall = {}): Promise<any> {
    await this.ensureCompatible();
    return this.raw(path, call);
  }

  async ping(): Promise<unknown> {
    const p = await this.raw("/ping", { timeoutMs: 15000 });
    const addin = String(p?.version ?? "0");
    return { ...p, mcpServerVersion: VERSION, compatible: major(addin) === major(VERSION) };
  }
}

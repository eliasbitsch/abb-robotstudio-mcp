// Environment configuration, read and validated once at startup.

import { readFileSync } from "node:fs";

// dist/config.js sits one level below the package root; the unit-test build
// (build-test/src/config.js) sits two.
function readPackage(): { version: string } {
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
    } catch { /* try the next level up */ }
  }
  throw new Error("abb-robotstudio-mcp: package.json not found next to the build");
}

const pkg = readPackage();

// The MCP server and the RobotStudioBridge add-in ship together and share this version.
export const VERSION: string = pkg.version;

function str(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? def : v.trim();
}

function url(name: string, def: string): string {
  const v = str(name, def).replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${name}='${v}' is not a valid URL (expected e.g. ${def})`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error(`${name}='${v}' must be an http:// or https:// URL`);
  if (u.pathname !== "/" && u.pathname !== "")
    throw new Error(`${name}='${v}' must not have a path; give only scheme, host and port`);
  return v;
}

function int(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`${name}='${raw}' must be a whole number between ${min} and ${max}`);
  return n;
}

function bool(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "0" || raw === "false" || raw === "no") return false;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  throw new Error(`${name}='${process.env[name]}' must be 1/true or 0/false`);
}

export interface Config {
  bridgeUrl: string;
  bridgeTimeoutMs: number;
  sdkUser: string;
  sdkPass: string;
  rwsUrl: string;
  rwsUser: string;
  rwsPass: string;
  rwsTimeoutMs: number;
  rwsTlsInsecure: boolean;
}

export function loadConfig(): Config {
  const cfg: Config = {
    bridgeUrl: url("ABB_BRIDGE_URL", "http://localhost:58080"),
    bridgeTimeoutMs: int("ABB_BRIDGE_TIMEOUT_MS", 60000, 1000, 3600000),
    sdkUser: str("ABB_SDK_USER", ""),
    sdkPass: process.env.ABB_SDK_PASS ?? "",
    rwsUrl: url("ABB_RWS_URL", "http://localhost:80"),
    rwsUser: str("ABB_RWS_USER", "Default User"),
    rwsPass: process.env.ABB_RWS_PASS ?? "robotics",
    rwsTimeoutMs: int("ABB_RWS_TIMEOUT_MS", 15000, 1000, 600000),
    rwsTlsInsecure: bool("ABB_RWS_TLS_INSECURE"),
  };
  const host = new URL(cfg.bridgeUrl).hostname;
  if (host !== "localhost")
    throw new Error(
      `ABB_BRIDGE_URL must use the host name "localhost" (got "${host}"): the add-in listens on ` +
      `http://localhost:<port>/ only, and Windows rejects requests addressed to any other host name, 127.0.0.1 included.`);
  return cfg;
}

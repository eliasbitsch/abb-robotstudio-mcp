// Pure helpers for Robot Web Services: XHTML parsing, paging links, error bodies, HTTP
// Digest and small text utilities. Nothing here does I/O, so all of it is unit-tested.

import { createHash } from "node:crypto";

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"', apos: "'", lt: "<", gt: ">", amp: "&", nbsp: String.fromCharCode(160),
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ent] ?? whole;
  });
}

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? decodeEntities(m[1]) : undefined;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

export interface RwsItem {
  cls: string;
  title: string;
  fields: Record<string, string>;
}

// Parse the <li class="..." title="..."> items of an RWS XHTML response, each with its
// <span class="field">value</span> children. Parsing per item (rather than collecting
// every "name" span in the document and zipping lists) keeps fields aligned even when an
// item lacks one of them.
export function parseItems(html: string, liClass?: string): RwsItem[] {
  const items: RwsItem[] = [];
  const liRe = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(html)) !== null) {
    const cls = attr(m[1], "class") ?? "";
    if (liClass && cls !== liClass) continue;
    const fields: Record<string, string> = {};
    const spanRe = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
    let s: RegExpExecArray | null;
    while ((s = spanRe.exec(m[2])) !== null) {
      const key = attr(s[1], "class");
      if (key && !(key in fields)) fields[key] = decodeEntities(stripTags(s[2])).trim();
    }
    items.push({ cls, title: attr(m[1], "title") ?? "", fields });
  }
  return items;
}

// First <span class="cls"> value anywhere in the document.
export function firstSpan(html: string, cls: string): string | undefined {
  const re = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (attr(m[1], "class") === cls) return decodeEntities(stripTags(m[2])).trim();
  }
  return undefined;
}

// The href of an <a rel="..."> link (next, prev, last...), if any; attribute order varies.
export function linkHref(html: string, rel: string): string | undefined {
  const re = /<a\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if ((attr(m[1], "rel") ?? "").toLowerCase() === rel) return attr(m[1], "href");
  }
  return undefined;
}

export function nextHref(html: string): string | undefined {
  return linkHref(html, "next");
}

export function baseHref(html: string): string | undefined {
  const m = html.match(/<base\b([^>]*)>/i);
  return m ? attr(m[1], "href") : undefined;
}

// Resolve a paging link to a path + query on OUR connection. The link is relative to the
// response's <base href>, which names the controller as the controller sees itself (often
// 127.0.0.1 without our port), so only the path and query are kept.
export function resolveNext(href: string, base: string | undefined, requestPath: string): string {
  const fallback = "http://controller" + requestPath;
  let baseUrl: URL;
  try { baseUrl = new URL(base ?? fallback); } catch { baseUrl = new URL(fallback); }
  const u = new URL(href, baseUrl);
  return u.pathname + u.search;
}

export interface RwsErrorBody {
  code?: string;
  msg?: string;
  controllerCode?: string;
}

// RWS error bodies: <span class="code">-1073414146</span><span class="msg">...</span>. The msg
// carries the controller's own source location and repeats the codes, in these measured shapes:
//   "C:\BUILDAGENTS\...\rws_resource_rapid_symbol_data.cpp[286] Symbol not found code:-1073414146 icode:-1"
//   "C:\BUILDAGENTS\...\rws_resource_panel.cpp[929] code:-1073414146 icode:-1073445881"
//   "ERROR: C:\BUILDAGENTS\...\rws_component_rapid.cpp[261]: org_code: -4503 new_code: 0xc0049007;"
// Keep the words, and the inner controller code when there is one: org_code, or an icode other
// than -1 (which means none). On RobotWare 6 the outer code is often RWS's generic -1073414146
// and only the icode says why: a motors-on refused in a guard stop or e-stop is
// "code:-1073414146 icode:-1073445881" (SYS_CTRL_E_REJECT).
export function parseErrorBody(html: string): RwsErrorBody {
  const out: RwsErrorBody = {};
  const code = firstSpan(html, "code");
  if (code !== undefined) out.code = code;
  let msg = firstSpan(html, "msg");
  if (msg) {
    msg = msg.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? msg;
    msg = msg.replace(/^ERROR:\s*/i, "").replace(/^\S*\.(?:cpp|c|h|hpp)\[\d+\]:?\s*/i, "");
    const org = msg.match(/\borg_code:\s*(-?\d+)/i);
    const inner = msg.match(/\bicode:\s*(-?\d+)/i);
    if (org) out.controllerCode = org[1];
    else if (inner && inner[1] !== "-1") out.controllerCode = inner[1];
    msg = msg
      .replace(/\borg_code:\s*-?\d+\s*(?:new_code:\s*0x[0-9a-f]+;?)?/i, "")
      .replace(/\s*\bcode:\s*-?\d+(?:\s+icode:\s*-?\d+)?\s*$/i, "")
      .trim();
    if (msg !== "") out.msg = msg;
  }
  return out;
}

// -1073414146 is deliberately absent: it is RobotWare 6 RWS's GENERIC outer code, measured on a
// 403 motors-on refusal, a 400 "Symbol not found" and a 404 missing file alike, so it says
// nothing by itself. The HTTP status, the message and the inner code do.
const CODE_HINTS: Record<string, string> = {
  "-4503": "the RAPID program server was busy: a previous start, stop or load had not finished",
  "-1073445881": "the controller refused the request in its current state (SYS_CTRL_E_REJECT): check operating mode, motors state and whether RAPID is running",
  "-1073445859": "this session lacks the required mastership (another client, e.g. the FlexPendant or RobotStudio, may hold it)",
  "-1073445862": "the FlexPendant holds mastership (the controller is probably in manual mode)",
  "-1073445879": "resource not found (wrong path or name)",
};

export function codeHint(code: string | undefined): string | undefined {
  return code ? CODE_HINTS[code] : undefined;
}

// ---------------------------------------------------------------- HTTP Digest (RFC 7616, MD5)

export function parseDigestChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = header.replace(/^\s*Digest\s+/i, "");
  const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out[m[1].toLowerCase()] = (m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3] ?? "").trim();
  }
  return out;
}

function md5(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

export interface DigestInput {
  method: string;
  uri: string;
  user: string;
  pass: string;
  challenge: Record<string, string>;
  nc: number;
  cnonce: string;
}

export function buildDigestHeader(i: DigestInput): string {
  const c = i.challenge;
  const realm = c.realm ?? "";
  const nonce = c.nonce ?? "";
  const algorithm = (c.algorithm ?? "MD5").toUpperCase();
  if (algorithm !== "MD5" && algorithm !== "MD5-SESS")
    throw new Error(`the controller asked for Digest algorithm ${algorithm}; only MD5 and MD5-sess are supported`);
  let ha1 = md5(`${i.user}:${realm}:${i.pass}`);
  if (algorithm === "MD5-SESS") ha1 = md5(`${ha1}:${nonce}:${i.cnonce}`);
  const ha2 = md5(`${i.method}:${i.uri}`);
  const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const parts = [
    `username="${q(i.user)}"`, `realm="${q(realm)}"`, `nonce="${q(nonce)}"`,
    `uri="${q(i.uri)}"`, `algorithm=${c.algorithm ?? "MD5"}`,
  ];
  const qops = (c.qop ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (qops.length > 0) {
    const qop = qops.includes("auth") ? "auth" : qops[0];
    if (qop !== "auth") throw new Error(`the controller asked for Digest qop=${qop}; only qop=auth is supported`);
    const nc = i.nc.toString(16).padStart(8, "0");
    const response = md5(`${ha1}:${nonce}:${nc}:${i.cnonce}:${qop}:${ha2}`);
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${i.cnonce}"`, `response="${response}"`);
  } else {
    parts.push(`response="${md5(`${ha1}:${nonce}:${ha2}`)}"`);
  }
  if (c.opaque !== undefined) parts.push(`opaque="${q(c.opaque)}"`);
  return "Digest " + parts.join(", ");
}

// ---------------------------------------------------------------- RAPID text helpers

export interface ModuleHeader {
  name: string;
  system: boolean;
}

// The module a RAPID source text declares, and whether it is a system module.
export function parseModuleHeader(code: string): ModuleHeader | undefined {
  const m = code.match(/^\s*MODULE\s+([A-Za-z][A-Za-z0-9_]*)\s*(\(([^)]*)\))?/im);
  if (!m) return undefined;
  return { name: m[1], system: m[3] !== undefined && /\bSYSMODULE\b/i.test(m[3]) };
}

export function hasEndModule(code: string): boolean {
  return /^\s*ENDMODULE\b/im.test(code);
}

// RobotWare 6's RAPID loader refuses a module containing any non-ASCII character, comments
// included, and reports the failure somewhere unhelpful. Find the first one.
export function firstNonAscii(text: string): { char: string; line: number; column: number } | undefined {
  let line = 1;
  let column = 0;
  for (const ch of text) {
    if (ch === "\n") { line++; column = 0; continue; }
    column++;
    if (ch.codePointAt(0)! > 127) return { char: ch, line, column };
  }
  return undefined;
}

export function normalizeText(s: string): string {
  return s.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").replace(/\n+$/, "");
}

export type TextComparison =
  | { equal: true }
  | { equal: false; truncated: boolean; firstDifferentLine: number; sentLength: number; storedLength: number };

// Compare what was sent with what the controller stored, ignoring line endings and
// trailing whitespace. A stored text that is a strict prefix of the sent one is a
// truncation -- the failure mode measured on the RWS 1.0 form endpoint.
export function compareModuleText(sent: string, stored: string): TextComparison {
  const a = normalizeText(sent);
  const b = normalizeText(stored);
  if (a === b) return { equal: true };
  const al = a.split("\n");
  const bl = b.split("\n");
  let i = 0;
  while (i < al.length && i < bl.length && al[i] === bl[i]) i++;
  return {
    equal: false,
    truncated: b.length < a.length && a.startsWith(b.slice(0, Math.max(0, b.length - 200))),
    firstDifferentLine: i + 1,
    sentLength: a.length,
    storedLength: b.length,
  };
}

// ---------------------------------------------------------------- file service paths

// Turn a user path into a /fileservice URL path. Environment variables such as $HOME are
// written lowercase in RWS URLs ("$home", documented for both RWS generations) and must
// come first; each segment is percent-encoded but the separators are kept.
export function fileServicePath(path: string): string {
  let p = path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (p === "") throw new Error("the path is empty");
  const segments = p.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === ".." || s === "."))
    throw new Error(`'.' and '..' segments are not allowed in controller paths: ${path}`);
  const head = segments[0].match(/^\$([A-Za-z]+)$/);
  if (head) segments[0] = "$" + head[1].toLowerCase();
  return "/fileservice/" + segments.map((s) => encodeURIComponent(s)).join("/");
}

// Does this byte buffer look like text we can safely hand back as a string?
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

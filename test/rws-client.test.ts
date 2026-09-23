// RwsClient against a mock controller that implements RWS authentication the way the real
// ones do: Digest (RWS 1.0) or Basic (2.0), a session held by TWO cookies, 401 on anything
// else. The counters are what matter -- every successful handshake is a controller session.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { RwsClient } from "../src/rws-client.js";
import { parseDigestChallenge } from "../src/rws-parse.js";
import type { Config } from "../src/config.js";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

interface MockOptions {
  scheme?: "digest" | "basic";
  rwversion?: string;
  systemFailures?: number;          // answer /rw/system with 503 this many times first
  strictAccept?: boolean;           // 406 on the versioned Accept (a strict IRC5)
  password?: string;
  lifo21?: boolean;                 // event log supports v=2.1 lifo (with 7.21's broken next link)
}

class MockController {
  handshakes = 0;
  unauthorized = 0;
  requests: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  private sessions = new Set<string>();
  private nonce = randomBytes(8).toString("hex");
  private systemFailures: number;
  url = "";
  private server = createServer((req, res) => this.handle(req, res));

  constructor(private opts: MockOptions = {}) {
    this.systemFailures = opts.systemFailures ?? 0;
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  expireSessions(): void {
    this.sessions.clear();
  }

  private authed(req: IncomingMessage): boolean {
    const cookies = Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=") as [string, string]));
    const sid = cookies["-http-session-"];
    return !!sid && this.sessions.has(sid) && cookies.ABBCX === sid.slice(0, 4);
  }

  private checkAuthorization(req: IncomingMessage): boolean {
    const h = req.headers.authorization ?? "";
    const pass = this.opts.password ?? "robotics";
    if ((this.opts.scheme ?? "digest") === "basic")
      return h === "Basic " + Buffer.from(`Default User:${pass}`).toString("base64");
    if (!/^Digest /.test(h)) return false;
    const p = parseDigestChallenge(h);
    const ha1 = md5(`${p.username}:${p.realm}:${pass}`);
    const ha2 = md5(`${req.method}:${p.uri}`);
    return p.uri === req.url && p.nonce === this.nonce &&
      p.response === md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = "";
    for await (const chunk of req) body += chunk;
    this.requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    if (!this.authed(req)) {
      if (!this.checkAuthorization(req)) {
        this.unauthorized++;
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", (this.opts.scheme ?? "digest") === "basic"
          ? 'Basic realm="validusers@robapi.abb"'
          : `Digest realm="validusers@robapi.abb", nonce="${this.nonce}", qop="auth"`);
        res.end();
        return;
      }
      this.handshakes++;
      const sid = randomBytes(8).toString("hex");
      this.sessions.add(sid);
      res.setHeader("Set-Cookie", [`-http-session-=${sid}; path=/`, `ABBCX=${sid.slice(0, 4)}; path=/`]);
    }
    this.route(req, res, body);
  }

  private route(req: IncomingMessage, res: ServerResponse, body: string): void {
    const url = req.url!;
    const html = (inner: string) => `<html><head><base href="http://127.0.0.1/rw/"/></head><body><div class="state">${inner}</div></body></html>`;
    if (url === "/rw/system") {
      if (this.systemFailures > 0) { this.systemFailures--; res.statusCode = 503; res.end("<html>busy</html>"); return; }
      if (this.opts.strictAccept && /v=2\.0/.test(String(req.headers.accept))) { res.statusCode = 406; res.end(); return; }
      res.end(html(`<ul><li class="sys-system-li" title="system"><span class="rwversion">${this.opts.rwversion ?? "6.16.0"}</span></li></ul>`));
      return;
    }
    const page = url.match(/^\/rw\/items(?:\?start=(\d+))?$/);
    if (page) {
      const start = Number(page[1] ?? 0);
      const items = [0, 1].map((k) => `<li class="it" title="i${start + k}"><span class="n">${start + k}</span></li>`).join("");
      const next = start < 4 ? `<a href="items?start=${start + 2}" rel="next"></a>` : "";
      res.end(html(next + `<ul>${items}</ul>`));
      return;
    }
    // An RWS 2.0 event log holding seqs 1..6: oldest first in pages of 2. Newest-first needs
    // v=2.1; with lifo21 it is supported, with RobotWare 7.21's broken next link.
    const elogEntry = (q: number) => `<li class="elog-message-li" title="/rw/elog/0/${q}"><span class="code">${q}</span></li>`;
    if (url.startsWith("/rw/elog/0?") && /order=lifo/.test(url)) {
      if (!this.opts.lifo21 || !/v=2\.1/.test(String(req.headers.accept))) { res.statusCode = /v=2\.1/.test(String(req.headers.accept)) ? 406 : 400; res.end(); return; }
      const from = Number(url.match(/elogseqnum=(\d+)/)?.[1] ?? 6);
      const seqs = [from, from - 1].filter((q) => q >= 1);
      res.end(`<html><head><base href="http://127.0.0.1/rw/elog/"/></head><body><a href="0?order=lifo&amp;lang=en&amp;start=4294967294&amp;limit=2" rel="next"></a><ul>` +
        seqs.map(elogEntry).join("") + "</ul></body></html>");
      return;
    }
    const elog = url.match(/^\/rw\/elog\/0\?lang=en(?:&start=(\d+))?$/);
    if (elog) {
      const pageNo = Number(elog[1] ?? 1);
      const seqs = [pageNo * 2 - 1, pageNo * 2];
      const links = (pageNo < 3 ? `<a href="0?lang=en&amp;start=${pageNo + 1}" rel="next"></a>` : "") +
        (pageNo > 1 ? `<a href="0?lang=en&amp;start=${pageNo - 1}" rel="prev"></a>` : "") +
        `<a href="0?lang=en&amp;start=3" rel="last"></a>`;
      res.end(`<html><head><base href="http://127.0.0.1/rw/elog/"/></head><body>${links}<ul>` + seqs.map(elogEntry).join("") + "</ul></body></html>");
      return;
    }
    if (url === "/rw/loop") { res.end(html('<a href="loop" rel="next"></a><ul><li class="it" title="x"></li></ul>')); return; }
    if (url === "/rw/echo") { res.end(html(`<span class="raw">${body.replace(/&/g, "&amp;")}</span>`)); return; }
    res.end(html(`<span class="ok">${url}</span>`));
  }
}

function config(url: string, extra: Partial<Config> = {}): Config {
  return {
    bridgeUrl: "http://localhost:58080", bridgeTimeoutMs: 5000, sdkUser: "", sdkPass: "",
    rwsUrl: url, rwsUser: "Default User", rwsPass: "robotics", rwsTimeoutMs: 5000, rwsTlsInsecure: false,
    ...extra,
  };
}

test("one handshake for many sequential requests", async () => {
  const m = new MockController();
  await m.start();
  try {
    const c = new RwsClient(config(m.url));
    for (let i = 0; i < 10; i++) await c.get(`/rw/x${i}`);
    assert.equal(m.handshakes, 1);
  } finally { await m.stop(); }
});

test("a burst after the session expires re-authenticates exactly once", async () => {
  const m = new MockController();
  await m.start();
  try {
    const c = new RwsClient(config(m.url));
    await c.get("/rw/warm");
    assert.equal(m.handshakes, 1);
    m.expireSessions();
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => c.get(`/rw/burst${i}`)));
    assert.equal(results.length, 6);
    assert.equal(m.handshakes, 2, "the six concurrent requests must share ONE new session");
  } finally { await m.stop(); }
});

test("a first-contact failure is not cached as the controller generation", async () => {
  const m = new MockController({ systemFailures: 1, rwversion: "7.21.0", scheme: "basic" });
  await m.start();
  try {
    const c = new RwsClient(config(m.url));
    await assert.rejects(() => c.ready(), /HTTP 503/);
    assert.deepEqual(await c.ready(), { version: "v2", robotWare: "7.21.0" });
  } finally { await m.stop(); }
});

test("a strict IRC5 that 406es the versioned Accept is detected as RWS 1.0", async () => {
  const m = new MockController({ strictAccept: true, rwversion: "6.08.01" });
  await m.start();
  try {
    const c = new RwsClient(config(m.url));
    assert.equal((await c.ready()).version, "v1");
    await c.get("/rw/after");
    assert.equal(m.requests.at(-1)!.headers.accept, "application/xhtml+xml");
  } finally { await m.stop(); }
});

test("Basic authentication (RWS 2.0) and the versioned Content-Type, even on an empty form", async () => {
  const m = new MockController({ scheme: "basic", rwversion: "7.21.0" });
  await m.start();
  try {
    const c = new RwsClient(config(m.url));
    await c.post("/rw/empty", {});
    const last = m.requests.at(-1)!;
    assert.equal(last.headers["content-type"], "application/x-www-form-urlencoded;v=2.0");
    assert.equal(last.headers.accept, "application/xhtml+xml;v=2.0");
    assert.equal(m.handshakes, 1);
  } finally { await m.stop(); }
});

test("form encoding keeps '+' and spaces distinct", async () => {
  const m = new MockController();
  await m.start();
  try {
    const c = new RwsClient(config(m.url));
    await c.post("/rw/echo", { text: "n := n + 1; a b" });
    assert.equal(m.requests.at(-1)!.body, "text=n%20%3A%3D%20n%20%2B%201%3B%20a%20b");
  } finally { await m.stop(); }
});

test("items() follows every page and stops on a self-referencing next link", async () => {
  const m = new MockController();
  await m.start();
  try {
    const c = new RwsClient(config(m.url));
    const all = await c.items("/rw/items", "it");
    assert.deepEqual(all.map((i) => i.title), ["i0", "i1", "i2", "i3", "i4", "i5"]);
    assert.deepEqual((await c.items("/rw/items", "it", 3)).map((i) => i.title), ["i0", "i1", "i2"]);
    assert.equal((await c.items("/rw/loop", "it")).length, 1);
  } finally { await m.stop(); }
});

test("RWS 2.0 without v=2.1: the event log is walked backwards from its last page", async () => {
  const m = new MockController({ scheme: "basic", rwversion: "7.1.0" });
  await m.start();
  try {
    const c = new RwsClient(config(m.url));
    const newest = await c.elogNewestFirst(0, 5);
    assert.deepEqual(newest.map((i) => i.title.split("/").pop()), ["6", "5", "4", "3", "2"]);
  } finally { await m.stop(); }
});

test("RWS 2.1: newest first, paged by sequence number, ignoring the broken next link", async () => {
  const m = new MockController({ scheme: "basic", rwversion: "7.21.0", lifo21: true });
  await m.start();
  try {
    const c = new RwsClient(config(m.url));
    const newest = await c.elogNewestFirst(0, 5);
    assert.deepEqual(newest.map((i) => i.title.split("/").pop()), ["6", "5", "4", "3", "2"]);
    const all = await c.elogNewestFirst(0, 100);
    assert.deepEqual(all.map((i) => i.title.split("/").pop()), ["6", "5", "4", "3", "2", "1"]);
    assert.ok(!m.requests.some((r) => r.url.includes("start=4294967294")), "the broken next link must not be followed");
  } finally { await m.stop(); }
});

test("a wrong password is reported as an authentication failure, not a parse error", async () => {
  const m = new MockController({ password: "other" });
  await m.start();
  try {
    const c = new RwsClient(config(m.url));
    await assert.rejects(() => c.ready(), /authentication failed.*ABB_RWS_USER/s);
  } finally { await m.stop(); }
});

test("an unreachable controller names the URL", async () => {
  const c = new RwsClient(config("http://127.0.0.1:9", { rwsTimeoutMs: 2000 }));
  await assert.rejects(() => c.ready(), /Cannot reach Robot Web Services at http:\/\/127\.0\.0\.1:9/);
});

// Robot Web Services transport: authentication, the session cookie jar, RWS 1.0 / 2.0
// negotiation, error decoding and paging.
//
// SESSIONS. A controller allows 70 RWS sessions (5 per client IP on OmniCore) and every
// successful authentication mints one, so this client authenticates as rarely as it can:
//  - BOTH session cookies ("-http-session-" and "ABBCX") are replayed; sending only one
//    answers 401 and forces a fresh handshake on every request.
//  - The first request (version detection) authenticates alone, and after that any request
//    that finds the session expired re-authenticates under a lock: the other requests in
//    the same burst wait, then retry with the new cookies instead of each minting a session.
//  - The session is logged out when the server shuts down.
// Mastership is bound to the session, so request/release pairs ride the same cookies.

import { randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import { ToolError } from "./errors.js";
import {
  baseHref, buildDigestHeader, codeHint, firstSpan, linkHref, parseDigestChallenge, parseErrorBody,
  parseItems, resolveNext, type RwsItem,
} from "./rws-parse.js";

export type RwsVersion = "v1" | "v2";

const ACCEPT_V1 = "application/xhtml+xml";
const ACCEPT_V2 = "application/xhtml+xml;v=2.0";

export interface RwsResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  body: string;
  bytes?: Uint8Array;
}

export interface RequestOptions {
  form?: Record<string, string | number | boolean>;
  bytes?: Uint8Array;
  contentType?: string;           // for `bytes`
  accept?: string | null;         // default: the negotiated xhtml type; null sends no Accept
  binary?: boolean;               // return the body as bytes
}

function formEncode(form: Record<string, string | number | boolean>): string {
  // encodeURIComponent, not URLSearchParams: a '+' must stay %2B and a space %20 --
  // RAPID source is full of '+' and relying on the server to read '+' as a space is not safe.
  return Object.entries(form).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}

export class RwsClient {
  private readonly jar = new Map<string, string>();
  private authGeneration = 0;
  private authLock: Promise<void> = Promise.resolve();
  private nonceCount = 0;
  private detected: { version: RwsVersion; robotWare: string } | null = null;
  private detecting: Promise<{ version: RwsVersion; robotWare: string }> | null = null;

  constructor(private readonly cfg: Config) {}

  get url(): string {
    return this.cfg.rwsUrl;
  }

  // ------------------------------------------------------------ low level

  private cookieHeader(): string {
    return [...this.jar.values()].join("; ");
  }

  private async send(method: string, path: string, headers: Record<string, string>, body?: string | Uint8Array): Promise<Response> {
    const h = { ...headers };
    const cookie = this.cookieHeader();
    if (cookie) h.Cookie = cookie;
    let res: Response;
    try {
      res = await fetch(this.cfg.rwsUrl + path, {
        method, headers: h, body, redirect: "manual", signal: AbortSignal.timeout(this.cfg.rwsTimeoutMs),
      });
    } catch (e: any) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError")
        throw new ToolError(`RWS ${method} ${path} got no answer from ${this.cfg.rwsUrl} within ${Math.round(this.cfg.rwsTimeoutMs / 1000)} s.`);
      const cause = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(e);
      const tls = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|certificate/i.test(String(cause));
      throw new ToolError(
        `Cannot reach Robot Web Services at ${this.cfg.rwsUrl} (${cause}).` +
        (tls ? " The controller's TLS certificate is not trusted: OmniCore controllers use a self-signed certificate by " +
               "default; set ABB_RWS_TLS_INSECURE=1 to accept it (or add its CA with NODE_EXTRA_CA_CERTS)." : ""));
    }
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(";")[0] ?? "";
      const eq = kv.indexOf("=");
      if (eq <= 0) continue;
      const name = kv.slice(0, eq).trim();
      if (name === "ABBCX" || name === "-http-session-") this.jar.set(name, kv.trim());
    }
    return res;
  }

  private async withAuthLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.authLock;
    let release!: () => void;
    this.authLock = new Promise<void>((r) => (release = r));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async exchange(method: string, path: string, headers: Record<string, string>, body?: string | Uint8Array): Promise<Response> {
    const generation = this.authGeneration;
    let res = await this.send(method, path, headers, body);
    if (res.status !== 401) return res;
    await res.arrayBuffer().catch(() => undefined);

    return this.withAuthLock(async () => {
      if (this.authGeneration !== generation) {
        // Another request re-authenticated while this one waited: use its session.
        res = await this.send(method, path, headers, body);
        if (res.status !== 401) return res;
        await res.arrayBuffer().catch(() => undefined);
      }
      const www = res.headers.get("www-authenticate") ?? "";
      let authorization: string;
      if (/^\s*digest/i.test(www)) {
        authorization = buildDigestHeader({
          method, uri: path, user: this.cfg.rwsUser, pass: this.cfg.rwsPass,
          challenge: parseDigestChallenge(www), nc: ++this.nonceCount, cnonce: randomBytes(8).toString("hex"),
        });
      } else if (/^\s*basic/i.test(www)) {
        authorization = "Basic " + Buffer.from(`${this.cfg.rwsUser}:${this.cfg.rwsPass}`).toString("base64");
      } else {
        throw new ToolError(`RWS ${method} ${path} answered 401 with no usable authentication challenge ('${www}').`, { status: 401 });
      }
      const authed = await this.send(method, path, { ...headers, Authorization: authorization }, body);
      if (authed.status === 401)
        throw new ToolError(
          `RWS authentication failed for user '${this.cfg.rwsUser}' at ${this.cfg.rwsUrl}: check ABB_RWS_USER and ABB_RWS_PASS. ` +
          `(A virtual controller also refuses remote logins unless its RWS whitelist allows this host.)`, { status: 401 });
      this.authGeneration++;
      return authed;
    });
  }

  // ------------------------------------------------------------ version negotiation

  // IRC5 / RobotWare 6 speaks RWS 1.0; OmniCore / RobotWare 7+ speaks RWS 2.0. Decide by
  // the RobotWare MAJOR version, never by how the controller answers the versioned Accept:
  // an RW6 virtual controller measurably answers 200 to the 2.0 media type. A failed probe
  // is NOT cached, so a transient 503 or a wrong password cannot pin the wrong generation.
  ready(): Promise<{ version: RwsVersion; robotWare: string }> {
    if (this.detected) return Promise.resolve(this.detected);
    if (!this.detecting) {
      this.detecting = this.detect().then((d) => {
        this.detected = d;
        console.error(`RWS ${d.version === "v2" ? "2.0" : "1.0"} (RobotWare ${d.robotWare}) at ${this.cfg.rwsUrl}`);
        return d;
      }).finally(() => {
        this.detecting = null;
      });
    }
    return this.detecting;
  }

  private async detect(): Promise<{ version: RwsVersion; robotWare: string }> {
    let res = await this.exchange("GET", "/rw/system", { Accept: ACCEPT_V2 });
    let body = await res.text();
    if (res.status === 406) {
      res = await this.exchange("GET", "/rw/system", { Accept: ACCEPT_V1 });
      body = await res.text();
    }
    if (!res.ok) throw this.error("GET", "/rw/system", res.status, body);
    const robotWare = firstSpan(body, "rwversion") ?? "";
    const major = parseInt(robotWare, 10);
    if (!Number.isFinite(major))
      throw new ToolError(`${this.cfg.rwsUrl}/rw/system answered without a RobotWare version; is ABB_RWS_URL a Robot Web Services endpoint?`);
    return { version: major >= 7 ? "v2" : "v1", robotWare };
  }

  async version(): Promise<RwsVersion> {
    return (await this.ready()).version;
  }

  // ------------------------------------------------------------ requests

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<RwsResponse> {
    const { version } = await this.ready();
    const headers: Record<string, string> = {};
    const accept = opts.accept === undefined ? (version === "v2" ? ACCEPT_V2 : ACCEPT_V1) : opts.accept;
    if (accept) headers.Accept = accept;
    let body: string | Uint8Array | undefined;
    let contentType: string | undefined;
    if (opts.form !== undefined) {
      body = formEncode(opts.form);
      contentType = "application/x-www-form-urlencoded";
    } else if (opts.bytes !== undefined) {
      body = opts.bytes;
      contentType = opts.contentType;
    }
    // RWS 2.0 wants the versioned media type on request bodies too -- EVEN AN EMPTY FORM
    // (resetpp, mastership): a plain Content-Type is refused with 406/415.
    if (contentType) headers["Content-Type"] = version === "v2" && !/;\s*v=2\.0/.test(contentType) ? `${contentType};v=2.0` : contentType;
    const res = await this.exchange(method, path, headers, body);
    if (opts.binary) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, ok: res.ok, headers: res.headers, body: "", bytes };
    }
    return { status: res.status, ok: res.ok, headers: res.headers, body: await res.text() };
  }

  error(method: string, path: string, status: number, body: string): ToolError {
    const { code, msg, controllerCode } = parseErrorBody(body);
    let text = `RWS ${method} ${path} failed: HTTP ${status}`;
    const parts = [code, controllerCode ? `controller code ${controllerCode}` : undefined, msg].filter(Boolean);
    if (parts.length) text += ` (${parts.join(": ")})`;
    else {
      const plain = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (plain) text += ` -- ${plain.slice(0, 200)}`;
    }
    const hint = codeHint(controllerCode) ?? codeHint(code);
    if (hint) text += `. Hint: ${hint}`;
    if (status === 503 && /session|user/i.test(body))
      text += ". The controller's RWS session pool may be exhausted (70 per controller, 5 per client on OmniCore); idle sessions expire after about 5 minutes.";
    return new ToolError(text, { status, code });
  }

  async get(path: string, accept?: string): Promise<string> {
    const r = await this.request("GET", path, accept === undefined ? {} : { accept });
    if (!r.ok) throw this.error("GET", path, r.status, r.body);
    return r.body;
  }

  async post(path: string, form: Record<string, string | number | boolean> = {}): Promise<RwsResponse> {
    const r = await this.request("POST", path, { form });
    if (!r.ok) throw this.error("POST", path, r.status, r.body);
    return r;
  }

  // For RAPID state changes (PP reset, start, loadmod, unloadmod): RWS acknowledges a stop
  // before the task has finished unwinding, so the next call can be refused as busy
  // (controller code -4503, measured). Retry exactly that, up to ~5 s; anything else fails at once.
  async postWhenReady(path: string, form: Record<string, string | number | boolean> = {}): Promise<RwsResponse> {
    for (let attempt = 1; ; attempt++) {
      const r = await this.request("POST", path, { form });
      if (r.ok) return r;
      if (attempt < 10 && parseErrorBody(r.body).controllerCode === "-4503") {
        await new Promise((res) => setTimeout(res, 500));
        continue;
      }
      throw this.error("POST", path, r.status, r.body);
    }
  }

  // Every <li> of a list resource, following rel="next" pages (RWS pages lists: 100
  // signals, 50 event-log entries and 100 directory entries per page on the tested
  // controllers). Stops after `max` items.
  async items(path: string, liClass?: string, max = Number.POSITIVE_INFINITY, accept?: string, rel = "next"): Promise<RwsItem[]> {
    const out: RwsItem[] = [];
    const seen = new Set<string>();
    let next: string | undefined = path;
    while (next && !seen.has(next) && out.length < max && seen.size < 500) {
      seen.add(next);
      const body = await this.get(next, accept);
      out.push(...parseItems(body, liClass));
      const href = linkHref(body, rel);
      next = href ? resolveNext(href, baseHref(body), next) : undefined;
    }
    return out.slice(0, max);
  }

  // Newest-first event-log entries.
  //  - RWS 1.0 accepts order=lifo and pages it correctly.
  //  - RWS 2.0 lists oldest first and refuses lifo unless the request speaks v=2.1 ("LIFO is
  //    not supported in v=2.0"). With v=2.1 the first page is right, but RobotWare 7.21's
  //    rel="next" link for it is broken (start=2^32-50: an unsigned wrap that serves the
  //    first page again), so later pages are requested by sequence number instead:
  //    elogseqnum=N lists N and older (all measured on RobotWare 7.21).
  //  - An RWS 2.0 controller without v=2.1 is walked backwards from its last page.
  // Entries are de-duplicated by sequence number whatever the paging does.
  async elogNewestFirst(domain: number, count: number): Promise<RwsItem[]> {
    const v = await this.version();
    const out: RwsItem[] = [];
    const seqs = new Set<number>();
    const seqOf = (i: RwsItem) => Number(i.title.split("/").pop());
    const add = (items: RwsItem[]): number => {
      let added = 0;
      for (const i of items) {
        const s = seqOf(i);
        if (!Number.isFinite(s) || seqs.has(s) || out.length >= count) continue;
        seqs.add(s);
        out.push(i);
        added++;
      }
      return added;
    };
    const lifo = `/rw/elog/${domain}?lang=en&order=lifo`;
    if (v === "v1") return this.items(lifo, "elog-message-li", count);

    const v21 = "application/xhtml+xml;v=2.1";
    const probe = await this.request("GET", `${lifo}&limit=50`, { accept: v21 });
    if (probe.ok) {
      let page = parseItems(probe.body, "elog-message-li");
      for (let guard = 0; guard < 100 && add(page) > 0 && out.length < count; guard++) {
        const oldest = Math.min(...page.map(seqOf).filter(Number.isFinite));
        if (!(oldest > 0)) break;
        page = parseItems(await this.get(`${lifo}&elogseqnum=${oldest - 1}&limit=50`, v21), "elog-message-li");
      }
      return out;
    }

    const first = `/rw/elog/${domain}?lang=en`;
    const firstBody = await this.get(first);
    const lastHref = linkHref(firstBody, "last");
    let page: string | undefined = lastHref ? resolveNext(lastHref, baseHref(firstBody), first) : first;
    const visited = new Set<string>();
    while (page && !visited.has(page) && out.length < count && visited.size < 500) {
      visited.add(page);
      const body: string = page === first ? firstBody : await this.get(page);
      add(parseItems(body, "elog-message-li").reverse());
      const prev = linkHref(body, "prev");
      page = prev ? resolveNext(prev, baseHref(body), page) : undefined;
    }
    return out;
  }

  // Hold RAPID-write mastership across fn (RWS 1.0 "rapid" domain, 2.0 "edit" domain).
  // Only for endpoints that do not take ?mastership=implicit.
  async withRapidMastership<T>(fn: () => Promise<T>): Promise<T> {
    const v = await this.version();
    const request = v === "v2" ? "/rw/mastership/edit/request" : "/rw/mastership/rapid?action=request";
    const release = v === "v2" ? "/rw/mastership/edit/release" : "/rw/mastership/rapid?action=release";
    const r = await this.request("POST", request, { form: {} });
    if (!r.ok) {
      const e = this.error("POST", request, r.status, r.body);
      throw new ToolError(`Could not get RAPID mastership: ${e.message}`, { status: r.status, code: e.code });
    }
    try {
      return await fn();
    } finally {
      await this.request("POST", release, { form: {} }).catch(() => undefined);
    }
  }

  async logout(): Promise<void> {
    if (this.jar.size === 0) return;
    try {
      const h: Record<string, string> = { Cookie: this.cookieHeader() };
      await fetch(this.cfg.rwsUrl + "/logout", { method: "GET", headers: h, signal: AbortSignal.timeout(2000) });
    } catch {
      // best effort: the controller reaps idle sessions after ~5 minutes anyway
    }
    this.jar.clear();
  }
}

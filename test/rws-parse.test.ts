import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseHref, buildDigestHeader, codeHint, compareModuleText, decodeEntities, fileServicePath, firstNonAscii, firstSpan,
  hasEndModule, looksLikeText, nextHref, parseDigestChallenge, parseErrorBody, parseItems, parseModuleHeader, resolveNext,
} from "../src/rws-parse.js";

// Shapes captured from RobotWare 6.16 (RWS 1.0) and 7.21 (RWS 2.0) controllers, trimmed.
const SIGNALS_V1 =
  '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>io</title>' +
  '<base href="http://localhost:80/rw/iosystem/"/></head><body><div class="state"><a href="signals" rel="self"></a>' +
  '<a href="signals?action=show" rel="action"></a><a href="signals?start=100&amp;limit=100" rel="next"></a><ul>' +
  '<li class="ios-signal-li" title="Net/Dev/DoOne"><a href="signals/Net/Dev/DoOne" rel="self"></a><span class="name">DoOne</span>' +
  '<span class="type">DO</span><span class="category">x</span><span class="lvalue">1</span><span class="lstate">not simulated</span></li>' +
  '<li class="ios-signal-li" title="Net/Dev/DiTwo"><a href="signals/Net/Dev/DiTwo" rel="self"></a><span class="name">DiTwo</span>' +
  '<span class="type">DI</span><span class="lvalue">0</span></li></ul></div></body></html>';

const ELOG_V2 =
  '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><base href="http://localhost:90/rw/elog/"/></head>' +
  '<body><div class="state"><a href="0?lang=en" rel="self"></a> <a href="0?order=lifo&amp;lang=en&amp;start=2&amp;limit=50" rel="next"></a>' +
  '<ul><li class="elog-message-li" title="/rw/elog/0/414607"> <a href="0/414607?lang=en" rel="self"></a> <span class="msgtype">1</span>' +
  '<span class="code">10021</span><span class="tstamp">2026-09-17 T 05:08:03</span><span class="title">Execution error reset</span>' +
  '<span class="desc">The program execution in task T_ROB2 has left a spontaneous error state.</span><span class="conseqs"></span>' +
  '<span class="argc">2</span>  <span class="arg1" type="long">3</span></li></ul></div></body></html>';

const ERROR_V1 =
  '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>rw</title><base href="http://localhost:80/"/>' +
  '</head><body><div class="status"><span class="code">-1073414146</span><span class="msg">C:\\BUILDAGENTS\\SEABB\\_work\\71\\s\\RW\\Areas\\' +
  'RobApi2\\Components\\rws_rapid\\rws_resource_rapid_symbol_data.cpp[286] Symbol not found code:-1073414146 icode:-1</span></div></body></html>';

const FILES_V2 =
  '<html><head><base href="http://localhost:90/fileservice/%24home/"/></head><body><div class="state"><a href="" rel="self"></a><ul>' +
  '<li class="fs-dir" title="egm"> <a href="" rel="parent"></a> <a href="egm" rel="self"></a> <span class="fs-cdate">2026-07-16 T 01:11:22</span>' +
  '<span class="fs-mdate">2026-07-16 T 01:11:22</span> <span class="fs-readonly">false</span></li>' +
  '<li class="fs-file" title="a &amp; b.txt"> <a href="a%20%26%20b.txt" rel="self"></a> <span class="fs-size">12</span></li></ul></div></body></html>';

test("parseItems keeps each item's fields together", () => {
  const items = parseItems(SIGNALS_V1, "ios-signal-li");
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    cls: "ios-signal-li", title: "Net/Dev/DoOne",
    fields: { name: "DoOne", type: "DO", category: "x", lvalue: "1", lstate: "not simulated" },
  });
  // The second item has no category and no lstate: nothing shifts into it from its neighbour.
  assert.deepEqual(items[1].fields, { name: "DiTwo", type: "DI", lvalue: "0" });
});

test("parseItems without a class filter returns every li and decodes titles", () => {
  const items = parseItems(FILES_V2);
  assert.deepEqual(items.map((i) => [i.cls, i.title]), [["fs-dir", "egm"], ["fs-file", "a & b.txt"]]);
  assert.equal(items[1].fields["fs-size"], "12");
});

test("elog items carry title, description and code", () => {
  const [m] = parseItems(ELOG_V2, "elog-message-li");
  assert.equal(m.title, "/rw/elog/0/414607");
  assert.equal(m.fields.code, "10021");
  assert.equal(m.fields.title, "Execution error reset");
  assert.equal(m.fields.arg1, "3");
});

test("paging: next link is resolved against <base>, keeping only path and query", () => {
  assert.equal(nextHref(SIGNALS_V1), "signals?start=100&limit=100");
  assert.equal(baseHref(SIGNALS_V1), "http://localhost:80/rw/iosystem/");
  assert.equal(resolveNext(nextHref(SIGNALS_V1)!, baseHref(SIGNALS_V1), "/rw/iosystem/signals"), "/rw/iosystem/signals?start=100&limit=100");
  assert.equal(resolveNext(nextHref(ELOG_V2)!, baseHref(ELOG_V2), "/rw/elog/0?lang=en"), "/rw/elog/0?order=lifo&lang=en&start=2&limit=50");
  // Without a <base>, relative to the request path.
  assert.equal(resolveNext("signals?start=100", undefined, "/rw/iosystem/signals"), "/rw/iosystem/signals?start=100");
  // The controller's idea of its own host never leaks into our request.
  assert.equal(resolveNext("http://127.0.0.1/rw/x?start=2", undefined, "/rw/x"), "/rw/x?start=2");
  assert.equal(nextHref(FILES_V2), undefined);
});

test("rel attribute before href is still found", () => {
  assert.equal(nextHref('<a rel="next" href="x?start=3"></a>'), "x?start=3");
});

test("error bodies: code and the human part of the message", () => {
  assert.deepEqual(parseErrorBody(ERROR_V1), { code: "-1073414146", msg: "Symbol not found" });
  assert.deepEqual(parseErrorBody("<html>nothing</html>"), {});
  assert.deepEqual(parseErrorBody('<span class="code">-1</span><span class="msg">Just words</span>'), { code: "-1", msg: "Just words" });
  // The busy transient after a stop (measured on RobotWare 6.16): only the inner code is useful.
  const busy = '<div class="status"><span class="code">-1073414146</span><span class="msg">ERROR: C:\\BUILDAGENTS\\SEABB\\_work\\71\\s\\RW\\' +
    'Areas\\RobApi2\\Components\\rws_rapid\\rws_component_rapid.cpp[261]: org_code: -4503 new_code: 0xc0049007;</span></div>';
  assert.deepEqual(parseErrorBody(busy), { code: "-1073414146", controllerCode: "-4503" });
});

// Error bodies captured 2026-09-23 from the RobotWare 6.16 and 7.21 virtual controllers.
const errorBody = (code: string, msg: string) =>
  `<html><head><base href="http://localhost:80/"/></head><body><div class="status"><span class="code">${code}</span>` +
  `<span class="msg">${msg}</span></div></body></html>`;
// A motors-on refused while the controller is in emergency stop (the same body as in a latched
// guard stop): RWS's generic outer code, the controller's reason only in the icode.
const RW6_MOTORS_ON_REFUSED = errorBody("-1073414146", "C:\\BUILDAGENTS\\SEABB-IS-13906.1\\_work\\71\\s\\RW\\Areas\\RobApi2\\Components\\" +
  "rws_panel\\rws_resource_panel.cpp[929] code:-1073414146 icode:-1073445881");
const RW7_MOTORS_ON_REFUSED = errorBody("-1073445881", "rws_resource_panel.cpp[1448] code:-1073445881 icode:-1");
const RW6_MISSING_FILE = errorBody("-1073414146", "C:\\BUILDAGENTS\\SEABB-IS-13906.1\\_work\\71\\s\\RW\\Areas\\RobApi2\\Components\\" +
  "rapi_fileserv\\rapi_file_service.cpp[221] Resource does not exist -1073414146 -1");
const RW7_MISSING_MECHUNIT = errorBody("-1073445866",
  "rws_resource_motionsystem.cpp[7642] ERROR: da_motionsystem.cpp[285]: code: 0xc004a804 Mech unit ROB_9 does not exist; code:-1073445866 icode:-1073436668");
const UNRESOLVED_URL = errorBody("-1073445866", "rws_resource_rapid_module.cpp[1864] Unresolved url code:-1073445866 icode:-507");

test("error bodies: the inner code (icode) is kept, and -1 means there is none", () => {
  assert.deepEqual(parseErrorBody(RW6_MOTORS_ON_REFUSED), { code: "-1073414146", controllerCode: "-1073445881" });
  assert.deepEqual(parseErrorBody(RW7_MOTORS_ON_REFUSED), { code: "-1073445881" });
  assert.deepEqual(parseErrorBody(RW7_MISSING_MECHUNIT), {
    code: "-1073445866", controllerCode: "-1073436668", msg: "ERROR: da_motionsystem.cpp[285]: code: 0xc004a804 Mech unit ROB_9 does not exist;",
  });
  assert.deepEqual(parseErrorBody(UNRESOLVED_URL), { code: "-1073445866", controllerCode: "-507", msg: "Unresolved url" });
  // The file service's unlabelled "<code> <icode>" tail stays in the words; its icode is -1 anyway.
  assert.deepEqual(parseErrorBody(RW6_MISSING_FILE), { code: "-1073414146", msg: "Resource does not exist -1073414146 -1" });
});

test("hints: RWS's generic outer code -1073414146 claims nothing; SYS_CTRL_E_REJECT is named", () => {
  assert.equal(codeHint("-1073414146"), undefined);
  assert.match(codeHint("-1073445881") ?? "", /SYS_CTRL_E_REJECT/);
  assert.match(codeHint("-4503") ?? "", /busy/);
  assert.equal(codeHint(undefined), undefined);
});

test("firstSpan and entities", () => {
  assert.equal(firstSpan('<li><span class="value">&quot;v5.5.1&quot;</span></li>', "value"), '"v5.5.1"');
  assert.equal(firstSpan('<span class="rwversionname">7.21</span><span class="rwversion">7.21.0</span>', "rwversion"), "7.21.0");
  assert.equal(decodeEntities("&lt;a&gt; &amp;amp; &#65;&#x42; &bogus;"), "<a> &amp; AB &bogus;");
});

test("Digest: RFC 2617 known answer", () => {
  const ch = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  assert.equal(ch.realm, "testrealm@host.com");
  assert.equal(ch.qop, "auth,auth-int");
  const h = buildDigestHeader({
    method: "GET", uri: "/dir/index.html", user: "Mufasa", pass: "Circle Of Life", challenge: ch, nc: 1, cnonce: "0a4f113b",
  });
  assert.match(h, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(h, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
  assert.match(h, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
});

test("Digest: refuses algorithms and qops it cannot do", () => {
  assert.throws(() => buildDigestHeader({ method: "GET", uri: "/", user: "u", pass: "p", challenge: { algorithm: "SHA-256", nonce: "n" }, nc: 1, cnonce: "c" }), /SHA-256/);
  assert.throws(() => buildDigestHeader({ method: "GET", uri: "/", user: "u", pass: "p", challenge: { qop: "auth-int", nonce: "n" }, nc: 1, cnonce: "c" }), /auth-int/);
});

test("module header and ENDMODULE", () => {
  assert.deepEqual(parseModuleHeader("%%%\n  VERSION:1\n%%%\nMODULE Foo_1 (SYSMODULE, NOSTEPIN)\nENDMODULE"), { name: "Foo_1", system: true });
  assert.deepEqual(parseModuleHeader("  module bar\nendmodule"), { name: "bar", system: false });
  assert.equal(parseModuleHeader("PROC x() ENDPROC"), undefined);
  assert.equal(hasEndModule("MODULE a\n  ! ENDMODULE in a comment\n"), false);
  assert.equal(hasEndModule("MODULE a\nENDMODULE\n"), true);
});

test("first non-ASCII character is located", () => {
  assert.equal(firstNonAscii("MODULE a\n! plain\nENDMODULE"), undefined);
  const hit = firstNonAscii("MODULE a\n! caf" + String.fromCharCode(233) + "\nENDMODULE");
  assert.deepEqual(hit, { char: String.fromCharCode(233), line: 2, column: 6 });
});

test("module text comparison: equal modulo line endings, truncation vs difference", () => {
  assert.deepEqual(compareModuleText("MODULE a\r\n  x;  \r\nENDMODULE\r\n", "MODULE a\n  x;\nENDMODULE"), { equal: true });
  const big = "MODULE a\n" + Array.from({ length: 400 }, (_, i) => `  ! line ${i}`).join("\n") + "\nENDMODULE\n";
  const cut = compareModuleText(big, big.slice(0, 2000));
  assert.equal(cut.equal, false);
  assert.equal(cut.equal === false && cut.truncated, true);
  const diff = compareModuleText("MODULE a\n x;\nENDMODULE", "MODULE a\n y;\nENDMODULE");
  assert.equal(diff.equal === false && diff.truncated, false);
  assert.equal(diff.equal === false && diff.firstDifferentLine, 2);
});

test("file service paths: env var first and lowercase, segments encoded, no dot segments", () => {
  assert.equal(fileServicePath("$HOME"), "/fileservice/%24home");
  assert.equal(fileServicePath("$HOME/egm/Main Module.mod"), "/fileservice/%24home/egm/Main%20Module.mod");
  assert.equal(fileServicePath("/$temp\\x.txt"), "/fileservice/%24temp/x.txt");
  assert.equal(fileServicePath("$home//a/"), "/fileservice/%24home/a");
  assert.throws(() => fileServicePath("$home/../secret"), /'\.\.'/);
  assert.throws(() => fileServicePath("  "), /empty/);
});

test("text detection", () => {
  assert.equal(looksLikeText(new TextEncoder().encode("hello\nworld")), true);
  assert.equal(looksLikeText(new Uint8Array([104, 0, 105])), false);
  assert.equal(looksLikeText(new Uint8Array([0xc3, 0x28])), false);
});

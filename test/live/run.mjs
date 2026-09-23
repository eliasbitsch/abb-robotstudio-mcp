// Live end-to-end suite: drives the built MCP server (dist/index.js) over stdio, exactly as
// an MCP client does, against RobotStudio virtual controllers.
//
//   node test/live/run.mjs [section ...]      (no section = all)
//
// It ONLY runs against controllers that report themselves as VIRTUAL, and refuses to start
// otherwise. It changes controller state (motors, RAPID execution, test modules, I/O,
// configuration, restarts) and restores what it changes.
//
// Environment (defaults match a station with one RobotWare 6 and one RobotWare 7 VC):
//   LIVE_RW6=IRB2600   LIVE_RW7=omnicore-7-2600       station controller names
//   LIVE_RWS6=http://localhost:80   LIVE_RWS7=http://localhost:90   their RWS endpoints
//   LIVE_RWS7_TLS=https://localhost:91                 RW7 over HTTPS (self-signed)
//   LIVE_IO_SIGNAL=SafetyEnable                        a signal that is safe to toggle

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RW6 = process.env.LIVE_RW6 ?? "IRB2600";
const RW7 = process.env.LIVE_RW7 ?? "omnicore-7-2600";
const RWS6 = process.env.LIVE_RWS6 ?? "http://localhost:80";
const RWS7 = process.env.LIVE_RWS7 ?? "http://localhost:90";
const RWS7_TLS = process.env.LIVE_RWS7_TLS ?? "https://localhost:91";
const IO_SIGNAL = process.env.LIVE_IO_SIGNAL ?? "SafetyEnable";
const TASK = "T_ROB2";
const CTRLS = [RW6, RW7];

// ------------------------------------------------------------------ harness

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n        ${String(detail).slice(0, 700).replace(/\n/g, "\n        ")}` : ""}`); }
  return cond;
}

async function server(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(root, "dist/index.js")], cwd: root,
    env: { ...process.env, ...env }, stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d) => { stderr += d.toString(); });
  const client = new Client({ name: "live-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}

async function call(s, name, args = {}) {
  const r = await s.client.callTool({ name, arguments: args }, undefined, { timeout: 900000 });
  const text = r.content?.[0]?.text ?? "";
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { isError: !!r.isError, text, json };
}

async function ok(s, name, args, label) {
  const r = await call(s, name, args);
  check(label ?? `${name} ${JSON.stringify(args ?? {}).slice(0, 80)}`, !r.isError, r.text);
  return r;
}

async function err(s, name, args, re, label) {
  const r = await call(s, name, args);
  check(label ?? `${name} refuses: ${re}`, r.isError && re.test(r.text), r.text);
  return r;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function moduleCode(name, extra = "", body = "    nVal := nVal + 1;") {
  return [
    `MODULE ${name}`,
    "  VAR num nVal := 1;",
    "  PERS num pLive" + name.slice(-1) + " := 2;",
    "  CONST num cVal := 3;",
    '  VAR string sVal := "hi";',
    "  LOCAL VAR num nDup := 10;",
    extra,
    "  PROC live_proc()",
    body,
    "  ENDPROC",
    "ENDMODULE",
    "",
  ].join("\n");
}

function bigModule(name, lines) {
  const out = [`MODULE ${name}`];
  for (let i = 0; i < lines; i++) out.push(`  ! filler line ${String(i).padStart(5, "0")} ${"x".repeat(20)}`);
  out.push("  PROC big_proc()", "    TPWrite \"big\";", "  ENDPROC", "ENDMODULE", "");
  return out.join("\n");
}

async function statusOf(s, controller) {
  return (await call(s, "rs_controller_status", { controller })).json;
}

async function ensureStopped(s, controller) {
  const st = await statusOf(s, controller);
  if (st?.rapidExecution === "Running") await call(s, "rs_stop_program", { controller });
}

async function ensureMotorsOff(s, controller) {
  const st = await statusOf(s, controller);
  if (st?.controllerState === "MotorsOn") await call(s, "rs_set_motors", { controller, state: "off" });
}

// ------------------------------------------------------------------ sections

const sections = {};

sections.guard = async ({ rs, rws6, rws7 }) => {
  for (const c of CTRLS) {
    const st = await statusOf(rs, c);
    if (!st || st.isVirtual !== true) throw new Error(`refusing to run: controller ${c} is not reported as virtual (${JSON.stringify(st)})`);
  }
  for (const [s, url] of [[rws6, RWS6], [rws7, RWS7]]) {
    const st = (await call(s, "rws_controller_status")).json;
    if (!st || st.isVirtual !== true) throw new Error(`refusing to run: ${url} is not a virtual controller (${JSON.stringify(st)})`);
  }
  console.log("  (all targets are virtual controllers)");
};

sections.basics = async ({ rs }) => {
  const notes = rs.client.getInstructions() ?? "";
  check("the server sends its operating notes over stdio", notes.startsWith("Operating notes for abb-robotstudio") && notes.includes("rs_clear_guardstop"), notes.slice(0, 200));
  const p = await ok(rs, "rs_ping", {});
  check("ping reports a compatible add-in with a responsive UI", p.json?.compatible === true && p.json?.ui?.responsive === true && p.json?.stationOpen === true, p.text);
  const st = await ok(rs, "rs_get_station", {});
  check("station lists both controllers", CTRLS.every((c) => st.json?.controllers?.some((x) => x.name === c)), st.text);
  const objs = await ok(rs, "rs_get_station_objects", {});
  check("station objects are bounded (default depth 2, <= 300)", objs.json?.maxDepth === 2 && objs.json?.returned <= 300, objs.text.slice(0, 300));
  const few = await ok(rs, "rs_get_station_objects", { limit: 3 });
  check("limit 3 returns 3 and says truncated", few.json?.returned === 3 && few.json?.truncated === true, few.text.slice(0, 300));
  const mech = await ok(rs, "rs_get_station_objects", { type: "Mechanism" });
  check("type filter finds mechanisms", mech.json?.returned >= 2 && mech.json.objects.every((o) => o.type.includes("Mechanism")), mech.text.slice(0, 400));
  await err(rs, "rs_get_station_objects", { limit: 0 }, /limit|too_small|greater/i, "schema rejects limit 0");

  const lc = await ok(rs, "rs_list_controllers", { scan: true });
  check("discovery lists both VCs as virtual", CTRLS.every((c) => lc.json?.network?.some((n) => n.systemName === c && n.isVirtual === true && n.inStation === true)), lc.text.slice(0, 800));
  console.log("        (discovered: " + (lc.json?.network ?? []).map((n) => `${n.systemName}@${n.ip}${n.isVirtual ? "" : " REAL"}`).join(", ") + ")");

  // targeting
  await err(rs, "rs_controller_status", {}, /2 controllers.*pass `controller`/s, "no controller + 2 in station: refused, not guessed");
  const s6 = await ok(rs, "rs_controller_status", { controller: RW6 });
  check("RW6 status: RobotWare 6, virtual, tasks listed", /^6\./.test(s6.json?.robotWare ?? "") && s6.json?.isVirtual === true && s6.json?.tasks?.length >= 1, s6.text);
  const s7 = await ok(rs, "rs_controller_status", { controller: RW7.toUpperCase() });
  check("RW7 status by case-insensitive name: RobotWare 7", /^7\./.test(s7.json?.robotWare ?? ""), s7.text);
  await ok(rs, "rs_controller_status", { controller: s6.json.controller.systemId }, "controller by system id");
  await ok(rs, "rs_controller_status", { controller: `{${s6.json.controller.systemId.toUpperCase()}}` }, "controller by braced upper-case system id");
  await err(rs, "rs_controller_status", { controller: "127.0.0.1" }, /matches 2 controllers|pass the system id/i, "IP shared by two VCs: ambiguous, refused");
  await err(rs, "rs_controller_status", { controller: "no-such-controller" }, /No controller matching 'no-such-controller'/, "unknown controller: not found, with discovered list");
  if (s6.json?.controllerName && s6.json.controllerName !== RW6) {
    const byNet = await ok(rs, "rs_controller_status", { controller: s6.json.controllerName }, "network-discovery path (by controller name)");
    check("network path reaches the same controller", byNet.json?.systemName === RW6 && byNet.json?.controller?.inStation === false, byNet.text);
  }
};

sections["rapid-rs"] = async ({ rs }) => {
  for (const c of CTRLS) {
    console.log(`  -- ${c}`);
    await ensureStopped(rs, c);
    const tasks = await ok(rs, "rs_get_tasks", { controller: c });
    check("tasks include T_ROB1 and T_ROB2", ["T_ROB1", "T_ROB2"].every((t) => tasks.json?.some((x) => x.name === t)), tasks.text);
    await err(rs, "rs_get_modules", { controller: c }, /Pass `task`/, "two motion tasks and no task: refused");
    const mods = await ok(rs, "rs_get_modules", { controller: c, task: TASK });
    check("modules listed with flags", mods.json?.modules?.some((m) => m.name === "MainModule" && m.system === false), mods.text);
    const main = await ok(rs, "rs_read_module", { controller: c, task: TASK, module: "MainModule" });
    check("MainModule text read", /^\s*MODULE MainModule/m.test(main.json?.text ?? "") && main.json.length > 1000, main.text.slice(0, 200));
    await err(rs, "rs_read_module", { controller: c, task: TASK, module: "NoSuchMod" }, /not found.*Modules:/s, "missing module: not found, modules listed");
    await err(rs, "rs_read_module", { controller: c, task: "T_NOPE", module: "MainModule" }, /Task 'T_NOPE' not found/, "missing task");
    await err(rs, "rs_read_module", { controller: c, task: TASK, module: "bad name" }, /RAPID identifier/, "invalid identifier refused");
    if (c === RW6) await err(rs, "rs_read_module", { controller: c, task: "T_ROB1", module: "TuneMasterLib" }, /encoded/, "encoded module: refused with reason");

    // scratch module lifecycle
    for (const m of ["MCP_LIVE_A", "MCP_LIVE_B", "MCP_LIVE_BIG", "MCP_LIVE_R", "MCP_LIVE_RN", "MCP_LIVE_RB", "MCP_LIVE_M"]) await call(rs, "rs_delete_module", { controller: c, task: TASK, module: m });
    const v1 = moduleCode("MCP_LIVE_A");
    const add = await ok(rs, "rs_write_module", { controller: c, task: TASK, module: "MCP_LIVE_A", code: v1 }, "write new module");
    check("result is 'added'", add.json?.result === "added", add.text);
    let back = await ok(rs, "rs_read_module", { controller: c, task: TASK, module: "MCP_LIVE_A" });
    check("round trip is exact (modulo line endings)", back.json?.text?.replace(/\r\n/g, "\n").trim() === v1.trim(), back.json?.text);
    const v2 = v1.replace("nVal := 1;", "nVal := 7;");
    const rep = await ok(rs, "rs_write_module", { controller: c, task: TASK, module: "MCP_LIVE_A", code: v2 }, "replace module");
    check("result is 'replaced'", rep.json?.result === "replaced", rep.text);

    const syntax = v2.replace("nVal := nVal + 1;", "nVal := := 1;");
    const bad = await err(rs, "rs_write_module", { controller: c, task: TASK, module: "MCP_LIVE_A", code: syntax }, /reported errors.*previous version of the module was restored/s, "syntax error: refused and restored");
    check("syntax error carries positions", /"line":\s*\d+/.test(bad.text), bad.text);
    back = await ok(rs, "rs_read_module", { controller: c, task: TASK, module: "MCP_LIVE_A" });
    check("after the failed write the module is exactly the previous version", back.json?.text?.replace(/\r\n/g, "\n").trim() === v2.trim(), back.json?.text);
    const val = await ok(rs, "rs_read_variable", { controller: c, task: TASK, module: "MCP_LIVE_A", name: "nVal" });
    check("and its data still has the previous version's value (7)", val.json?.value === "7", val.text);

    const semantic = v2.replace("nVal := nVal + 1;", "nUndefinedThing := 5;");
    await err(rs, "rs_write_module", { controller: c, task: TASK, module: "MCP_LIVE_A", code: semantic }, /reported errors.*restored/s, "semantic error: refused and restored");
    await err(rs, "rs_write_module", { controller: c, task: TASK, module: "MCP_LIVE_B", code: moduleCode("MCP_LIVE_B", "", "    nVal := := 2;") }, /did not exist before, so it was removed/, "new module with errors: removed again");
    const mods2 = await ok(rs, "rs_get_modules", { controller: c, task: TASK });
    check("the failed new module is not loaded", !mods2.json?.modules?.some((m) => m.name === "MCP_LIVE_B"), mods2.text);
    await err(rs, "rs_write_module", { controller: c, task: TASK, module: "MCP_LIVE_A", code: semantic, on_error: "keep" }, /left loaded WITH these errors/, "on_error=keep leaves the broken module");
    await ok(rs, "rs_write_module", { controller: c, task: TASK, module: "MCP_LIVE_A", code: v2 }, "fix it again");
    await err(rs, "rs_write_module", { controller: c, task: TASK, module: "MCP_LIVE_A", code: moduleCode("OTHER_NAME") }, /declares MODULE OTHER_NAME but `module` is MCP_LIVE_A/, "name mismatch refused before touching the controller");
    await err(rs, "rs_write_module", { controller: c, task: TASK, module: "MCP_LIVE_A", code: "MODULE MCP_LIVE_A\n" }, /no ENDMODULE/, "missing ENDMODULE refused");
    const eAcute = String.fromCharCode(233);
    const unicode = moduleCode("MCP_LIVE_A", `  ! caf${eAcute} comment`);
    if (c === RW6) await err(rs, "rs_write_module", { controller: c, task: TASK, module: "MCP_LIVE_A", code: unicode }, /non-ASCII.*line 7, column 8/s, "RW6: non-ASCII refused with its position");
    else {
      await ok(rs, "rs_write_module", { controller: c, task: TASK, module: "MCP_LIVE_A", code: unicode }, "RW7: UTF-8 comment accepted");
      back = await ok(rs, "rs_read_module", { controller: c, task: TASK, module: "MCP_LIVE_A" });
      check("RW7: UTF-8 comment round-trips", (back.json?.text ?? "").includes(`caf${eAcute}`), back.json?.text?.slice(0, 300));
      await ok(rs, "rs_write_module", { controller: c, task: TASK, module: "MCP_LIVE_A", code: v2 }, "restore ASCII version");
    }
    const big = bigModule("MCP_LIVE_BIG", 2000);
    await ok(rs, "rs_write_module", { controller: c, task: TASK, module: "MCP_LIVE_BIG", code: big }, `big module (${big.length} chars)`);
    back = await ok(rs, "rs_read_module", { controller: c, task: TASK, module: "MCP_LIVE_BIG" });
    check("big module round-trips whole", back.json?.text?.replace(/\r\n/g, "\n").trim() === big.trim(), `stored ${back.json?.length}`);
    await ok(rs, "rs_delete_module", { controller: c, task: TASK, module: "MCP_LIVE_BIG" });
    await err(rs, "rs_delete_module", { controller: c, task: TASK, module: "MCP_LIVE_BIG" }, /not found/, "delete of an absent module: not found");

    // variables
    const r1 = await ok(rs, "rs_read_variable", { controller: c, task: TASK, name: "nVal" }, "read without module (search)");
    check("found in MCP_LIVE_A, VAR num", r1.json?.module === "MCP_LIVE_A" && r1.json?.storage === "VAR" && r1.json?.dataType === "num", r1.text);
    const w1 = await ok(rs, "rs_write_variable", { controller: c, task: TASK, module: "MCP_LIVE_A", name: "nVal", value: "42" });
    check("write returns previous and new value", w1.json?.previous === "7" && w1.json?.value === "42", w1.text);
    await ok(rs, "rs_write_variable", { controller: c, task: TASK, name: "pLiveA", value: "43" }, "PERS write");
    await err(rs, "rs_write_variable", { controller: c, task: TASK, module: "MCP_LIVE_A", name: "cVal", value: "44" }, /CONST/, "CONST refused");
    await err(rs, "rs_write_variable", { controller: c, task: TASK, module: "MCP_LIVE_A", name: "nVal", value: "abc" }, /not a valid num literal/, "bad literal: refused with a hint");
    await err(rs, "rs_write_variable", { controller: c, task: TASK, module: "MCP_LIVE_A", name: "sVal", value: "hello" }, /not a valid string literal/, "unquoted string refused");
    const ws = await ok(rs, "rs_write_variable", { controller: c, task: TASK, module: "MCP_LIVE_A", name: "sVal", value: '"hello"' }, "quoted string");
    check("string round trip", ws.json?.value === '"hello"', ws.text);
    await err(rs, "rs_read_variable", { controller: c, task: TASK, name: "nNoSuchVar" }, /not found/, "missing variable");
    await ok(rs, "rs_write_module", { controller: c, task: TASK, module: "MCP_LIVE_B", code: "MODULE MCP_LIVE_B\n  LOCAL VAR num nDup := 20;\nENDMODULE\n" }, "second module with the same LOCAL name");
    await err(rs, "rs_read_variable", { controller: c, task: TASK, name: "nDup" }, /more than one module/, "same LOCAL name in two modules: ambiguous, refused");
    const dup = await ok(rs, "rs_read_variable", { controller: c, task: TASK, module: "MCP_LIVE_B", name: "nDup" }, "with module: resolved");
    check("LOCAL data reported as local", dup.json?.isLocal === true, dup.text);
    for (const m of ["MCP_LIVE_A", "MCP_LIVE_B"]) await ok(rs, "rs_delete_module", { controller: c, task: TASK, module: m }, `cleanup ${m}`);
  }
};

sections["io-rs"] = async ({ rs }) => {
  for (const c of CTRLS) {
    console.log(`  -- ${c}`);
    const all = await ok(rs, "rs_get_io_signals", { controller: c });
    check("signals listed with totals", all.json?.total > 0 && all.json.signals.length === Math.min(all.json.matched, 500), all.text.slice(0, 300));
    const dos = await ok(rs, "rs_get_io_signals", { controller: c, type: "DO", limit: 2 });
    check("type filter + limit", dos.json?.signals.every((s) => s.type === "DO") && dos.json.signals.length <= 2, dos.text.slice(0, 300));
    // Toggle only the documented inert signal; elsewhere write the current value back (a real
    // write through the API that changes nothing).
    let name = IO_SIGNAL;
    let sig = await call(rs, "rs_read_io", { controller: c, signal: name });
    const toggle = !sig.isError;
    if (!toggle) {
      name = process.env.LIVE_IO_SIGNAL_RW7 ?? "ManRS";
      sig = await ok(rs, "rs_read_io", { controller: c, signal: name }, `${IO_SIGNAL} absent; read ${name} instead`);
      if (sig.isError) continue;
    }
    const original = sig.json.value;
    if (toggle) {
      const flipped = original === 1 ? 0 : 1;
      const w = await ok(rs, "rs_write_io", { controller: c, signal: name, value: flipped }, `toggle ${name}`);
      check("value read back after the write", w.json?.after?.value === flipped, w.text);
    }
    const same = await call(rs, "rs_write_io", { controller: c, signal: name, value: original });
    if (toggle) check("restore it: before/after reported", !same.isError && same.json?.after?.value === original, same.text);
    else check(`write ${name}'s current value back: written, or refused by the controller's access restriction and said so`,
      same.isError ? /access restriction/.test(same.text) : same.json?.after?.value === original, same.text);
    await err(rs, "rs_write_io", { controller: c, signal: name, value: 2 }, /must be 0 or 1/, "digital value 2 refused");
    await err(rs, "rs_read_io", { controller: c, signal: "NoSuchSignalXyz" }, /not found/, "missing signal");
    await err(rs, "rs_read_io", { controller: c, signal: `SomeNet/WrongDevice/${name}` }, /on device/, "path with the wrong device refused");
    if (sig.json.device) await ok(rs, "rs_read_io", { controller: c, signal: `x/${sig.json.device}/${name}` }, "path form with the right device");
  }
};

sections["config-rs"] = async ({ rs }) => {
  for (const c of CTRLS) {
    console.log(`  -- ${c}`);
    const moc = await ok(rs, "rs_read_config", { controller: c, domain: "MOC" });
    check("MOC domain read live", /^MOC:CFG_/.test(moc.json?.content ?? ""), moc.text.slice(0, 200));
    await ok(rs, "rs_read_config", { controller: c, domain: "sys.cfg" }, "'.cfg' suffix and case accepted");
    await err(rs, "rs_read_config", { controller: c, domain: "NOPE" }, /not found. Domains:/, "unknown domain lists domains");
    const path = { controller: c, domain: "MOC", type: "ARM", instance: "rob1_1", attribute: "upper_joint_bound" };
    const v = await ok(rs, "rs_read_config_value", path);
    check("MOC/ARM/rob1_1/upper_joint_bound is ~pi", Math.abs(Number(v.json?.value) - Math.PI) < 1e-4, v.text);
    const same = await ok(rs, "rs_write_config_value", { ...path, value: v.json.value }, "write the same value back");
    check("write reports previous and value, restartRequired", same.json?.previous === v.json.value && same.json?.restartRequired === true, same.text);
    await err(rs, "rs_read_config_value", { ...path, instance: "no_such_arm" }, /Could not read/, "missing instance");
    const sio = await ok(rs, "rs_read_config", { controller: c, domain: "SIO" });
    await ok(rs, "rs_write_config", { controller: c, content: sio.json.content, mode: "replace" }, "reload SIO unchanged (no-op load)");
    await err(rs, "rs_write_config", { controller: c, content: "hello" }, /configuration file/, "not a cfg file: refused");
    await err(rs, "rs_write_config", { controller: c, content: "XYZ:CFG_1.0:6:0::\n" }, /domain 'XYZ' not found/, "unknown domain in header");
  }
};

sections.eventlog = async ({ rs, rws6, rws7 }) => {
  for (const c of CTRLS) {
    const e = await ok(rs, "rs_event_log", { controller: c, count: 5 });
    const seqs = (e.json?.messages ?? []).map((m) => m.seq);
    check(`${c}: 5 messages, newest first`, seqs.length === 5 && seqs.every((s, i) => i === 0 || s < seqs[i - 1]), e.text.slice(0, 400));
    const since = await ok(rs, "rs_event_log", { controller: c, since_seq: seqs[2] });
    check(`${c}: since_seq returns only newer messages`, since.json?.messages?.length === 2, since.text.slice(0, 300));
    await err(rs, "rs_event_log", { controller: c, category: 99 }, /not found/, `${c}: unknown category`);
  }
  for (const [s, gen] of [[rws6, "RWS 1.0"], [rws7, "RWS 2.0"]]) {
    const e = await ok(s, "rws_event_log", { count: 60 });
    const seqs = (e.json ?? []).map((m) => m.seq);
    check(`${gen}: 60 messages across pages, newest first`, seqs.length === 60 && seqs.every((q, i) => i === 0 || q < seqs[i - 1]), JSON.stringify(seqs.slice(0, 8)));
  }
};

sections.position = async ({ rs, rws6, rws7 }) => {
  const all = await ok(rs, "rs_get_position", {});
  check("every station controller, joints as numbers", all.json?.length === 2 && all.json.every((c) => c.units?.every((u) => u.joints_deg?.length === 6 && u.joints_deg.every(Number.isFinite))), all.text.slice(0, 500));
  const one = await ok(rs, "rs_get_position", { controller: RW7 });
  check("one controller when named", one.json?.length === 1 && one.json[0].controller === RW7, one.text.slice(0, 300));
  for (const [s, gen] of [[rws6, "RWS 1.0"], [rws7, "RWS 2.0"]]) {
    const p = await ok(s, "rws_get_position", {});
    check(`${gen}: numeric joints and TCP`, p.json?.joints_deg?.every(Number.isFinite) && Number.isFinite(p.json?.tcp_mm?.x), p.text);
    await err(s, "rws_get_position", { mechunit: "ROB_9" }, /HTTP 4\d\d/, `${gen}: unknown mechanical unit is an error, not blanks`);
  }
};

sections.program = async ({ rs, rws6, rws7 }) => {
  for (const [c, s, gen] of [[RW6, rws6, "RWS 1.0"], [RW7, rws7, "RWS 2.0"]]) {
    console.log(`  -- ${c}`);
    await ensureStopped(rs, c);
    const on = await ok(rs, "rs_set_motors", { controller: c, state: "on" });
    check("rs motors on", on.json?.controllerState === "MotorsOn", on.text);
    const off = await ok(rs, "rs_set_motors", { controller: c, state: "off" });
    check("rs motors off", off.json?.controllerState === "MotorsOff", off.text);
    const on2 = await ok(s, "rws_set_motors", { state: "on" });
    check(`${gen} motors on`, on2.json?.controllerState === "motoron", on2.text);

    // A routine that runs until stopped and moves nothing, in both motion tasks (a start runs
    // every task from its program pointer; the only other program here exits after ~1 s).
    const loop = "MODULE MCP_LIVE_RUN\n  PROC mcp_live_loop()\n    WHILE TRUE DO\n      WaitTime 0.2;\n    ENDWHILE\n  ENDPROC\nENDMODULE\n";
    for (const t of ["T_ROB1", "T_ROB2"]) {
      await call(rs, "rs_delete_module", { controller: c, task: t, module: "MCP_LIVE_RUN" });
      await ok(rs, "rs_write_module", { controller: c, task: t, module: "MCP_LIVE_RUN", code: loop }, `load the loop routine into ${t}`);
      const pp = await ok(rs, "rs_set_program_pointer", { controller: c, task: t, module: "MCP_LIVE_RUN", routine: "mcp_live_loop" }, `PP to the loop in ${t}`);
      check("program pointer reported at the routine", pp.json?.routine === "mcp_live_loop", pp.text);
    }
    await err(rs, "rs_set_program_pointer", { controller: c, task: TASK, module: "MCP_LIVE_RUN", routine: "no_such_routine" }, /Could not set the program pointer/, "PP to a missing routine refused");
    await ok(rs, "rs_set_program_pointer", { controller: c, task: TASK, module: "MCP_LIVE_RUN", routine: "mcp_live_loop" }, "PP back to the loop");
    const start = await ok(rs, "rs_start_program", { controller: c });
    check("rs start: running", start.json?.rapidExecution === "Running", start.text);
    await sleep(1500);
    check("still running 1.5 s later", (await statusOf(rs, c))?.rapidExecution === "Running");
    await err(rs, "rs_write_module", { controller: c, task: TASK, module: "MCP_LIVE_A", code: moduleCode("MCP_LIVE_A") }, /is running/i, "module write refused while running");
    await err(rs, "rs_delete_module", { controller: c, task: TASK, module: "MCP_LIVE_RUN" }, /is running/i, "module delete refused while running");
    await err(rs, "rs_reset_pp", { controller: c }, /running/i, "PP reset refused while running");
    await err(rs, "rs_set_program_pointer", { controller: c, task: TASK, module: "MCP_LIVE_RUN", routine: "mcp_live_loop" }, /is running/i, "PP move refused while running");
    await err(s, "rws_write_module", { task: TASK, module: "MCP_LIVE_A", code: moduleCode("MCP_LIVE_A") }, /running/i, `${gen} module write refused while running`);
    const stop = await ok(rs, "rs_stop_program", { controller: c });
    check("rs stop: stopped", stop.json?.rapidExecution === "Stopped", stop.text);

    for (const t of ["T_ROB1", "T_ROB2"])
      await ok(s, "rws_set_program_pointer", { task: t, module: "MCP_LIVE_RUN", routine: "mcp_live_loop" }, `${gen} PP to the loop in ${t}`);
    const rstart = await ok(s, "rws_start_program", {});
    check(`${gen} start: running`, rstart.json?.state === "running", rstart.text);
    await sleep(1500);
    check(`${gen} still running 1.5 s later`, (await call(s, "rws_execution_state", {})).json?.state === "running");
    const rstop = await ok(s, "rws_stop_program", {});
    check(`${gen} stop: stopped`, rstop.json?.state === "stopped", rstop.text);
    await ok(s, "rws_reset_pp", {}, `${gen} PP to main right after a stop (busy transient retried)`);
    await ok(rs, "rs_reset_pp", { controller: c, task: "T_ROB1" }, "rs PP to main in one task");
    for (const t of ["T_ROB1", "T_ROB2"]) await ok(rs, "rs_delete_module", { controller: c, task: t, module: "MCP_LIVE_RUN" }, `remove the loop from ${t}`);
    const off2 = await ok(s, "rws_set_motors", { state: "off" });
    check(`${gen} motors off`, off2.json?.controllerState === "motoroff", off2.text);
    const ex = await ok(s, "rws_execution_state", {});
    check(`${gen} execution state reads stopped`, ex.json?.state === "stopped", ex.text);
    const mods = (await call(rs, "rs_get_modules", { controller: c, task: TASK })).json?.modules ?? [];
    check("no test module left in the task", !mods.some((m) => m.name.startsWith("MCP_LIVE")), JSON.stringify(mods.map((m) => m.name)));
  }
};

sections.panel = async ({ rs, rws6, rws7 }) => {
  for (const c of CTRLS) {
    console.log(`  -- ${c}`);
    await ensureStopped(rs, c);
    await ensureMotorsOff(rs, c);
    await err(rs, "rs_clear_guardstop", { controller: c }, /not stopped; there is nothing to clear/, "not stopped: refused without force");
    const mark = (await call(rs, "rs_event_log", { controller: c, count: 1 })).json?.messages?.[0]?.seq ?? 0;
    const press = await ok(rs, "rs_set_estop", { controller: c, state: "press" });
    check("press: EmergencyStop", press.json?.controllerState === "EmergencyStop" && press.json?.estopPressed === true, press.text);
    const rwsNow = (await call(c === RW6 ? rws6 : rws7, "rws_controller_status", {})).json?.controllerState;
    check("the press outlives the call (RWS, which opens no PC SDK connection, reads emergencystop)", rwsNow === "emergencystop", rwsNow);
    const cleared = await ok(rs, "rs_clear_guardstop", { controller: c }, "clear from a pressed e-stop");
    check("cleared to MotorsOn", cleared.json?.controllerState === "MotorsOn", cleared.text);
    if (c === RW7) check("RW7: the press persisted and its press step was skipped", cleared.json?.before === "EmergencyStop" && /already pressed/.test(JSON.stringify(cleared.json?.steps)), cleared.text);
    else check("RW6: connecting released the press (EmergencyStopReset) and the note says so", cleared.json?.before === "EmergencyStopReset" && /reset their virtual panel whenever a PC SDK client connects/.test(cleared.json?.note ?? ""), cleared.text);
    const since = (await call(rs, "rs_event_log", { controller: c, since_seq: mark, count: 200 })).json?.messages ?? [];
    check("no self-inflicted 90202 'Emergency Stop open' error", !since.some((m) => m.code === 90202), JSON.stringify(since.map((m) => `${m.code} ${m.title}`)));
    const forced = await ok(rs, "rs_clear_guardstop", { controller: c, force: true, motors_on: false }, "force from MotorsOn, no motors-on");
    check("forced pulse ends motors off", ["MotorsOff", "EmergencyStopReset"].includes(forced.json?.controllerState), forced.text);
    const p2 = await ok(rs, "rs_set_estop", { controller: c, state: "press" });
    const rel = await ok(rs, "rs_set_estop", { controller: c, state: "release" });
    check("release leaves e-stop state", p2.json?.controllerState === "EmergencyStop" && !["EmergencyStop", "GuardStop"].includes(rel.json?.controllerState), rel.text);
    await ensureMotorsOff(rs, c);
  }
};

sections.sim = async ({ rs }) => {
  const st = await ok(rs, "rs_simulation_status", {});
  check("status has simulation state and saved states", typeof st.json?.simulation?.state === "string" && Array.isArray(st.json?.savedStates), st.text);
  await err(rs, "rs_pause_simulation", {}, /not running/, "pause while not running: refused");
  const sp = await ok(rs, "rs_set_sim_speed", { speed: 0.5 });
  check("speed set", sp.json?.speed === 0.5, sp.text);
  await ok(rs, "rs_set_sim_speed", { speed: 1 }, "speed restored");
  await err(rs, "rs_set_sim_speed", { speed: 0 }, /0\.01|too_small|greater/i, "speed 0 refused");
  const saved = st.json?.savedStates ?? [];
  if (saved.length === 0) await err(rs, "rs_reset_simulation", {}, /no saved states/, "reset with no saved states: refused, nothing changed");
  else console.log("        (station has saved states; reset not exercised to avoid changing the station)");
  const start = await ok(rs, "rs_start_simulation", {});
  check("simulation running", start.json?.state === "Running", start.text);
  // This station's simulation can end on its own within a second (its programs stop), so
  // pause right away and accept "already stopped" as the one legitimate other outcome.
  const pause = await call(rs, "rs_pause_simulation", {});
  if (pause.isError) check("pause: refused only because the simulation already ended", /is Stopped, not running|is Ready, not running/.test(pause.text), pause.text);
  else check("simulation paused", pause.json?.state === "Paused", pause.text);
  const stop = await ok(rs, "rs_stop_simulation", {});
  check("simulation stopped", ["Stopped", "Ready"].includes(stop.json?.state), stop.text);
  for (const c of CTRLS) { await ensureStopped(rs, c); await ensureMotorsOff(rs, c); }
};

sections.paths = async ({ rs }) => {
  const paths = await ok(rs, "rs_get_paths", { controller: RW6 });
  check("paths carry controller/task/module", paths.json?.length > 0 && paths.json.every((p) => p.controller === RW6 && p.task && p.name), paths.text.slice(0, 300));
  await err(rs, "rs_get_paths", { controller: "nope" }, /not a controller in the active station/, "unknown station controller");
  await err(rs, "rs_get_path_targets", { controller: RW6, path: "main" }, /matches \d+ paths/, "same path name in two tasks: ambiguous, refused");
  const pt = await ok(rs, "rs_get_path_targets", { controller: RW6, task: "T_ROB1", path: "main" });
  check("main's moves report their joint targets", pt.json?.instructions?.some((i) => i.toJointTarget?.name === "jWake") && pt.json.instructions.some((i) => i.toJointTarget?.name === "jHome"), pt.text.slice(0, 800));
  for (const n of ["MCP_LIVE_T1", "MCP_LIVE_T2"]) await call(rs, "rs_delete_target", { controller: RW6, task: "T_ROB1", name: n });
  await call(rs, "rs_delete_path", { controller: RW6, task: "T_ROB1", name: "MCP_LIVE_PATH" });
  const cp = await ok(rs, "rs_create_path", { controller: RW6, task: "T_ROB1", name: "MCP_LIVE_PATH" });
  check("path created", cp.json?.created === true, cp.text);
  await err(rs, "rs_create_path", { controller: RW6, task: "T_ROB1", name: "MCP_LIVE_PATH" }, /already has a path/, "duplicate path refused");
  const t1 = await ok(rs, "rs_create_target", { controller: RW6, task: "T_ROB1", name: "MCP_LIVE_T1", x: 1000, y: -250.5, z: 1200, rx: 0, ry: 180, rz: 0 });
  const tj = t1.json?.target ?? {};
  check("target position is in mm (not metres)", tj.x_mm === 1000 && tj.y_mm === -250.5 && tj.z_mm === 1200, t1.text);
  check("ry=180 gives q ~ [0,0,1,0] (tool pointing down)", Math.abs(Math.abs(tj.q3) - 1) < 1e-6 && Math.abs(tj.q1) < 1e-6, t1.text);
  const t2 = await ok(rs, "rs_create_target", { controller: RW6, task: "T_ROB1", name: "MCP_LIVE_T2", x: 0, y: 0, z: 500, q1: 2, q2: 0, q3: 0, q4: 0 });
  check("unnormalized quaternion normalized", Math.abs(t2.json?.target?.q1 - 1) < 1e-9, t2.text);
  await err(rs, "rs_create_target", { controller: RW6, task: "T_ROB1", name: "MCP_LIVE_T3", x: 0, y: 0, z: 0, q1: 1 }, /all four of q1\.\.q4/, "partial quaternion refused");
  await err(rs, "rs_create_target", { controller: RW6, task: "T_ROB1", name: "MCP_LIVE_T3", x: 0, y: 0, z: 0, q1: 1, q2: 0, q3: 0, q4: 0, rx: 0, ry: 0, rz: 0 }, /not both/, "quaternion and Euler together refused");
  await err(rs, "rs_create_target", { controller: RW6, task: "T_ROB1", name: "MCP_LIVE_T1", x: 0, y: 0, z: 0 }, /already has data named/, "duplicate target refused");
  await err(rs, "rs_create_target", { controller: RW6, task: "T_ROB1", name: "MCP_LIVE_T3", x: 0, y: 0, z: 0, workobject: "wobjNope" }, /Work object 'wobjNope' not found/, "unknown work object");
  for (const n of ["MCP_LIVE_T1", "MCP_LIVE_T2"]) await ok(rs, "rs_delete_target", { controller: RW6, task: "T_ROB1", name: n }, `delete ${n}`);
  await ok(rs, "rs_delete_path", { controller: RW6, task: "T_ROB1", name: "MCP_LIVE_PATH" }, "delete path");
  await err(rs, "rs_delete_path", { controller: RW6, task: "T_ROB1", name: "MCP_LIVE_PATH" }, /not found/, "delete of an absent path");
};

sections.collisions = async ({ rs }) => {
  const st = (await call(rs, "rs_get_station", {})).json;
  if ((st?.collisionSets ?? []).length === 0)
    await err(rs, "rs_check_collisions", {}, /no collision sets/, "no sets: refused with guidance");
  const mechs = (await call(rs, "rs_get_station_objects", { type: "Mechanism", max_depth: 1 })).json?.objects ?? [];
  if (mechs.length >= 2) {
    const r = await ok(rs, "rs_check_collisions", { objects: [mechs[0].path, mechs[1].path], near_miss_mm: 5000 });
    check("pairwise check ran and reports near misses at 5 m", r.json?.pairsChecked === 1 && Array.isArray(r.json?.results), r.text);
  } else check("two mechanisms available for the pairwise check", false, JSON.stringify(mechs));
  await err(rs, "rs_check_collisions", { objects: ["nope_a", "nope_b"] }, /No station object named 'nope_a'/, "unknown object");
  await err(rs, "rs_check_collisions", { objects: ["only_one"] }, /at least two/, "one object refused");
};

sections["rws-rapid"] = async ({ rs, rws6, rws7 }) => {
  for (const [c, s, gen] of [[RW6, rws6, "RWS 1.0"], [RW7, rws7, "RWS 2.0"]]) {
    console.log(`  -- ${gen}`);
    await ensureStopped(rs, c);
    const st = await ok(s, "rws_controller_status", {});
    check(`${gen}: status with identity`, st.json?.rwsApi === (gen === "RWS 1.0" ? "1.0" : "2.0") && st.json?.isVirtual === true, st.text);
    const tasks = await ok(s, "rws_get_tasks", {});
    check("tasks parsed per item", tasks.json?.some((t) => t.name === "T_ROB1" && t.motionTask !== undefined), tasks.text);
    const mods = await ok(s, "rws_get_modules", { task: TASK });
    check("modules listed", mods.json?.some((m) => m.name === "MainModule"), mods.text);
    const main = await ok(s, "rws_read_module", { task: TASK, module: "MainModule" });
    check("MainModule text", /MODULE MainModule/.test(main.json?.text ?? ""), main.text.slice(0, 200));
    for (const m of ["MCP_LIVE_R", "MCP_LIVE_RB", "MCP_LIVE_RN", "MCP_LIVE_A", "MCP_LIVE_M"]) await call(s, "rws_delete_module", { task: TASK, module: m });
    const code = moduleCode("MCP_LIVE_R");
    const add = await ok(s, "rws_write_module", { task: TASK, module: "MCP_LIVE_R", code });
    check("added and verified", add.json?.result === "added" && add.json?.verified === true, add.text);
    const code2 = code.replace("nVal := 1;", "nVal := 5;");
    const rep = await ok(s, "rws_write_module", { task: TASK, module: "MCP_LIVE_R", code: code2 });
    check("replaced and verified", rep.json?.result === "replaced", rep.text);
    const big = bigModule("MCP_LIVE_RB", 2000);
    const b = await ok(s, "rws_write_module", { task: TASK, module: "MCP_LIVE_RB", code: big }, `big module via RWS (${big.length} chars; the old form endpoint truncated ~30 KB)`);
    check("big module verified whole", b.json?.verified === true, b.text);
    await ok(s, "rws_delete_module", { task: TASK, module: "MCP_LIVE_RB" });
    const synErr = await err(s, "rws_write_module", { task: TASK, module: "MCP_LIVE_R", code: code2.replace("nVal := nVal + 1;", "nVal := := 1;") }, /reported errors.*previous version was restored/s, "syntax error via RWS: detected, refused and restored");
    check("the controller's own load error is quoted", /40322|Load error|Errors in RAPID program/.test(synErr.text), synErr.text);
    await err(s, "rws_write_module", { task: TASK, module: "MCP_LIVE_R", code: code2.replace("nVal := nVal + 1;", "nUndefinedThing := 5;") }, /reported errors.*restored/s, "semantic error via RWS: detected, refused and restored");
    const back = await ok(s, "rws_read_module", { task: TASK, module: "MCP_LIVE_R" });
    check("module is the previous version after the failed RWS write", back.json?.text?.replace(/\r\n/g, "\n").trim() === code2.trim(), back.json?.text?.slice(0, 300));
    await err(s, "rws_write_module", { task: TASK, module: "MCP_LIVE_RN", code: moduleCode("MCP_LIVE_RN", "", "    nVal := := 1;") }, /removed again/, "new broken module via RWS: removed again");
    const mods2 = await ok(s, "rws_get_modules", { task: TASK });
    check("broken module not left loaded", !mods2.json?.some((m) => m.name === "MCP_LIVE_RN"), mods2.text);
    await err(s, "rws_write_module", { task: TASK, module: "MCP_LIVE_R", code: moduleCode("WRONG") }, /declares MODULE WRONG/, "name mismatch");
    const rv = await ok(s, "rws_read_variable", { task: TASK, module: "MCP_LIVE_R", variable: "nVal" });
    check("variable read", rv.json?.value === "5", rv.text);
    const wv = await ok(s, "rws_write_variable", { task: TASK, module: "MCP_LIVE_R", variable: "nVal", value: "9" });
    check("variable write returns previous and new", wv.json?.previous === "5" && wv.json?.value === "9", wv.text);
    const sv = await ok(s, "rws_write_variable", { task: TASK, module: "MCP_LIVE_R", variable: "sVal", value: '"a+b c"' });
    check("string with '+' and space survives form encoding", sv.json?.value === '"a+b c"', sv.text);
    await err(s, "rws_write_variable", { task: TASK, module: "MCP_LIVE_R", variable: "nVal", value: "abc" }, /HTTP 4\d\d/, "bad literal is an error");
    await err(s, "rws_read_variable", { task: TASK, module: "MCP_LIVE_R", variable: "nNope" }, /HTTP 4\d\d/, "missing variable is an error, not an HTML dump");
    await ok(s, "rws_delete_module", { task: TASK, module: "MCP_LIVE_R" });
    await err(s, "rws_delete_module", { task: TASK, module: "MCP_LIVE_R" }, /not loaded/, "delete absent module");
    const home = (await call(s, "rws_list_files", {})).json?.files ?? [];
    check("no temporary upload left in HOME", !home.some((f) => f.name.startsWith("_mcp_tmp_")), JSON.stringify(home.map((f) => f.name).filter((n) => n.startsWith("_mcp_tmp_"))));
  }
};

sections["rws-io"] = async ({ rws6, rws7 }) => {
  for (const [s, gen] of [[rws6, "RWS 1.0"], [rws7, "RWS 2.0"]]) {
    console.log(`  -- ${gen}`);
    const all = await ok(s, "rws_get_io_signals", {});
    const total = all.json?.total ?? 0;
    check("every page listed", total > 0 && all.json.signals.length === total, `total ${total}`);
    if (total > 100) {
      const late = all.json.signals[total - 5];
      const r = await ok(s, "rws_read_io", { signal: late.name }, `bare name from page ${Math.floor((total - 5) / 100) + 1} (${late.name})`);
      check("resolved to its full path", r.json?.signal === late.path, r.text);
    } else console.log(`        (${total} signals: one page)`);
    let sig = all.json.signals.find((x) => x.name === IO_SIGNAL);
    const toggle = !!sig;
    if (!sig) sig = all.json.signals.find((x) => x.name === (process.env.LIVE_IO_SIGNAL_RW7 ?? "ManRS"));
    if (!sig) { check("a signal to write", false); continue; }
    if (toggle) {
      const flipped = sig.value === 1 ? 0 : 1;
      const w = await ok(s, "rws_write_io", { signal: sig.name, value: flipped }, "write by bare name");
      check("value read back", w.json?.value === flipped && w.json?.signal === sig.path, w.text);
      await ok(s, "rws_write_io", { signal: sig.path, value: sig.value }, "restore by full path");
    } else {
      const w = await call(s, "rws_write_io", { signal: sig.name, value: sig.value });
      check(`write ${sig.name}'s current value back by bare name: written, or refused by the controller and said so`,
        w.isError ? /HTTP 4\d\d \(-?\d+/.test(w.text) : w.json?.value === sig.value && w.json?.signal === sig.path, w.text);
    }
    await err(s, "rws_read_io", { signal: "NoSuchSignalXyz" }, /No I\/O signal named/, "missing signal");
  }
};

sections["rws-files"] = async ({ rws6, rws7 }) => {
  for (const [s, gen] of [[rws6, "RWS 1.0"], [rws7, "RWS 2.0"]]) {
    console.log(`  -- ${gen}`);
    const ls = await ok(s, "rws_list_files", {});
    check("home listed", Array.isArray(ls.json?.dirs) && Array.isArray(ls.json?.files), ls.text.slice(0, 200));
    await call(s, "rws_delete_file", { path: "$home/_mcp_live/t.txt" });
    await call(s, "rws_delete_file", { path: "$home/_mcp_live/b.bin" });
    await call(s, "rws_delete_file", { path: "$home/_mcp_live" });
    await ok(s, "rws_create_directory", { path: "$HOME/_mcp_live" }, "create directory ($HOME upper case accepted)");
    const text = "line one\nline two with + and & and %20\n";
    await ok(s, "rws_write_file", { path: "$home/_mcp_live/t.txt", content: text });
    const rt = await ok(s, "rws_read_file", { path: "$home/_mcp_live/t.txt" });
    check("text round trip", rt.json?.encoding === "utf8" && rt.json?.content === text, rt.text);
    const bin = Buffer.from([0, 1, 2, 255, 254, 0, 10]).toString("base64");
    await ok(s, "rws_write_file", { path: "$home/_mcp_live/b.bin", content: bin, encoding: "base64" });
    const rb = await ok(s, "rws_read_file", { path: "$home/_mcp_live/b.bin" });
    check("binary round trip as base64", rb.json?.encoding === "base64" && rb.json?.content === bin, rb.text);
    const sub = await ok(s, "rws_list_files", { path: "$home/_mcp_live" });
    check("listing shows both files with sizes", sub.json?.files?.length === 2 && sub.json.files.some((f) => f.name === "b.bin" && f.size === 7), sub.text);
    await err(s, "rws_read_file", { path: "$home/_mcp_live/nope.txt" }, /HTTP 4\d\d/, "missing file is an error, not its error page as content");
    await err(s, "rws_read_file", { path: "$home/../x" }, /'\.\.'/, "'..' refused");
    for (const f of ["t.txt", "b.bin"]) await ok(s, "rws_delete_file", { path: `$home/_mcp_live/${f}` });
    await ok(s, "rws_delete_file", { path: "$home/_mcp_live" }, "delete the directory");
    const after = await ok(s, "rws_list_files", {});
    check("directory gone", !after.json?.dirs?.some((d) => d.name === "_mcp_live"), after.text.slice(0, 200));
  }
};

sections["rws-misc"] = async ({ rs, rws6, rws7 }) => {
  for (const [s, gen] of [[rws6, "RWS 1.0"], [rws7, "RWS 2.0"]]) {
    console.log(`  -- ${gen}`);
    const sp = await ok(s, "rws_get_speed_override", {});
    const orig = sp.json?.speedRatio;
    check("speed ratio read", Number.isFinite(orig), sp.text);
    const set = await ok(s, "rws_set_speed_override", { speed: 50 }, "set speed ratio 50");
    check("speed ratio is 50", set.json?.speedRatio === 50, set.text);
    const back = await ok(s, "rws_set_speed_override", { speed: orig }, "restore speed ratio");
    check("restored", back.json?.speedRatio === orig, back.text);
    await err(s, "rws_set_speed_override", { speed: 101 }, /100|too_big|less/i, "101 refused by the schema");
  }
  // Mastership held over RWS blocks a PC SDK write, and releasing it frees the write.
  await call(rs, "rs_write_module", { controller: RW6, task: TASK, module: "MCP_LIVE_M", code: moduleCode("MCP_LIVE_M") });
  const held = await ok(rws6, "rws_request_mastership", { domain: "rapid" }, "RWS takes RAPID mastership");
  check("held", held.json?.held === true, held.text);
  await err(rs, "rs_write_variable", { controller: RW6, task: TASK, module: "MCP_LIVE_M", name: "nVal", value: "3" }, /mastership/i, "PC SDK write refused while RWS holds mastership, and says why");
  await ok(rws6, "rws_release_mastership", { domain: "rapid" }, "RWS releases it");
  await ok(rs, "rs_write_variable", { controller: RW6, task: TASK, module: "MCP_LIVE_M", name: "nVal", value: "3" }, "the write now succeeds");
  await ok(rs, "rs_delete_module", { controller: RW6, task: TASK, module: "MCP_LIVE_M" }, "cleanup");
  const m7 = await ok(rws7, "rws_request_mastership", { domain: "rapid" }, "RWS 2.0: 'rapid' maps to the edit domain");
  check("mapped to edit", m7.json?.domain === "edit", m7.text);
  await ok(rws7, "rws_release_mastership", {}, "RWS 2.0 release");
};

sections.concurrency = async ({ rs, rws6, rws7 }) => {
  // The add-in serves requests in parallel (PC SDK work on request threads, station work
  // queued to the UI thread); the RWS client shares one session across a burst.
  const burst = await Promise.all([
    ...CTRLS.flatMap((c) => [call(rs, "rs_controller_status", { controller: c }), call(rs, "rs_get_position", { controller: c }), call(rs, "rs_get_tasks", { controller: c })]),
    call(rs, "rs_get_station", {}), call(rs, "rs_get_paths", { controller: RW6 }), call(rs, "rs_simulation_status", {}),
    call(rs, "rs_get_station_objects", { limit: 20 }), call(rs, "rs_event_log", { controller: RW7, count: 3 }),
  ]);
  check(`${burst.length} simultaneous add-in calls all succeed`, burst.every((r) => !r.isError), burst.filter((r) => r.isError).map((r) => r.text).join("\n"));
  for (const [s, gen] of [[rws6, "RWS 1.0"], [rws7, "RWS 2.0"]]) {
    const rb = await Promise.all(Array.from({ length: 8 }, (_, i) => call(s, ["rws_controller_status", "rws_get_tasks", "rws_execution_state", "rws_get_speed_override"][i % 4], {})));
    check(`${gen}: 8 simultaneous calls all succeed`, rb.every((r) => !r.isError), rb.filter((r) => r.isError).map((r) => r.text).join("\n"));
  }
};

sections.environment = async () => {
  // An add-in that accepts the connection and never answers (a hung RobotStudio) must end in a
  // clear timeout, not a hang.
  const net = await import("node:net");
  const sockets = [];
  const hung = net.createServer((sock) => { sock.on("error", () => {}); sockets.push(sock); });
  await new Promise((r) => hung.listen(58097, "localhost", r));
  try {
    const slow = await server({ ABB_BRIDGE_URL: "http://localhost:58097", ABB_BRIDGE_TIMEOUT_MS: "1500" });
    const t0 = Date.now();
    await err(slow, "rs_get_station", {}, /did not answer \/ping within 15 s/, "hung add-in: the compatibility ping times out with a clear message");
    check("and gives up in ~15 s, not never", Date.now() - t0 < 25000, `${Date.now() - t0} ms`);
    await slow.close();
  } finally {
    for (const s of sockets) s.destroy();
    hung.close();
  }

  // Configuration errors stop the server with a message instead of misbehaving later.
  for (const [env, re] of [
    [{ ABB_BRIDGE_URL: "http://127.0.0.1:58080" }, /must use the host name "localhost"/],
    [{ ABB_RWS_URL: "not a url" }, /is not a valid URL/],
    [{ ABB_RWS_TIMEOUT_MS: "abc" }, /whole number/],
  ]) {
    let refused = false;
    try { const s = await server(env); await s.close(); } catch { refused = true; }
    check(`bad config refused: ${JSON.stringify(env)}`, refused);
  }
  const down = await server({ ABB_BRIDGE_URL: "http://localhost:58099", ABB_RWS_URL: "http://127.0.0.1:9" });
  await err(down, "rs_ping", {}, /Cannot reach the RobotStudioBridge add-in at http:\/\/localhost:58099/, "add-in down: clear error");
  await err(down, "rws_controller_status", {}, /Cannot reach Robot Web Services at http:\/\/127\.0\.0\.1:9/, "RWS down: clear error");
  await down.close();
  const wrong = await server({ ABB_RWS_URL: RWS6, ABB_RWS_PASS: "wrong-password" });
  await err(wrong, "rws_controller_status", {}, /authentication failed.*ABB_RWS_PASS/s, "wrong RWS password: named as such");
  await wrong.close();
  const tlsStrict = await server({ ABB_RWS_URL: RWS7_TLS });
  await err(tlsStrict, "rws_controller_status", {}, /ABB_RWS_TLS_INSECURE/, "self-signed HTTPS without the switch: explained");
  await tlsStrict.close();
  const tls = await server({ ABB_RWS_URL: RWS7_TLS, ABB_RWS_TLS_INSECURE: "1" });
  const t = await ok(tls, "rws_controller_status", {}, "HTTPS with ABB_RWS_TLS_INSECURE=1");
  check("HTTPS reaches RWS 2.0", t.json?.rwsApi === "2.0", t.text);
  check("the insecure switch is announced on stderr", /NOT verified/.test(tls.stderr()), tls.stderr());
  await tls.close();
};

// The RW7 VC has no output a remote client may write (its panel signals refuse with a safety
// access restriction), so prove the write path on a temporary virtual signal instead:
// add it with rs_write_config, restart, write it through the PC SDK and through RWS 2.0,
// then restore the original EIO configuration exactly and restart again.
sections["rw7-virtual-signal"] = async ({ rs, rws7 }) => {
  const eio = await ok(rs, "rs_read_config", { controller: RW7, domain: "EIO" }, "save the original EIO configuration");
  const original = eio.json?.content;
  if (!check("original EIO read", typeof original === "string" && /^EIO:CFG_/.test(original))) return;
  const header = original.split(/\r?\n/)[0];
  try {
    const add = `${header}\n#\nEIO_SIGNAL:\n\n      -Name "mcp_live_do" -SignalType "DO" -Access "All"\n`;
    await ok(rs, "rs_write_config", { controller: RW7, content: add, mode: "add" }, "add a virtual DO (Access All)");
    const r1 = await ok(rs, "rs_restart_controller", { controller: RW7 }, "warm restart to apply it");
    console.log(`        (back in ${r1.json?.seconds} s)`);
    const rd = await ok(rs, "rs_read_io", { controller: RW7, signal: "mcp_live_do" }, "the new signal exists");
    check("it is a DO at 0", rd.json?.type === "DO" && rd.json?.value === 0, rd.text);
    const w1 = await ok(rs, "rs_write_io", { controller: RW7, signal: "mcp_live_do", value: 1 }, "PC SDK write 1");
    check("reads back 1", w1.json?.after?.value === 1, w1.text);
    const w2 = await ok(rws7, "rws_write_io", { signal: "mcp_live_do", value: 0 }, "RWS 2.0 write 0 (set-value), bare name resolved");
    check("RWS reads back 0", w2.json?.value === 0, w2.text);
    const w3 = await ok(rws7, "rws_write_io", { signal: w2.json?.signal ?? "mcp_live_do", value: 1 }, "RWS 2.0 write 1 by its path");
    check("RWS reads back 1", w3.json?.value === 1, w3.text);
    const back = await ok(rs, "rs_read_io", { controller: RW7, signal: "mcp_live_do" }, "PC SDK sees the RWS write");
    check("value 1", back.json?.value === 1, back.text);
  } finally {
    await ok(rs, "rs_write_config", { controller: RW7, content: original, mode: "reset_and_add" }, "restore the original EIO configuration exactly");
    const r2 = await ok(rs, "rs_restart_controller", { controller: RW7 }, "warm restart to apply it");
    console.log(`        (back in ${r2.json?.seconds} s)`);
    await err(rs, "rs_read_io", { controller: RW7, signal: "mcp_live_do" }, /not found/, "the temporary signal is gone");
    const now = (await call(rs, "rs_read_config", { controller: RW7, domain: "EIO" })).json?.content ?? "";
    const norm = (t) => t.replace(/\r\n/g, "\n").trim();
    check("EIO configuration identical to the original", norm(now) === norm(original), `lengths ${norm(now).length} vs ${norm(original).length}`);
  }
};

sections.restart = async ({ rs, rws7 }) => {
  for (const c of CTRLS) {
    await ensureStopped(rs, c);
    const before = (await call(rs, "rs_get_position", { controller: c })).json?.[0];
    const r = await ok(rs, "rs_restart_controller", { controller: c }, `${c}: warm restart`);
    check("came back with a state", r.json?.restarted === true && typeof r.json?.controllerState === "string", r.text);
    console.log(`        (${c} back in ${r.json?.seconds} s, state ${r.json?.controllerState})`);
    const after = (await call(rs, "rs_get_position", { controller: c })).json?.[0];
    const moved = before?.units?.[0]?.joints_deg?.map((j, i) => Math.abs(j - after?.units?.[0]?.joints_deg?.[i])) ?? [];
    console.log(`        (joint change across the restart, ROB_1: ${moved.map((d) => d.toFixed(2)).join(", ")})`);
    await ensureMotorsOff(rs, c);
  }
  // P-start on the RW7 VC, then put the unloaded program modules back.
  const saved = {};
  for (const t of ["T_ROB1", "T_ROB2"]) saved[t] = (await call(rs, "rs_read_module", { controller: RW7, task: t, module: "MainModule" })).json?.text;
  check("MainModule saved from both tasks before the P-start", Object.values(saved).every((x) => typeof x === "string" && x.length > 1000));
  const p = await ok(rs, "rs_restart_controller", { controller: RW7, mode: "reset_rapid" }, "RW7: reset RAPID (P-start)");
  const mods = (await call(rs, "rs_get_modules", { controller: RW7, task: "T_ROB1" })).json?.modules ?? [];
  check("P-start unloaded the program modules", !mods.some((m) => m.name === "MainModule"), JSON.stringify(mods) + " " + p.text);
  for (const t of ["T_ROB1", "T_ROB2"])
    if (saved[t]) await ok(rs, "rs_write_module", { controller: RW7, task: t, module: "MainModule", code: saved[t] }, `restore MainModule in ${t}`);
  await ensureMotorsOff(rs, RW7);
  void rws7;
};

// ------------------------------------------------------------------ main

const order = ["guard", "basics", "rapid-rs", "io-rs", "config-rs", "eventlog", "position", "program", "panel", "sim",
  "paths", "collisions", "rws-rapid", "rws-io", "rws-files", "rws-misc", "concurrency", "environment", "rw7-virtual-signal", "restart"];
const wanted = process.argv.slice(2);
for (const w of wanted) if (!sections[w]) { console.error(`unknown section '${w}'. Sections: ${order.join(", ")}`); process.exit(2); }
const run = ["guard", ...order.filter((s) => s !== "guard" && (wanted.length === 0 || wanted.includes(s)))];

const rs = await server({ ABB_RWS_URL: RWS6 });
const rws6 = rs;
const rws7 = await server({ ABB_RWS_URL: RWS7 });
const t0 = Date.now();
try {
  for (const name of run) {
    console.log(`\n== ${name}`);
    try {
      await sections[name]({ rs, rws6, rws7 });
    } catch (e) {
      check(`section ${name} completed`, false, e?.stack ?? e);
      if (name === "guard") break;
    }
  }
} finally {
  await rs.close();
  await rws7.close();
}
console.log(`\n${pass} passed, ${fail} failed in ${Math.round((Date.now() - t0) / 1000)} s`);
if (fail) console.log("failures:\n  " + failures.join("\n  "));
process.exit(fail ? 1 : 0);

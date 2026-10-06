// rws_* tools: Robot Web Services, straight to one controller (ABB_RWS_URL). RWS 1.0
// (IRC5 / RobotWare 6) and 2.0 (OmniCore / RobotWare 7) are detected and handled; each
// version-specific form below was verified against a controller of that generation.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ToolError } from "../errors.js";
import type { RwsClient } from "../rws-client.js";
import {
  compareModuleText, fileServicePath, firstNonAscii, firstSpan, hasEndModule, looksLikeText, parseItems, parseModuleHeader,
  type RwsItem,
} from "../rws-parse.js";
import { defineTool, READ, SAFE_ACTION, WRITE, WRITE_IDEMPOTENT } from "./common.js";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const enc = encodeURIComponent;
const name = (what: string) => z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/, "must be a RAPID identifier").describe(what);

function num(s: string | undefined): number | null {
  if (s === undefined || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function registerRwsTools(server: McpServer, rws: RwsClient): void {
  // ---------------------------------------------------------------- helpers

  async function execState(): Promise<{ state?: string; cycle?: string }> {
    const body = await rws.get("/rw/rapid/execution");
    return { state: firstSpan(body, "ctrlexecstate"), cycle: firstSpan(body, "cycle") };
  }

  async function ctrlState(): Promise<string | undefined> {
    const v = await rws.version();
    return firstSpan(await rws.get(v === "v2" ? "/rw/panel/ctrl-state" : "/rw/panel/ctrlstate"), "ctrlstate");
  }

  async function modulesOf(task: string): Promise<RwsItem[]> {
    const v = await rws.version();
    // RWS 1.0 lists modules at /rw/rapid/modules?task=, 2.0 at /rw/rapid/tasks/{task}/modules; the
    // other form answers "resource not found" on each generation.
    const path = v === "v2" ? `/rw/rapid/tasks/${enc(task)}/modules` : `/rw/rapid/modules?task=${enc(task)}`;
    return (await rws.items(path)).filter((i) => i.fields.name !== undefined);
  }

  // A module's source text. The documented form returns it inline (<span class="module-text">),
  // but both tested generations return a temp FILE instead: a controller path on OmniCore
  // (fetched over /fileservice) and a path on the RobotStudio PC for an RW6 virtual controller.
  async function moduleText(task: string, module: string): Promise<{ text: string; source: string }> {
    const v = await rws.version();
    const path = v === "v2"
      ? `/rw/rapid/tasks/${enc(task)}/modules/${enc(module)}/text`
      : `/rw/rapid/modules/${enc(module)}?resource=module-text&task=${enc(task)}`;
    const body = await rws.get(path);
    const inline = firstSpan(body, "module-text");
    if (inline) return { text: inline, source: "inline" };
    const fp = (firstSpan(body, "file-path") ?? "").replace(/^"|"$/g, "");
    if (!fp) throw new ToolError(`RWS returned neither module text nor a file path for ${task}/${module}.`);
    if (/^[A-Za-z]:[\\/]/.test(fp)) {
      // A virtual controller running on this PC. The path comes from the controller, and
      // reading arbitrary local files on its word would let a hostile endpoint exfiltrate
      // them through this tool, so accept only a RAPID module file or the exact temp-file
      // shape an RW6 VC uses ("<...>\TEMP\<guid>pusres.<n>", measured).
      const leaf = fp.split(/[\\/]/).pop() ?? "";
      const parent = fp.split(/[\\/]/).slice(-2, -1)[0] ?? "";
      const isModule = /\.(modx?|sysx?)$/i.test(leaf);
      const isVcTemp = parent.toUpperCase() === "TEMP" && /^[0-9a-f-]{36}pusres\.\d+$/i.test(leaf);
      if (!isModule && !isVcTemp)
        throw new ToolError(`RWS pointed at a local file that is not a RAPID module or a virtual controller temp file (${fp}); refusing to read it.`);
      try {
        return { text: readFileSync(fp, "utf8"), source: "virtual controller temp file" };
      } catch (e: any) {
        throw new ToolError(`The module text is in a file on the RobotStudio PC (${fp}) that this process cannot read ` +
          `(${e.message}). Run the MCP server on that PC, or use rs_read_module.`);
      }
    }
    const f = await rws.request("GET", fileServicePath(fp.replace(/^\//, "")), { accept: null });
    if (!f.ok) throw rws.error("GET", fp, f.status, f.body);
    return { text: f.body, source: "controller temp file" };
  }

  async function putFile(path: string, bytes: Uint8Array): Promise<void> {
    const v = await rws.version();
    const url = fileServicePath(path);
    // RWS 1.0 PUT carries no Accept and no Content-Type (RW6 refuses an Accept here);
    // RWS 2.0 wants application/octet-stream;v=2.0.
    const r = await rws.request("PUT", url, {
      bytes, accept: null, contentType: v === "v2" ? "application/octet-stream" : undefined,
    });
    if (!r.ok) throw rws.error("PUT", url, r.status, r.body);
  }

  async function deletePath(path: string): Promise<void> {
    const url = fileServicePath(path);
    // DELETE carries the negotiated Accept: RWS 2.0 refuses the generic "*/*" that fetch
    // sends by default with 406 "Server cannot generate response for given accept header";
    // RWS 1.0 accepts either (both measured).
    const r = await rws.request("DELETE", url);
    if (!r.ok) throw rws.error("DELETE", url, r.status, r.body);
  }

  // What RWS can say about a module load: it has no program-check call, and loadmod answers
  // 2xx and stores a module with syntax errors verbatim (measured on both generations). But
  // the controller logs 40322 "Load error" (naming the file) or 40160 "Errors in RAPID
  // program" in the program event-log domain, and a task whose program failed to link stays
  // in taskstate load/loaded instead of init/initiated.
  async function taskState(task: string): Promise<string | undefined> {
    const t = (await rws.items("/rw/rapid/tasks")).find((i) => (i.fields.name ?? "").toLowerCase() === task.toLowerCase());
    return t?.fields.taskstate;
  }
  const broken = (s: string | undefined) => !!s && /^load(ed)?$/i.test(s);
  async function programMark(): Promise<number> {
    const [newest] = await rws.elogNewestFirst(4, 1);
    return newest ? Number(newest.title.split("/").pop()) : 0;
  }
  async function programErrorsSince(mark: number, task: string) {
    const recent = await rws.elogNewestFirst(4, 50);
    return recent
      .filter((i) => Number(i.title.split("/").pop()) > mark && i.fields.msgtype === "3")
      .filter((i) => (i.fields.desc ?? "").toLowerCase().includes(`task ${task.toLowerCase()}`))
      .map((i) => ({ code: num(i.fields.code), title: i.fields.title, description: i.fields.desc }))
      .reverse();
  }

  async function loadModuleFile(task: string, ctrlPath: string): Promise<void> {
    const v = await rws.version();
    if (v === "v2") {
      await rws.postWhenReady(`/rw/rapid/tasks/${enc(task)}/loadmod?mastership=implicit`, { modulepath: ctrlPath, replace: "true" });
    } else {
      await rws.withRapidMastership(() => rws.postWhenReady(`/rw/rapid/tasks/${enc(task)}?action=loadmod`, { modulepath: ctrlPath, replace: "true" }));
    }
  }

  async function unloadModule(task: string, module: string): Promise<void> {
    const v = await rws.version();
    if (v === "v2") {
      await rws.postWhenReady(`/rw/rapid/tasks/${enc(task)}/unloadmod?mastership=implicit`, { module });
    } else {
      await rws.withRapidMastership(() => rws.postWhenReady(`/rw/rapid/tasks/${enc(task)}?action=unloadmod`, { module }));
    }
  }

  // Resolve a bare signal name to its Network/Device/Signal path. RWS 2.0 refuses bare
  // names everywhere and RWS 1.0 on writes. The list is paged (100 per page), so every page
  // is searched; two signals with the same name on different devices are reported, never guessed.
  async function signalPath(signal: string): Promise<string> {
    const s = signal.trim().replace(/^\/+|\/+$/g, "");
    if (s.includes("/")) return s;
    const hits = (await rws.items("/rw/iosystem/signals", "ios-signal-li"))
      .map((i) => i.title)
      .filter((t) => (t.split("/").pop() ?? "").toLowerCase() === s.toLowerCase());
    if (hits.length === 0) throw new ToolError(`No I/O signal named '${s}' (searched every page of /rw/iosystem/signals).`);
    if (hits.length > 1) throw new ToolError(`'${s}' is ambiguous: ${hits.join(", ")}. Pass the full Network/Device/Signal path.`);
    return hits[0];
  }

  function signalJson(path: string, body: string) {
    const item = parseItems(body)[0]?.fields ?? {};
    return {
      signal: path,
      type: item.type ?? firstSpan(body, "type"),
      value: num(item.lvalue ?? firstSpan(body, "lvalue")),
      state: item.lstate ?? firstSpan(body, "lstate"),
    };
  }

  // ---------------------------------------------------------------- controller

  defineTool(server, "rws_controller_status", {
    title: "Controller status (RWS)",
    description: "Controller state (motoron/motoroff/guardstop/...), operating mode, RAPID execution, RobotWare version, RWS API " +
      "generation, and the controller's identity including whether it is virtual.",
    input: {}, hints: READ,
  }, async () => {
    const { version, robotWare } = await rws.ready();
    const controllerState = await ctrlState();
    const operatingMode = firstSpan(await rws.get("/rw/panel/opmode"), "opmode");
    const exec = await execState();
    let identity: Record<string, string | undefined> = {};
    try {
      const id = await rws.get("/ctrl/identity");
      identity = { name: firstSpan(id, "ctrl-name"), type: firstSpan(id, "ctrl-type"), id: firstSpan(id, "ctrl-id") };
    } catch (e: any) {
      identity = { error: e.message };
    }
    const type = identity.type ?? "";
    return {
      url: rws.url, rwsApi: version === "v2" ? "2.0" : "1.0", robotWare,
      controller: identity,
      isVirtual: /virtual/i.test(type) ? true : /real/i.test(type) ? false : null,
      controllerState, operatingMode, rapidExecution: exec.state, cycle: exec.cycle,
    };
  });

  defineTool(server, "rws_set_motors", {
    title: "Motors on/off (RWS)",
    description: "Turn motors on or off. Motors-on needs AUTO mode and a closed safety chain, and cannot clear a latched guard stop.",
    input: { state: z.enum(["on", "off"]) }, hints: WRITE_IDEMPOTENT,
  }, async ({ state }) => {
    const v = await rws.version();
    const before = await ctrlState();
    await rws.post(v === "v2" ? "/rw/panel/ctrl-state" : "/rw/panel/ctrlstate?action=setctrlstate", { "ctrl-state": `motor${state}` });
    let after = before;
    for (let i = 0; i < 30 && after !== `motor${state}`; i++) { await sleep(100); after = await ctrlState(); }
    if (after !== `motor${state}`) throw new ToolError(`Asked for motors ${state}; the controller is in '${after}' after 3 s.`);
    return { before, controllerState: after };
  });

  defineTool(server, "rws_start_program", {
    title: "Start RAPID (RWS)",
    description: "Start RAPID execution (AUTO mode and motors on are required for motion). reset_pp=true moves the program pointer to main first.",
    input: {
      regain: z.enum(["continue", "regain", "clear"]).optional().describe("Default 'continue'."),
      execmode: z.enum(["continue", "stepin", "stepover", "stepout", "stepback", "steplast", "stepmotion"]).optional().describe("Default 'continue'."),
      cycle: z.enum(["forever", "asis", "once"]).optional().describe("Default 'forever'."),
      reset_pp: z.boolean().optional().describe("PP to main first (default false)."),
    },
    hints: WRITE,
  }, async (a) => {
    const v = await rws.version();
    if (a.reset_pp)
      await rws.postWhenReady(v === "v2" ? "/rw/rapid/execution/resetpp?mastership=implicit" : "/rw/rapid/execution?action=resetpp", {});
    await rws.postWhenReady(v === "v2" ? "/rw/rapid/execution/start?mastership=implicit" : "/rw/rapid/execution?action=start", {
      regain: a.regain ?? "continue", execmode: a.execmode ?? "continue", cycle: a.cycle ?? "forever",
      condition: "none", stopatbp: "disabled", alltaskbytsp: "false",
    });
    await sleep(300);
    return { started: true, ppReset: !!a.reset_pp, ...(await execState()) };
  });

  defineTool(server, "rws_stop_program", {
    title: "Stop RAPID (RWS)",
    description: "Stop RAPID execution. mode 'stop' (default), 'cycle' (end of cycle), 'instr' (end of instruction) or 'qstop' (quick stop).",
    input: { mode: z.enum(["stop", "cycle", "instr", "qstop"]).optional() }, hints: SAFE_ACTION,
  }, async (a) => {
    const v = await rws.version();
    await rws.post(v === "v2" ? "/rw/rapid/execution/stop" : "/rw/rapid/execution?action=stop", { stopmode: a.mode ?? "stop", usetsp: "normal" });
    let s = await execState();
    for (let i = 0; i < 20 && s.state === "running" && (a.mode ?? "stop") !== "cycle"; i++) { await sleep(100); s = await execState(); }
    return { stopMode: a.mode ?? "stop", ...s };
  });

  defineTool(server, "rws_reset_pp", {
    title: "Program pointer to main (RWS)",
    description: "Move the program pointer to main in all tasks. RAPID must be stopped.",
    input: {}, hints: WRITE_IDEMPOTENT,
  }, async () => {
    const v = await rws.version();
    await rws.postWhenReady(v === "v2" ? "/rw/rapid/execution/resetpp?mastership=implicit" : "/rw/rapid/execution?action=resetpp", {});
    return { ppReset: true };
  });

  defineTool(server, "rws_set_program_pointer", {
    title: "Program pointer to a routine (RWS)",
    description: "Move a task's program pointer to a procedure (the FlexPendant's 'PP to Routine'), so the next start runs it. " +
      "RAPID must be stopped; the routine must take no parameters.",
    input: { task: name("Task."), module: name("Module holding the routine."), routine: name("Procedure name.") },
    hints: WRITE_IDEMPOTENT,
  }, async ({ task, module, routine }) => {
    const v = await rws.version();
    const form = { module, routine, userlevel: "true" };
    if (v === "v2") await rws.postWhenReady(`/rw/rapid/tasks/${enc(task)}/pcp/routine?mastership=implicit`, form);
    else await rws.withRapidMastership(() => rws.postWhenReady(`/rw/rapid/tasks/${enc(task)}/pcp?action=set-pp-routine`, form));
    return { task, module, routine, set: true };
  });

  defineTool(server, "rws_execution_state", {
    title: "RAPID execution state (RWS)",
    description: "RAPID execution state (running/stopped) and run mode (cycle).",
    input: {}, hints: READ,
  }, () => execState());

  // ---------------------------------------------------------------- RAPID

  defineTool(server, "rws_get_tasks", {
    title: "RAPID tasks (RWS)",
    description: "RAPID tasks with type, task state, execution state, active flag and whether each is a motion task.",
    input: {}, hints: READ,
  }, async () => (await rws.items("/rw/rapid/tasks")).filter((i) => i.fields.name !== undefined).map((i) => ({
    name: i.fields.name, type: i.fields.type, taskState: i.fields.taskstate, executionState: i.fields.excstate,
    active: i.fields.active, motionTask: i.fields.motiontask,
  })));

  defineTool(server, "rws_get_modules", {
    title: "RAPID modules (RWS)",
    description: "Modules loaded in a RAPID task.",
    input: { task: name("Task, e.g. 'T_ROB1'.") }, hints: READ,
  }, async ({ task }) => (await modulesOf(task)).map((i) => ({ name: i.fields.name, type: i.fields.type })));

  defineTool(server, "rws_read_module", {
    title: "Read a RAPID module (RWS)",
    description: "A loaded module's source text.",
    input: { task: name("Task."), module: name("Module.") }, hints: READ,
  }, async ({ task, module }) => {
    const { text, source } = await moduleText(task, module);
    return { task, module, source, length: text.length, text };
  });

  defineTool(server, "rws_write_module", {
    title: "Write a RAPID module (RWS)",
    description: "Load RAPID source into a task, replacing the module of the same name or adding it. The text is uploaded as a file " +
      "and loaded with loadmod (no size limit), then read back and compared. `code` must be the whole module and declare the " +
      "same name as `module`. If the load fails or the stored text differs, the previous version is restored (or the new module " +
      "removed) unless on_error='keep'. The task must be stopped. RobotWare 6 rejects any non-ASCII character, even in comments.",
    input: {
      task: name("Task."), module: name("Module; must match the MODULE line in `code`."),
      code: z.string().min(1),
      on_error: z.enum(["restore", "keep"]).optional().describe("Default 'restore'."),
    },
    hints: WRITE,
  }, async ({ task, module, code, on_error }) => {
    const header = parseModuleHeader(code);
    if (!header) throw new ToolError("`code` must be a whole RAPID module: it has no 'MODULE <name>' line.");
    if (header.name.toLowerCase() !== module.toLowerCase())
      throw new ToolError(`\`code\` declares MODULE ${header.name} but \`module\` is ${module}; they must match.`);
    if (!hasEndModule(code)) throw new ToolError("`code` has no ENDMODULE line; send the whole module.");
    const { version } = await rws.ready();
    if (version === "v1") {
      const bad = firstNonAscii(code);
      if (bad) throw new ToolError(`RobotWare 6 rejects non-ASCII characters anywhere in a module, comments included: '${bad.char}' ` +
        `(U+${bad.char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}) at line ${bad.line}, column ${bad.column}.`);
    }
    const exec = await execState();
    if (exec.state === "running") throw new ToolError("RAPID is running. Stop it before replacing a module.");

    const existed = (await modulesOf(task)).some((m) => (m.fields.name ?? "").toLowerCase() === module.toLowerCase());
    const restore = (on_error ?? "restore") === "restore";
    const backup = existed && restore ? (await moduleText(task, module)).text : undefined;

    const ext = (header.system ? ".sys" : ".mod") + (version === "v2" ? "x" : "");
    const file = `_mcp_tmp_${randomBytes(6).toString("hex")}${ext}`;
    const upload = async (text: string) => putFile(`$home/${file}`, Buffer.from(text, version === "v2" ? "utf8" : "latin1"));

    const stateBefore = await taskState(task);
    const mark = await programMark();
    let failure: string | undefined;
    let controllerErrors: unknown[] = [];
    const attempt = async (): Promise<Record<string, unknown>> => {
      await upload(code);
      try {
        await loadModuleFile(task, `$home/${file}`);
      } catch (e: any) {
        failure = `the controller refused the module: ${e.message}`;
      }
      if (!failure) {
        const errors = await programErrorsSince(mark, task);
        const stateAfter = await taskState(task);
        if (errors.length > 0 || (!broken(stateBefore) && broken(stateAfter))) {
          controllerErrors = errors;
          failure = `the controller reported errors in it (task ${task} is now in state '${stateAfter}')`;
        }
      }
      if (!failure) {
        const stored = (await moduleText(task, module)).text;
        const cmp = compareModuleText(code, stored);
        if (cmp.equal)
          return {
            task, module, result: existed ? "replaced" : "added", length: code.length, verified: true,
            warning: broken(stateBefore) ? `Task ${task}'s program already had errors before this write (state '${stateBefore}'); they are still there.` : undefined,
          };
        failure = cmp.truncated
          ? `the controller stored only ${cmp.storedLength} of ${cmp.sentLength} characters (truncated at line ${cmp.firstDifferentLine})`
          : `the stored text differs from what was sent from line ${cmp.firstDifferentLine} on (${cmp.storedLength} vs ${cmp.sentLength} characters)`;
      }
      let outcome: string;
      if (!restore) outcome = "The module was left as the controller has it (on_error=keep).";
      else if (backup !== undefined) {
        try { await upload(backup); await loadModuleFile(task, `$home/${file}`); outcome = "The previous version was restored."; }
        catch (e: any) { outcome = `RESTORING THE PREVIOUS VERSION FAILED (${e.message}); check the program.`; }
      } else {
        try {
          if ((await modulesOf(task)).some((m) => (m.fields.name ?? "").toLowerCase() === module.toLowerCase())) await unloadModule(task, module);
          outcome = "The module did not exist before, so it was removed again.";
        } catch (e: any) { outcome = `The module did not exist before, and removing it failed: ${e.message}`; }
      }
      throw new ToolError(`Writing module ${module} failed: ${failure}. ${outcome}`,
        controllerErrors.length > 0 ? { details: { controllerMessages: controllerErrors } } : {});
    };

    // Always remove the uploaded file, and say so if that fails: a silently swallowed cleanup
    // error is how stray _mcp_tmp_ files once piled up in a controller's HOME.
    let result: Record<string, unknown> | undefined;
    let error: unknown;
    try { result = await attempt(); } catch (e) { error = e; }
    let cleanup: string | undefined;
    try { await deletePath(`$home/${file}`); }
    catch (e: any) { cleanup = `Could not delete the temporary upload $home/${file}: ${e.message}`; }
    if (error !== undefined) {
      if (cleanup && error instanceof ToolError)
        throw new ToolError(`${error.message} ${cleanup}`, { status: error.status, code: error.code, details: error.details });
      throw error;
    }
    return cleanup ? { ...result, cleanupWarning: cleanup } : result;
  });

  defineTool(server, "rws_delete_module", {
    title: "Delete a RAPID module (RWS)",
    description: "Unload a module from a RAPID task. RAPID must be stopped.",
    input: { task: name("Task."), module: name("Module.") }, hints: WRITE,
  }, async ({ task, module }) => {
    if (!(await modulesOf(task)).some((m) => (m.fields.name ?? "").toLowerCase() === module.toLowerCase()))
      throw new ToolError(`Module ${module} is not loaded in task ${task}.`);
    await unloadModule(task, module);
    return { task, module, deleted: true };
  });

  defineTool(server, "rws_read_variable", {
    title: "Read a RAPID variable (RWS)",
    description: "The live value of a RAPID data object, as a RAPID literal.",
    input: { task: name("Task."), module: name("Module."), variable: name("Data name.") }, hints: READ,
  }, async ({ task, module, variable }) => {
    const v = await rws.version();
    const path = v === "v2"
      ? `/rw/rapid/symbol/RAPID/${enc(task)}/${enc(module)}/${enc(variable)}/data`
      : `/rw/rapid/symbol/data/RAPID/${enc(task)}/${enc(module)}/${enc(variable)}`;
    const value = firstSpan(await rws.get(path), "value");
    if (value === undefined) throw new ToolError(`RWS returned no value for ${task}/${module}/${variable}.`);
    return { task, module, variable, value };
  });

  defineTool(server, "rws_write_variable", {
    title: "Write a RAPID variable (RWS)",
    description: "Set the live value of a RAPID VAR or PERS. `value` is a RAPID literal (strings in double quotes, records in brackets).",
    input: { task: name("Task."), module: name("Module."), variable: name("Data name."), value: z.string() },
    hints: WRITE_IDEMPOTENT,
  }, async ({ task, module, variable, value }) => {
    const v = await rws.version();
    const read = v === "v2"
      ? `/rw/rapid/symbol/RAPID/${enc(task)}/${enc(module)}/${enc(variable)}/data`
      : `/rw/rapid/symbol/data/RAPID/${enc(task)}/${enc(module)}/${enc(variable)}`;
    const previous = firstSpan(await rws.get(read), "value");
    if (v === "v2") await rws.post(`${read}?mastership=implicit`, { value });
    else await rws.withRapidMastership(() => rws.post(`${read}?action=set`, { value }));
    return { task, module, variable, previous, value: firstSpan(await rws.get(read), "value") };
  });

  // ---------------------------------------------------------------- motion

  defineTool(server, "rws_get_position", {
    title: "Robot position (RWS)",
    description: "A mechanical unit's TCP (robtarget: mm and quaternion, in the controller's default tool/work object) and joint " +
      "angles (deg). Note: RWS position reads have been seen to lag the robot; rs_get_position reads through the PC SDK instead.",
    input: { mechunit: z.string().min(1).optional().describe("Default 'ROB_1'.") }, hints: READ,
  }, async (a) => {
    const mu = a.mechunit ?? "ROB_1";
    const rt = await rws.get(`/rw/motionsystem/mechunits/${enc(mu)}/robtarget`);
    const jt = await rws.get(`/rw/motionsystem/mechunits/${enc(mu)}/jointtarget`);
    const f = (b: string, k: string) => num(firstSpan(b, k));
    return {
      mechunit: mu,
      tcp_mm: { x: f(rt, "x"), y: f(rt, "y"), z: f(rt, "z"), q1: f(rt, "q1"), q2: f(rt, "q2"), q3: f(rt, "q3"), q4: f(rt, "q4") },
      joints_deg: [1, 2, 3, 4, 5, 6].map((i) => f(jt, `rax_${i}`)),
    };
  });

  // ---------------------------------------------------------------- I/O

  defineTool(server, "rws_get_io_signals", {
    title: "I/O signals (RWS)",
    description: "Every I/O signal (all pages) with its full Network/Device/Signal path, type, value and state.",
    input: {
      filter: z.string().optional().describe("Only signals whose path contains this (case-insensitive)."),
      limit: z.number().int().min(1).max(10000).optional().describe("Default 1000."),
    },
    hints: READ,
  }, async (a) => {
    const all = await rws.items("/rw/iosystem/signals", "ios-signal-li");
    const f = a.filter?.toLowerCase();
    const matched = f ? all.filter((i) => i.title.toLowerCase().includes(f)) : all;
    const limit = a.limit ?? 1000;
    return {
      total: all.length, matched: matched.length, truncated: matched.length > limit,
      signals: matched.slice(0, limit).map((i) => ({
        path: i.title, name: i.fields.name, type: i.fields.type, value: num(i.fields.lvalue), state: i.fields.lstate,
      })),
    };
  });

  defineTool(server, "rws_read_io", {
    title: "Read an I/O signal (RWS)",
    description: "One signal's value. `signal` is a bare name (resolved over every page of the signal list) or a Network/Device/Signal path.",
    input: { signal: z.string().min(1) }, hints: READ,
  }, async ({ signal }) => {
    const path = await signalPath(signal);
    return signalJson(path, await rws.get(`/rw/iosystem/signals/${path.split("/").map(enc).join("/")}`));
  });

  defineTool(server, "rws_write_io", {
    title: "Write an I/O signal (RWS)",
    description: "Set a signal's value (0/1 for digital). Returns the value read back.",
    input: { signal: z.string().min(1), value: z.number() }, hints: WRITE_IDEMPOTENT,
  }, async ({ signal, value }) => {
    const v = await rws.version();
    const path = await signalPath(signal);
    const url = `/rw/iosystem/signals/${path.split("/").map(enc).join("/")}`;
    await rws.post(v === "v2" ? `${url}/set-value` : `${url}?action=set`, { lvalue: value });
    await sleep(50);
    return signalJson(path, await rws.get(url));
  });

  // ---------------------------------------------------------------- panel

  defineTool(server, "rws_get_speed_override", {
    title: "Speed override (RWS)",
    description: "The speed override (speed ratio), 0-100 %.",
    input: {}, hints: READ,
  }, async () => ({ speedRatio: num(firstSpan(await rws.get("/rw/panel/speedratio"), "speedratio")) }));

  defineTool(server, "rws_set_speed_override", {
    title: "Set the speed override (RWS)",
    description: "Set the speed override (speed ratio), 0-100 %. The controller must be in AUTO mode.",
    input: { speed: z.number().int().min(0).max(100) }, hints: WRITE_IDEMPOTENT,
  }, async ({ speed }) => {
    const v = await rws.version();
    await rws.post(v === "v2" ? "/rw/panel/speedratio?mastership=implicit" : "/rw/panel/speedratio?action=setspeedratio", { "speed-ratio": speed });
    return { speedRatio: num(firstSpan(await rws.get("/rw/panel/speedratio"), "speedratio")) };
  });

  defineTool(server, "rws_event_log", {
    title: "Event log (RWS)",
    description: "Event-log messages of one domain, newest first, with the ABB event code, title and description. domain: 0 common (every " +
      "domain except internal), 1 operational, 2 system, 3 hardware, 4 program, 5 motion, 7 I/O & communication, 8 user, 9 safety, " +
      "10 internal, 11 process, 12 configuration, 13 paint, 15 RAPID, 17 connected services.",
    input: {
      domain: z.number().int().min(0).max(99).optional().describe("Default 0."),
      count: z.number().int().min(1).max(1000).optional().describe("Default 20."),
    },
    hints: READ,
  }, async (a) => {
    const items = await rws.elogNewestFirst(a.domain ?? 0, a.count ?? 20);
    const types: Record<string, string> = { "1": "information", "2": "warning", "3": "error" };
    return items.map((i) => ({
      seq: num(i.title.split("/").pop()),
      type: types[i.fields.msgtype ?? i.fields["msg-type"] ?? ""] ?? i.fields.msgtype,
      code: num(i.fields.code),
      timestamp: i.fields.tstamp,
      title: i.fields.title,
      description: i.fields.desc,
    }));
  });

  // ---------------------------------------------------------------- files

  defineTool(server, "rws_list_files", {
    title: "List files (RWS)",
    description: "List a directory on the controller (all pages). Paths start with an environment variable such as $home or $temp, e.g. '$home/egm'.",
    input: { path: z.string().optional().describe("Default '$home'.") }, hints: READ,
  }, async (a) => {
    const path = a.path ?? "$home";
    const items = await rws.items(fileServicePath(path));
    return {
      path,
      dirs: items.filter((i) => i.cls === "fs-dir").map((i) => ({ name: i.title, modified: i.fields["fs-mdate"] })),
      files: items.filter((i) => i.cls === "fs-file").map((i) => ({ name: i.title, size: num(i.fields["fs-size"]), modified: i.fields["fs-mdate"] })),
    };
  });

  defineTool(server, "rws_read_file", {
    title: "Read a file (RWS)",
    description: "Read a file from the controller. Text comes back as text; anything else as base64 (encoding: 'base64').",
    input: { path: z.string().min(1).describe("e.g. '$home/egm/MainModule.mod'.") }, hints: READ,
  }, async ({ path }) => {
    const url = fileServicePath(path);
    const r = await rws.request("GET", url, { accept: null, binary: true });
    if (!r.ok) throw rws.error("GET", url, r.status, Buffer.from(r.bytes ?? new Uint8Array()).toString("utf8"));
    const bytes = r.bytes ?? new Uint8Array();
    if (bytes.length > MAX_FILE_BYTES) throw new ToolError(`${path} is ${bytes.length} bytes; the limit here is ${MAX_FILE_BYTES}.`);
    return looksLikeText(bytes)
      ? { path, size: bytes.length, encoding: "utf8", content: Buffer.from(bytes).toString("utf8") }
      : { path, size: bytes.length, encoding: "base64", content: Buffer.from(bytes).toString("base64") };
  });

  defineTool(server, "rws_write_file", {
    title: "Write a file (RWS)",
    description: "Create or overwrite a file on the controller. `content` is text (UTF-8) unless encoding='base64'. The directory must exist.",
    input: { path: z.string().min(1), content: z.string(), encoding: z.enum(["utf8", "base64"]).optional() }, hints: WRITE,
  }, async ({ path, content, encoding }) => {
    const bytes = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
    if (bytes.length > MAX_FILE_BYTES) throw new ToolError(`The content is ${bytes.length} bytes; the limit here is ${MAX_FILE_BYTES}.`);
    await putFile(path, bytes);
    return { path, written: bytes.length };
  });

  defineTool(server, "rws_delete_file", {
    title: "Delete a file (RWS)",
    description: "Delete a file, or an empty directory, on the controller.",
    input: { path: z.string().min(1) }, hints: WRITE,
  }, async ({ path }) => {
    await deletePath(path);
    return { path, deleted: true };
  });

  defineTool(server, "rws_create_directory", {
    title: "Create a directory (RWS)",
    description: "Create a directory on the controller, e.g. '$home/mydir'.",
    input: { path: z.string().min(1) }, hints: WRITE_IDEMPOTENT,
  }, async ({ path }) => {
    const v = await rws.version();
    const url = fileServicePath(path);
    const cut = url.lastIndexOf("/");
    const parent = url.slice(0, cut);
    const newName = decodeURIComponent(url.slice(cut + 1));
    if (parent === "/fileservice") throw new ToolError("Give a directory inside an environment variable, e.g. '$home/mydir'.");
    if (v === "v2") await rws.post(`${parent}/create`, { "fs-newname": newName });
    else await rws.post(parent, { "fs-newname": newName, "fs-action": "create" });
    return { path, created: true };
  });

  // ---------------------------------------------------------------- mastership

  // RWS 1.0 domains: rapid, cfg, motion. RWS 2.0: edit (RAPID + configuration) and motion.
  const domain = z.enum(["rapid", "cfg", "motion", "edit"]).optional().describe("Default 'rapid' ('edit' on RWS 2.0).");
  async function mastershipDomain(d: string | undefined): Promise<string> {
    const v = await rws.version();
    const want = d ?? "rapid";
    if (v === "v2") return want === "rapid" || want === "cfg" ? "edit" : want;
    return want === "edit" ? "rapid" : want;
  }

  defineTool(server, "rws_request_mastership", {
    title: "Request mastership (RWS)",
    description: "Request write mastership of a domain for this server's RWS session (held until released, or until the session " +
      "ends). The write tools take and release mastership themselves; this is for sequences you run by hand.",
    input: { domain }, hints: SAFE_ACTION,
  }, async (a) => {
    const v = await rws.version();
    const d = await mastershipDomain(a.domain);
    await rws.post(v === "v2" ? `/rw/mastership/${d}/request` : `/rw/mastership/${d}?action=request`, {});
    return { domain: d, held: true };
  });

  defineTool(server, "rws_release_mastership", {
    title: "Release mastership (RWS)",
    description: "Release mastership of a domain held by this server's RWS session.",
    input: { domain }, hints: SAFE_ACTION,
  }, async (a) => {
    const v = await rws.version();
    const d = await mastershipDomain(a.domain);
    await rws.post(v === "v2" ? `/rw/mastership/${d}/release` : `/rw/mastership/${d}?action=release`, {});
    return { domain: d, held: false };
  });
}

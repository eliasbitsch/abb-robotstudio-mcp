// rs_* tools: RobotStudio and the PC SDK, through the RobotStudioBridge add-in.
//
// Controller tools take `controller`: a station controller's name, or -- for any
// controller the PC SDK can reach, real or virtual -- its system name, system id or IP
// address. Station tools (paths, targets, simulation, collisions) work on the open
// RobotStudio station only. The virtual-panel tools work on virtual controllers only.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BridgeClient } from "../bridge-client.js";
import { defineTool, READ, SAFE_ACTION, WRITE, WRITE_IDEMPOTENT } from "./common.js";

const controller = z.string().min(1).optional().describe(
  "Target controller: a station controller's name (e.g. 'IRB2600'), or any controller the PC SDK can reach -- " +
  "real or virtual -- by system name, system id or IP address. Omit when the open station has exactly one controller.");
const stationController = z.string().min(1).optional().describe(
  "A controller in the open RobotStudio station, by name. Omit when the station has exactly one.");
const task = z.string().min(1).optional().describe("RAPID task, e.g. 'T_ROB1'. Omit when the controller has a single motion task.");
const ident = (what: string) => z.string().min(1).describe(what);

export function registerRsTools(server: McpServer, bridge: BridgeClient): void {
  const get = (path: string, params?: Record<string, unknown>, timeoutMs?: number) =>
    bridge.call(path, { method: "GET", params: params as any, timeoutMs });
  const post = (path: string, params?: Record<string, unknown>, timeoutMs?: number) =>
    bridge.call(path, { method: "POST", params: params as any, timeoutMs });

  // ---------------------------------------------------------------- add-in, station

  defineTool(server, "rs_ping", {
    title: "Ping the RobotStudio add-in",
    description: "Check that RobotStudio is running with the RobotStudioBridge add-in: its version (and whether it matches this server), " +
      "whether RobotStudio's UI thread is responsive, and which station is open.",
    input: {}, hints: READ,
  }, () => bridge.ping());

  defineTool(server, "rs_list_controllers", {
    title: "List controllers",
    description: "List the open station's controllers. With scan=true also run PC SDK network discovery (a LAN broadcast) and list " +
      "every real and virtual controller found, with its IP and system id -- the names and IPs other rs_* tools accept as `controller`.",
    input: { scan: z.boolean().optional().describe("Also discover controllers on the network (default false).") },
    hints: READ,
  }, (a) => get("/controllers", { scan: a.scan }, 60000));

  defineTool(server, "rs_get_station", {
    title: "Get the open station",
    description: "The open RobotStudio station: name, file, controllers, saved states, collision sets and simulation state.",
    input: {}, hints: READ,
  }, () => get("/station"));

  defineTool(server, "rs_get_station_objects", {
    title: "List station objects",
    description: "The station's object tree (robots, tools, parts, smart components, frames...) as paths. Bounded by max_depth and " +
      "limit because a full station tree is huge; use name/type filters to find something specific.",
    input: {
      name: z.string().optional().describe("Only objects whose name contains this (case-insensitive)."),
      type: z.string().optional().describe("Only objects whose .NET type name contains this, e.g. 'Mechanism', 'Part', 'SmartComponent'."),
      max_depth: z.number().int().min(0).max(50).optional().describe("Depth limit (default 2, or 12 when filtering)."),
      limit: z.number().int().min(1).max(5000).optional().describe("Maximum objects returned (default 300)."),
    },
    hints: READ,
  }, (a) => get("/station/objects", a));

  defineTool(server, "rs_save_station", {
    title: "Save the station",
    description: "Save the open RobotStudio station to its file.",
    input: {}, hints: SAFE_ACTION,
  }, () => post("/station/save"));

  // ---------------------------------------------------------------- controller

  defineTool(server, "rs_controller_status", {
    title: "Controller status",
    description: "Live controller status through the PC SDK: operating mode, controller state (motors on/off, guard stop...), RAPID " +
      "execution, RobotWare version, whether it is virtual, and each task's state.",
    input: { controller }, hints: READ,
  }, (a) => get("/controller/status", a));

  defineTool(server, "rs_restart_controller", {
    title: "Restart a controller",
    description: "Restart a controller and wait until it is back. mode 'warm' is a normal restart (programs and configuration kept); " +
      "'reset_rapid' (P-start) also unloads all RAPID programs. Needs controller mastership, so no other client may hold any.",
    input: {
      controller,
      mode: z.enum(["warm", "reset_rapid"]).optional().describe("Default 'warm'."),
      wait: z.boolean().optional().describe("Wait for the controller to come back (default true)."),
      timeout_s: z.number().int().min(30).max(900).optional().describe("How long to wait (default 240)."),
    },
    hints: WRITE,
  }, (a) => post("/controller/restart", a, ((a.timeout_s ?? 240) + 60) * 1000));

  defineTool(server, "rs_set_motors", {
    title: "Motors on/off",
    description: "Turn the robot motors on or off through the PC SDK. Motors-on needs AUTO mode and a closed safety chain; it cannot clear " +
      "a latched guard stop (see rs_clear_guardstop for virtual controllers).",
    input: { controller, state: z.enum(["on", "off"]) }, hints: WRITE_IDEMPOTENT,
  }, (a) => post("/controller/motors", a));

  defineTool(server, "rs_get_position", {
    title: "Robot position",
    description: "Live joint angles (deg) and world-frame TCP (mm, quaternion) of every mechanical unit, through the PC SDK. Without " +
      "`controller`, every controller in the open station.",
    input: { controller }, hints: READ,
  }, (a) => get("/robot/position", a));

  defineTool(server, "rs_event_log", {
    title: "Controller event log",
    description: "Controller event-log messages, newest first, with title and description. category: 0 common (all), 1 operational, " +
      "2 system, 3 hardware, 4 program, 5 motion, 7 I/O & communication, 8 user, 10 internal, 11 process, 12 configuration.",
    input: {
      controller,
      category: z.number().int().min(0).max(100).optional().describe("Default 0 (common)."),
      count: z.number().int().min(1).max(1000).optional().describe("Default 20."),
      since_seq: z.number().int().min(0).optional().describe("Only messages with a higher sequence number (for polling)."),
    },
    hints: READ,
  }, (a) => get("/eventlog", a));

  // ---------------------------------------------------------------- RAPID

  defineTool(server, "rs_get_tasks", {
    title: "RAPID tasks",
    description: "The controller's RAPID tasks: type, motion task or not, enabled, execution state, program pointer, module count.",
    input: { controller }, hints: READ,
  }, (a) => get("/rapid/tasks", a));

  defineTool(server, "rs_get_modules", {
    title: "RAPID modules",
    description: "Modules loaded in a RAPID task, with system/encoded/noview/read-only flags.",
    input: { controller, task }, hints: READ,
  }, (a) => get("/rapid/modules", a));

  defineTool(server, "rs_read_module", {
    title: "Read a RAPID module",
    description: "The live source text of a loaded RAPID module (saved from the controller, so it is what is loaded, not a file on disk).",
    input: { controller, task, module: ident("Module name, e.g. 'MainModule'.") }, hints: READ,
  }, (a) => get("/rapid/module/text", a, 120000));

  defineTool(server, "rs_write_module", {
    title: "Write a RAPID module",
    description: "Load RAPID source into a task, replacing the module of the same name or adding it. `code` must be the whole module " +
      "(MODULE <name> ... ENDMODULE) and declare the same name as `module`. The task must be stopped. If the controller reports " +
      "errors, the previous version is restored (or the new module removed) unless on_error='keep', and the errors are returned " +
      "with the controller's own messages. RobotWare 6 rejects any non-ASCII character, even in comments.",
    input: {
      controller, task,
      module: ident("Module name; must match the MODULE line in `code`."),
      code: z.string().min(1).describe("The complete module text."),
      on_error: z.enum(["restore", "keep"]).optional().describe("What to do if the new code has errors (default 'restore')."),
    },
    hints: WRITE,
  }, (a) => post("/rapid/module/text", a, 180000));

  defineTool(server, "rs_delete_module", {
    title: "Delete a RAPID module",
    description: "Unload a module from a RAPID task. The task must be stopped.",
    input: { controller, task, module: ident("Module name.") }, hints: WRITE,
  }, (a) => post("/rapid/module/delete", a));

  defineTool(server, "rs_read_variable", {
    title: "Read a RAPID variable",
    description: "The live value of a RAPID data object (VAR, PERS or CONST) as a RAPID literal, with its type and storage class. " +
      "Without `module` every module of the task is searched.",
    input: { controller, task, module: z.string().min(1).optional(), name: ident("Data name.") }, hints: READ,
  }, (a) => get("/rapid/variable", a));

  defineTool(server, "rs_write_variable", {
    title: "Write a RAPID variable",
    description: "Set the live value of a RAPID VAR or PERS (a CONST cannot be written). `value` is a RAPID literal: numbers as is, " +
      "strings in double quotes (\"text\"), records in brackets ([1,2,3]), booleans TRUE/FALSE. Returns the previous and new value.",
    input: { controller, task, module: z.string().min(1).optional(), name: ident("Data name."), value: z.string().describe("A RAPID literal.") },
    hints: WRITE_IDEMPOTENT,
  }, (a) => post("/rapid/variable", a));

  defineTool(server, "rs_start_program", {
    title: "Start RAPID",
    description: "Start RAPID execution through the PC SDK (AUTO mode and motors on are required for motion). reset_pp=true first moves " +
      "the program pointer to main in every enabled task.",
    input: {
      controller,
      regain: z.enum(["continue", "regain", "clear"]).optional().describe("Default 'continue'."),
      execmode: z.enum(["continue", "stepin", "stepover", "stepout", "stepback", "steplast", "stepmotion"]).optional().describe("Default 'continue'."),
      cycle: z.enum(["forever", "once", "asis"]).optional().describe("Default 'forever'."),
      reset_pp: z.boolean().optional().describe("PP to main before starting (default false)."),
    },
    hints: WRITE,
  }, (a) => post("/rapid/start", a));

  defineTool(server, "rs_stop_program", {
    title: "Stop RAPID",
    description: "Stop RAPID execution. mode 'stop' (default) stops now; 'cycle' at the end of the cycle; 'instruction' after the current instruction.",
    input: { controller, mode: z.enum(["stop", "cycle", "instruction"]).optional() },
    hints: SAFE_ACTION,
  }, (a) => post("/rapid/stop", a));

  defineTool(server, "rs_reset_pp", {
    title: "Program pointer to main",
    description: "Move the program pointer to main, in one task or every enabled task. RAPID must be stopped.",
    input: { controller, task }, hints: WRITE_IDEMPOTENT,
  }, (a) => post("/rapid/resetpp", a));

  defineTool(server, "rs_set_program_pointer", {
    title: "Program pointer to a routine",
    description: "Move a task's program pointer to a procedure (the FlexPendant's 'PP to Routine'), so the next start runs it. " +
      "The task must be stopped; the routine must take no parameters.",
    input: { controller, task, module: ident("Module holding the routine."), routine: ident("Procedure name.") },
    hints: WRITE_IDEMPOTENT,
  }, (a) => post("/rapid/pp", a));

  // ---------------------------------------------------------------- I/O, configuration

  defineTool(server, "rs_get_io_signals", {
    title: "I/O signals",
    description: "The controller's I/O signals with device, type (DI/DO/AI/AO/GI/GO), value and range.",
    input: {
      controller,
      filter: z.string().optional().describe("Only signals whose name or device contains this."),
      type: z.enum(["DI", "DO", "AI", "AO", "GI", "GO"]).optional(),
      limit: z.number().int().min(1).max(10000).optional().describe("Default 500."),
    },
    hints: READ,
  }, (a) => get("/io/signals", a));

  defineTool(server, "rs_read_io", {
    title: "Read an I/O signal",
    description: "One signal's value, type, device and range. `signal` is a name or a Network/Device/Signal path.",
    input: { controller, signal: ident("Signal name or path.") }, hints: READ,
  }, (a) => get("/io/signal", a));

  defineTool(server, "rs_write_io", {
    title: "Write an I/O signal",
    description: "Set an output (or a simulated input): 0/1 for digital, a value in range for analog, a whole number for group signals. " +
      "Returns the value before and after.",
    input: { controller, signal: ident("Signal name or path."), value: z.number() }, hints: WRITE_IDEMPOTENT,
  }, (a) => post("/io/signal", a));

  defineTool(server, "rs_read_config", {
    title: "Read a configuration domain",
    description: "The controller's live configuration for one domain as a .cfg file: SYS, EIO, MOC, SIO, PROC or MMC.",
    input: { controller, domain: z.string().min(1).describe("e.g. 'MOC' (a '.cfg' suffix is accepted).") }, hints: READ,
  }, (a) => get("/config", a, 120000));

  defineTool(server, "rs_write_config", {
    title: "Load configuration parameters",
    description: "Load a .cfg file's parameters into the controller's configuration (like RobotStudio's Load Parameters). mode 'replace' " +
      "(default) replaces instances that exist and adds the rest; 'add' refuses duplicates; 'reset_and_add' CLEARS the domain first. " +
      "Most parameters take effect only after rs_restart_controller.",
    input: {
      controller,
      content: z.string().min(1).describe("The whole .cfg file, starting with its header line, e.g. 'EIO:CFG_1.0:6:0::'."),
      mode: z.enum(["replace", "add", "reset_and_add"]).optional(),
    },
    hints: WRITE,
  }, (a) => post("/config", a, 120000));

  defineTool(server, "rs_read_config_value", {
    title: "Read a configuration value",
    description: "One configuration attribute, e.g. domain MOC, type ARM, instance rob1_1, attribute upper_joint_bound.",
    input: {
      controller,
      domain: z.string().min(1), type: z.string().min(1), instance: z.string().min(1), attribute: z.string().min(1),
    },
    hints: READ,
  }, (a) => get("/config/value", a));

  defineTool(server, "rs_write_config_value", {
    title: "Write a configuration value",
    description: "Set one configuration attribute. Returns the previous and new value. Most parameters take effect only after rs_restart_controller.",
    input: {
      controller,
      domain: z.string().min(1), type: z.string().min(1), instance: z.string().min(1), attribute: z.string().min(1),
      value: z.string(),
    },
    hints: WRITE_IDEMPOTENT,
  }, (a) => post("/config/value", a));

  // ---------------------------------------------------------------- virtual panel

  defineTool(server, "rs_clear_guardstop", {
    title: "Clear a guard stop (virtual controller)",
    description: "Clear a latched guard stop on a VIRTUAL controller by pulsing its virtual pendant e-stop (press, release) and then " +
      "pressing motors-on. Motors-on alone does not clear the latch. Refuses a controller that is not stopped unless force=true, and " +
      "refuses real controllers.",
    input: {
      controller,
      motors_on: z.boolean().optional().describe("Press motors-on afterwards (default true)."),
      force: z.boolean().optional().describe("Pulse the e-stop even if the controller is not stopped (default false)."),
    },
    hints: WRITE,
  }, (a) => post("/panel/clear_guardstop", a));

  defineTool(server, "rs_set_estop", {
    title: "Virtual e-stop",
    description: "Press or release the virtual pendant emergency stop of a VIRTUAL controller (refuses real controllers). For " +
      "recovering from a guard stop use rs_clear_guardstop.",
    input: { controller, state: z.enum(["press", "release"]) }, hints: WRITE,
  }, (a) => post("/panel/estop", a));

  // ---------------------------------------------------------------- simulation

  defineTool(server, "rs_simulation_status", {
    title: "Simulation status",
    description: "RobotStudio simulation state, simulated time, speed, and the station's saved states.",
    input: {}, hints: READ,
  }, () => get("/simulation/status"));

  defineTool(server, "rs_start_simulation", {
    title: "Start the simulation",
    description: "Start (Play) the RobotStudio simulation.",
    input: {}, hints: SAFE_ACTION,
  }, () => post("/simulation/start"));

  defineTool(server, "rs_stop_simulation", {
    title: "Stop the simulation",
    description: "Stop the RobotStudio simulation.",
    input: {}, hints: SAFE_ACTION,
  }, () => post("/simulation/stop"));

  defineTool(server, "rs_pause_simulation", {
    title: "Pause the simulation",
    description: "Pause a running RobotStudio simulation.",
    input: {}, hints: SAFE_ACTION,
  }, () => post("/simulation/pause"));

  defineTool(server, "rs_reset_simulation", {
    title: "Reset the simulation",
    description: "Stop the simulation and restore a saved station state, as RobotStudio's Reset does. Without `state`, the station's only " +
      "saved state. Note: this resets the STATION; a virtual controller keeps its own joint positions (use rs_restart_controller for those).",
    input: { state: z.string().min(1).optional().describe("Saved state name (see rs_simulation_status).") },
    hints: WRITE,
  }, (a) => post("/simulation/reset", a, 180000));

  defineTool(server, "rs_set_sim_speed", {
    title: "Simulation speed",
    description: "Set the simulation speed multiplier (1.0 = real time).",
    input: { speed: z.number().min(0.01).max(100) }, hints: SAFE_ACTION,
  }, (a) => post("/simulation/speed", a));

  // ---------------------------------------------------------------- paths, targets, collisions

  defineTool(server, "rs_get_paths", {
    title: "Station paths",
    description: "The station's path procedures with controller, task, module and instruction count.",
    input: { controller: stationController, task }, hints: READ,
  }, (a) => get("/paths", a));

  defineTool(server, "rs_get_path_targets", {
    title: "Path instructions and targets",
    description: "A path's instructions in order, with each move's target name and position (mm, in its work object) and orientation.",
    input: {
      controller: stationController, task,
      module: z.string().min(1).optional().describe("Module, to disambiguate paths with the same name."),
      path: ident("Path (procedure) name."),
    },
    hints: READ,
  }, (a) => get("/paths/targets", a));

  defineTool(server, "rs_create_path", {
    title: "Create a path",
    description: "Create an empty path procedure in a station task (station only; synchronize to RAPID in RobotStudio to load it).",
    input: { controller: stationController, task, name: ident("New path name."), module: z.string().min(1).optional() },
    hints: WRITE,
  }, (a) => post("/paths/create", a));

  defineTool(server, "rs_create_target", {
    title: "Create a target",
    description: "Create a robot target in a station task at x/y/z mm in a work object (default: the task's active one). Orientation is " +
      "q1..q4 (ABB order, scalar first) or rx/ry/rz Euler ZYX degrees; default identity. Station only; synchronize to RAPID to load it.",
    input: {
      controller: stationController, task,
      name: ident("New target name."),
      x: z.number(), y: z.number(), z: z.number(),
      q1: z.number().optional(), q2: z.number().optional(), q3: z.number().optional(), q4: z.number().optional(),
      rx: z.number().optional(), ry: z.number().optional(), rz: z.number().optional(),
      workobject: z.string().min(1).optional(),
      module: z.string().min(1).optional(),
    },
    hints: WRITE,
  }, (a) => post("/targets/create", a));

  defineTool(server, "rs_delete_path", {
    title: "Delete a path",
    description: "Delete a path procedure from a station task (station only).",
    input: {
      controller: stationController, task,
      module: z.string().min(1).optional().describe("Module, to disambiguate paths with the same name."),
      name: ident("Path name."),
    },
    hints: WRITE,
  }, (a) => post("/paths/delete", a));

  defineTool(server, "rs_delete_target", {
    title: "Delete a target",
    description: "Delete a robot target (its data and its graphical target) from a station task. Refused while a path still moves to it.",
    input: { controller: stationController, task, name: ident("Target name.") },
    hints: WRITE,
  }, (a) => post("/targets/delete", a));

  defineTool(server, "rs_check_collisions", {
    title: "Check collisions",
    description: "Check the station's collision sets (or only `set`), or check the listed `objects` pairwise. Reports each colliding or " +
      "near-miss pair with the parts involved.",
    input: {
      set: z.string().min(1).optional(),
      objects: z.array(z.string().min(1)).optional().describe("Station object names or paths to check against each other."),
      near_miss_mm: z.number().min(0).max(10000).optional(),
    },
    hints: READ,
  }, (a) => post("/collision/check", a, 120000));
}

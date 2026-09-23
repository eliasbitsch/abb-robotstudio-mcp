# ABB RobotStudio MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for ABB robots and ABB RobotStudio.
It exposes 71 tools in two families:

- **`rs_*` (43 tools)** go through **RobotStudioBridge**, a small RobotStudio add-in that serves a local
  HTTP API from inside RobotStudio. They cover the open station (objects, paths, targets,
  collisions, simulation) and, through ABB's PC SDK, **any controller RobotStudio's PC SDK can
  reach**: a station's virtual controller, another virtual controller, or a real IRC5 or
  OmniCore on the network. Targeting is covered under *Choosing a controller*.
- **`rws_*` (28 tools)** talk **Robot Web Services** (REST) straight to one controller, with no
  RobotStudio needed. RWS 1.0 (IRC5, RobotWare 6) and RWS 2.0 (OmniCore, RobotWare 7) are detected
  and handled automatically.

Both families can read and change controller state: RAPID programs and variables, I/O,
configuration, motors, program execution and files. Read **Safety** below before pointing either
family at a real robot.

This release was verified end to end against RobotStudio 2025.5 virtual controllers running
RobotWare 6.16 (IRC5) and 7.21 (OmniCore). The PC SDK and RWS calls are the ones real controllers
use, but this release has not been run against physical hardware.

## Install

### MCP server

Requires Node.js 20 or newer.

```bash
git clone https://github.com/eliasbitsch/abb-robotstudio-mcp.git
cd abb-robotstudio-mcp
npm install
npm run build
```

### RobotStudio add-in (needed for `rs_*` only)

Install the distribution package. It installs per user, with no administrator rights:

1. Get `AbbRobotStudioMcp.RobotStudioBridge-<version>.rspak`, or build it yourself (below).
2. In RobotStudio: **Add-Ins** tab, **Install Package**, then pick the `.rspak`.
3. Restart RobotStudio. The add-in starts with RobotStudio and listens on `http://localhost:58080`.

Upgrading from 2.x: remove the old add-in first (uninstall its package, or delete its folder under
`Common Files\ABB\RobotStudio\Addins`). The add-in id changed in 3.0, so both would load and
compete for the port.

Check with `curl http://localhost:58080/ping`. It reports the add-in version, where it was
loaded from, and whether RobotStudio's UI thread is responsive.

To build the package you need the .NET SDK (or MSBuild), RobotStudio, and the free
[RobotStudio SDK](https://developercenter.robotstudio.com) for its `RspakTool.exe`:

```powershell
./build-rspak.ps1
```

The add-in compiles against `C:\Program Files (x86)\ABB\RobotStudio 2025\Bin` by default. For
another install, pass `-p:RobotStudioBin="<path to RobotStudio>\Bin"` to `dotnet build`. The
version comes from `addin/RobotStudioBridge.rsaddin` and must equal `package.json`'s: the server
refuses an add-in with a different major version.

<details>
<summary>Developer copy-install</summary>

`./install-addin.ps1` copies `addin\bin\RobotStudioBridge.dll` into
`%ProgramFiles(x86)%\Common Files\ABB\RobotStudio\Addins`. That needs administrator rights (the
script elevates) and RobotStudio must be closed. An installed `.rspak` package **shadows** this
copy: RobotStudio loads only the first add-in with a given ApplicationId, and it scans
`%LocalAppData%\ABB\DistributionPackages2` first. Uninstall the package to load a dev build.
</details>

## Configure your MCP client

```json
{
  "mcpServers": {
    "abb-robotstudio": {
      "command": "node",
      "args": ["C:/path/to/abb-robotstudio-mcp/dist/index.js"],
      "env": {
        "ABB_RWS_URL": "http://localhost:80",
        "ABB_RWS_USER": "Default User",
        "ABB_RWS_PASS": "robotics"
      }
    }
  }
}
```

| Variable | Default | Purpose |
|---|---|---|
| `ABB_BRIDGE_URL` | `http://localhost:58080` | The add-in. Must use the host name `localhost`: Windows refuses requests addressed to any other name, `127.0.0.1` included. |
| `ABB_BRIDGE_TIMEOUT_MS` | `60000` | How long an `rs_*` call waits for the add-in. Restarts and module writes use longer limits of their own. |
| `ABB_SDK_USER` / `ABB_SDK_PASS` | *(Default User)* | Controller login the add-in uses for `rs_*` calls. Set these for a controller where the default user is disabled. |
| `ABB_RWS_URL` | `http://localhost:80` | The controller `rws_*` talks to: scheme, host and port only. |
| `ABB_RWS_USER` / `ABB_RWS_PASS` | `Default User` / `robotics` | RWS login (Digest on RWS 1.0, Basic on RWS 2.0, negotiated automatically). |
| `ABB_RWS_TIMEOUT_MS` | `15000` | Per-request RWS timeout. |
| `ABB_RWS_TLS_INSECURE` | off | `1` accepts a self-signed HTTPS certificate: OmniCore serves RWS over HTTPS with one by default. It is announced on startup. `NODE_EXTRA_CA_CERTS` is the stricter alternative when the certificate matches the host name. |
| `ABB_BRIDGE_PORT` | `58080` | Read by the **add-in** (set it in RobotStudio's environment) to listen on another port. |

Endpoints by controller:

| Controller | `ABB_RWS_URL` |
|---|---|
| Real IRC5 | `http://<ip>` (port 80) |
| Real OmniCore | `https://<ip>` (port 443), with `ABB_RWS_TLS_INSECURE=1` |
| RobotStudio virtual controller | `http://localhost:<port>`. RobotStudio assigns the port; RobotWare 7 VCs also serve HTTPS. |

## Choosing a controller (`rs_*`)

Controller tools take an optional `controller`:

- **omitted**: the open station's only controller. With several, the tool refuses and lists them rather than guessing.
- **a station controller's name** (case-insensitive) or its **system id**.
- **any other controller**: its system name, controller name, system id or IP address. It is
  found by PC SDK network discovery, which is a LAN broadcast plus a direct probe of a given IP.
  Several matches (say, two virtual controllers sharing `127.0.0.1`) are refused with the
  candidates listed.

`rs_list_controllers` with `scan: true` shows everything discovery finds. Station tools (paths,
targets, simulation, collisions) take only the open station's controllers. The virtual-panel
tools refuse anything that is not a virtual controller.

Every `rs_*` call that reaches a controller opens its own short PC SDK connection and closes it
again. Nothing stays logged on between calls, and nothing goes stale when a controller restarts.

## Tools

`rs_*` and `rws_*` overlap on purpose. Use `rs_*` when RobotStudio is running: it needs no RWS
session, reaches any controller by name or IP, and has the richer RAPID, configuration and
event-log support. Use `rws_*` when RobotStudio is not in the picture.

### RobotStudio and the PC SDK (`rs_*`)

| Area | Tools |
|---|---|
| Add-in, station | `rs_ping`, `rs_list_controllers`, `rs_get_station`, `rs_get_station_objects` (filtered, bounded), `rs_save_station` |
| Controller | `rs_controller_status`, `rs_restart_controller` (warm, or reset RAPID), `rs_set_motors`, `rs_get_position`, `rs_event_log` |
| RAPID | `rs_get_tasks`, `rs_get_modules`, `rs_read_module`, `rs_write_module`, `rs_delete_module`, `rs_read_variable`, `rs_write_variable`, `rs_start_program`, `rs_stop_program`, `rs_reset_pp`, `rs_set_program_pointer` |
| I/O | `rs_get_io_signals`, `rs_read_io`, `rs_write_io` |
| Configuration | `rs_read_config` (a whole domain as a .cfg file), `rs_write_config` (load parameters), `rs_read_config_value`, `rs_write_config_value` |
| Virtual controllers | `rs_clear_guardstop`, `rs_set_estop` |
| Simulation | `rs_simulation_status`, `rs_start_simulation`, `rs_stop_simulation`, `rs_pause_simulation`, `rs_reset_simulation` (restores a saved station state), `rs_set_sim_speed` |
| Paths, targets | `rs_get_paths`, `rs_get_path_targets`, `rs_create_path`, `rs_delete_path`, `rs_create_target`, `rs_delete_target`, `rs_check_collisions` |

### Robot Web Services (`rws_*`)

| Area | Tools |
|---|---|
| Controller | `rws_controller_status` (includes whether it is virtual), `rws_set_motors`, `rws_get_position`, `rws_get_speed_override`, `rws_set_speed_override`, `rws_event_log` |
| RAPID | `rws_execution_state`, `rws_start_program`, `rws_stop_program`, `rws_reset_pp`, `rws_set_program_pointer`, `rws_get_tasks`, `rws_get_modules`, `rws_read_module`, `rws_write_module`, `rws_delete_module`, `rws_read_variable`, `rws_write_variable` |
| I/O | `rws_get_io_signals`, `rws_read_io`, `rws_write_io` |
| Files | `rws_list_files`, `rws_read_file`, `rws_write_file`, `rws_delete_file`, `rws_create_directory` |
| Mastership | `rws_request_mastership`, `rws_release_mastership` |

Every tool is annotated read-only or destructive, so a client can gate or confirm the destructive ones.

On connect the server also sends its operating notes (the MCP `instructions` field), which most
clients pass to whatever drives the tools. They cover what no single tool description can: which
family to use, how to pick a controller, confirming before acting on a real controller, the safe
order of operations, and the controller behaviour below that is easy to misread. The text is in
[src/instructions.ts](src/instructions.ts).

### How module writes behave

`rs_write_module` and `rws_write_module` take the **whole** module (`MODULE <name> ... ENDMODULE`),
which must declare the name given in `module`. The task must be stopped. Both write the text as
a file and load it, so size is no limit. Then they check the result:

- `rs_write_module` asks the controller to check the program and compares its errors before and after the load.
- `rws_write_module` reads the controller's program event log and the task's state, because RWS
  has no program-check call and loads a broken module with a success status. It also reads the
  text back and compares it with what was sent.

If the new code has errors, the previous version is restored (or a new module removed again), and
the controller's own messages are returned. Pass `on_error: "keep"` to leave the broken module
loaded instead. RobotWare 6 refuses any non-ASCII character in a module, comments included; the
tools report the first one's line and column before sending anything.

## Controllers: things worth knowing

- **Modes and mastership.** Remote motors-on and program start need AUTO mode. Writes need
  mastership, which the tools take and release around each call. The FlexPendant, an open
  RobotStudio RAPID editor or another client can hold it, and in manual mode the FlexPendant has
  to grant write access. The error says which of these applies.
- **I/O access.** A signal's Access Level decides whether remote clients may write it. Refusals
  come back as the controller's own message, e.g. *rejected by the controller safety access
  restriction mechanism*.
- **RWS sessions.** A controller allows 70 RWS sessions, and an OmniCore allows 5 per client IP.
  The server keeps one session, re-authenticates once for a whole burst when it expires, and
  logs out on shutdown.
- **RWS quirks the tools already handle.** Paged lists (signals, event log, directories) are
  followed to the end. OmniCore's event log is read newest-first, working around RobotWare 7.21's
  broken newest-first paging link. A stop followed straight away by a program-pointer reset or a
  start gets a brief "busy" answer from the controller, which is retried.

### Virtual controllers

- **A latched guard stop** (for instance `50027` from the controller's velocity projection) is not
  cleared by motors-on. `rs_clear_guardstop` does what an operator does at the pendant: press
  and release the e-stop, wait for the safety system to settle, then motors-on. It refuses a
  controller that is not stopped unless `force: true`.
- **RobotWare 6 virtual controllers reset their virtual panel whenever a PC SDK client
  connects.** A pressed virtual e-stop, from `rs_set_estop` or from RobotStudio's control panel,
  is released by the next `rs_*` call to that controller. It lands in EmergencyStopReset with
  the motors off. RobotWare 7 keeps the press.
- **Remote RWS access.** A virtual controller accepts RWS only from localhost by default; allow
  other hosts in its RWS settings. `rs_*` needs no RWS at all.

## Safety

These tools move real robots when pointed at real controllers: `rws_set_motors`,
`rs_start_program`, module and variable writes, I/O writes and configuration loads can all
change what a robot does. Use a virtual controller for development, keep a person with an
e-stop at any real cell, and prefer a client that asks before running tools marked destructive.

The add-in listens on `localhost` only. Every endpoint except `/ping` requires the
`X-RobotStudioBridge-Client` header and refuses requests carrying an `Origin` header. Every action is
POST-only. A web page in your browser therefore cannot call it: a link or `<img>` cannot trigger
an action, and a script cannot add the header without a CORS preflight, which the add-in never
approves. Other programs running as you can call it, just as they could run RobotStudio
themselves.

## Development

```bash
npm test            # unit tests: RWS parsing, Digest, paging, the session and auth logic against a mock
                    # controller, and that the operating notes and this README name the tools correctly
npm run test:live   # the whole tool surface against running virtual controllers
```

`test/live/run.mjs` needs RobotStudio with the add-in and a station holding one RobotWare 6 and
one RobotWare 7 virtual controller. See the file's header for names, ports and sections. It
refuses to run unless every target reports itself as virtual. It changes controller state
(motors, execution, test modules, I/O, configuration, restarts) and puts back what it changes.

## License

MIT, see [LICENSE](LICENSE).

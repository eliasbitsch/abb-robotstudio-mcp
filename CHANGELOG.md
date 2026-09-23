# Changelog

## 3.0.1

Fixes, verified against RobotWare 6.16 and 7.21 virtual controllers (`npm run test:live`).

### Fixed

- `rs_event_log` gave the number within an event's category as its `code` (27 for a `50027`
  "Joint Out of Range"), so looking for an ABB event code found nothing. It now gives the full
  code, the same as `rws_event_log` gives for the same message, plus `categoryId` and `number`.
  Descriptions are plain text, with consequences, causes and actions as their own fields, instead
  of the controller's XML. The controller messages `rs_write_module` returns after a failed load
  get the same fix.
- An RWS error on RobotWare 6 lost the controller's own reason: a motors-on refused during a guard
  stop or an e-stop read `HTTP 403 (-1073414146). Hint: resource not found`. The error now names
  the inner code and what it means (`-1073445881`, refused in the current state), and RWS's
  generic code `-1073414146` no longer claims "not found".
- The event-log tool descriptions give the category numbers the controllers use (9 safety,
  10 internal, 11 process, 12 configuration, 13 paint, 15 RAPID, 17 connected services), and say
  that 0 (common) holds every category except internal.

## 3.0.0

A reworked add-in and server, verified tool by tool against RobotWare 6.16 and 7.21 virtual
controllers (`npm run test:live`).

### Breaking

- The add-in is now called RobotStudioBridge and has a new add-in id. Remove any earlier version
  first (uninstall its package from RobotStudio's Add-Ins tab, or delete its folder under
  `Common Files\ABB\RobotStudio\Addins`): both would load, and only one can hold port 58080.
- The add-in's HTTP API changed and needs the `X-RobotStudioBridge-Client` header; server and add-in
  must share a major version (the server refuses a mismatched add-in and says so).
- `rs_*` controller tools take `controller` and refuse to guess when the station has several.
- `rs_create_target` coordinates are millimetres (they were passed to RobotStudio unconverted),
  and orientation is given as `q1..q4` or `rx/ry/rz`.
- `rs_read_config` / `rs_write_config` work on the controller's live configuration by domain
  (`MOC`, `EIO`, ...) instead of files in the system folder.
- `rs_write_variable` writes the live value (it used to write the station's initial value).
- `rws_start_program`'s `mode` is replaced by `regain` / `execmode` / `cycle` / `reset_pp`
  (`mode: "reset"` was never a valid execution mode).
- `ABB_BRIDGE_URL` must use the host name `localhost`.

### Security

- The add-in no longer accepts requests a web page can send: every route enforces its method,
  actions are POST-only, and every route but `/ping` requires the client header and refuses an
  `Origin` header. Previously any web page open in the user's browser could, with no click
  needed, press a virtual e-stop (an image tag pointing at the endpoint was enough) or write
  any file the user can write (a script's plain-text POST to the config endpoint).
- Configuration and module names are validated, so no parameter can name an arbitrary path.

### Fixed

- Tool failures are reported as MCP errors (`isError`), with the controller's own message,
  instead of success results carrying an HTML error page or empty fields.
- `rs_write_module` loaded broken code and reported success; it now reports the controller's
  errors and restores the previous version. `rws_write_module` no longer truncates large
  modules, and it detects load errors that RWS reports as success.
- `rs_get_io_signals`, `rs_get_path_targets`, `rs_check_collisions`, `rs_reset_simulation`,
  `rs_read_config` and `rs_create_target` returned nothing, or claimed success, without doing
  the work; they now do it.
- RWS lists are followed across pages (signals past the first 100 were invisible, and bare-name
  signal writes to them failed); the OmniCore event log is newest-first; a burst of calls
  after the session expires re-authenticates once instead of once per call; a failed first
  contact is no longer cached as the wrong RWS generation.
- The add-in never runs a UI-thread request that timed out later, no longer freezes RobotStudio
  while talking to a controller, and bounds every virtual-panel wait.
- `rs_clear_guardstop` refuses a controller that is not stopped, waits for the safety system
  to settle before motors-on, and names the controller it acts on.

### Added

- Controllers by name or IP over the PC SDK, including real ones (`rs_list_controllers`).
- `rs_restart_controller`, `rs_set_motors`, `rs_start_program`, `rs_stop_program`, `rs_reset_pp`,
  `rs_set_program_pointer`, `rs_delete_module`, `rs_read_io`, `rs_write_io`,
  `rs_read_config_value`, `rs_write_config_value`, `rs_event_log`, `rs_delete_path`,
  `rs_delete_target`.
- `rws_set_program_pointer`, `rws_delete_module`, `rws_delete_file`, `rws_create_directory`.
- `ABB_RWS_TLS_INSECURE` for OmniCore's self-signed HTTPS; request timeouts for both families;
  tool annotations (read-only / destructive); unit tests and a live test suite.
- Operating notes sent to clients on connect (the MCP `instructions` field): which family to use,
  picking a controller, confirming before acting on a real one, safe ordering and recovery. The
  unit tests check that they, and the README, name only tools that exist.

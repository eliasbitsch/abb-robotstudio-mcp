// Operating notes the server sends to MCP clients in its initialize result. Clients hand them
// to whoever is driving the tools, so they carry what no single tool description can: which
// family to use, how to pick a controller, the safe order of operations, and the controller
// behaviour that is easy to misread. Keep it short and in step with README.md; the unit tests
// check that every tool it names exists.

export const INSTRUCTIONS = `Operating notes for abb-robotstudio (ABB robot controllers and RobotStudio).

Two tool families:
- rs_* go through a RobotStudio add-in and ABB's PC SDK. They work only while RobotStudio is running with the add-in (check with rs_ping). They cover the open station (objects, paths, targets, collisions, simulation) and ANY controller the PC SDK can reach: the station's virtual controllers, other virtual controllers, and real IRC5/OmniCore controllers on the network.
- rws_* talk Robot Web Services to exactly one controller, the one configured in ABB_RWS_URL. Use them when RobotStudio is not running. rws_controller_status says which controller that is and whether it is virtual.
When both work, prefer rs_*: they need no RWS session, reach any controller, and read positions without lag.

These tools act on real robots. Motors on, program start, module/variable/I-O writes and configuration loads can make a robot move or change how it moves. Before any of those, check the target: rs_controller_status and rws_controller_status report isVirtual. On a controller that is not virtual, confirm with the user first, every time.

Picking a controller (rs_*): omit controller when the open station has exactly one. With several, the tool refuses and lists them; pass one by station name, system name, system id or IP. rs_list_controllers lists the station's controllers; scan=true also runs network discovery (a LAN broadcast). Station tools (paths, targets, simulation, collisions) accept only the open station's controllers.

Order of operations:
- Stop RAPID before writing or deleting modules or moving the program pointer. A reset or start straight after a stop may briefly answer busy; the tools retry that themselves.
- To run one routine: stop, rs_set_program_pointer (or rws_set_program_pointer), then start with reset_pp=false. reset_pp=true moves the pointer back to main.
- Motors on and program start need AUTO mode. In manual mode remote writes need write access granted on the FlexPendant.
- Configuration writes (rs_write_config, rs_write_config_value) mostly take effect only after rs_restart_controller. rs_write_config mode reset_and_add clears the whole domain first.
- Writes take and release mastership around each call. rws_request_mastership holds mastership until rws_release_mastership or the end of the RWS session; always release it. rs_restart_controller fails while anyone else holds mastership.

Module writes (rs_write_module, rws_write_module): send the whole module, MODULE <name> ... ENDMODULE, declaring the name given in module. If the controller reports errors, the previous version is restored and the controller's messages are returned; fix the code rather than retrying unchanged. RobotWare 6 refuses non-ASCII characters anywhere in a module, comments included.

Stops and recovery:
- A latched guard stop is not cleared by motors on (rs_set_motors, rws_set_motors). On a VIRTUAL controller use rs_clear_guardstop. On a real controller the operator clears it at the cell; do not try to work around it.
- An event 50027 during fast motion comes from the controller's velocity projection toward a joint limit; it does not mean a joint is out of range.
- rs_reset_simulation resets the station, not a controller: a virtual controller keeps its joint positions.
- RobotWare 6 virtual controllers reset their virtual panel whenever a PC SDK client connects: every rs_* call releases a virtual e-stop pressed with rs_set_estop or in RobotStudio. RobotWare 7 keeps the press.
- The FlexPendant's "error not acknowledged" banner cannot be cleared remotely by any tool.

Reading state: rs_get_position reads live joints and TCP through the PC SDK; rws_get_position can lag the robot. Event logs are newest first (rs_event_log, rws_event_log); read them after any unexpected stop. rs_get_station_objects is bounded; use its name and type filters.

Errors come back as tool errors carrying the controller's own message and code. A refusal that names mastership, operating mode, access level or a user grant is a condition to fix or report, not something to retry.`;

using System.Reflection;
using ABB.Robotics.RobotStudio.Stations;

namespace RobotStudioBridge
{
    // The HTTP API. GET routes only read; every route that changes anything is POST.
    // Parameters: GET takes the query string, POST a JSON object body. The MCP server's
    // src/bridge-client.ts is the only intended caller.
    internal static class Routes
    {
        public static void Register(Router r, int port)
        {
            // Liveness answers from the listener thread; the UI thread is probed separately
            // with a short timeout, so a busy RobotStudio reads as "UI busy", not "not running".
            r.Get("/ping", req =>
            {
                string station = null, uiError = null;
                bool responsive;
                try
                {
                    station = Ui.Invoke(() => Station.ActiveStation?.Name, 2000, 5000);
                    responsive = true;
                }
                catch (ApiException ex) { responsive = false; uiError = ex.Message; }
                return new
                {
                    status = "ok",
                    server = "RobotStudioBridge",
                    version = RobotStudioBridgeAddIn.Version,
                    port,
                    assemblyLocation = Assembly.GetExecutingAssembly().Location,
                    ui = new { responsive, dispatch = Ui.Mode, error = uiError },
                    stationOpen = responsive ? station != null : (bool?)null,
                    stationName = station,
                };
            }, isPublic: true);

            // station
            r.Get("/station", StationApi.GetStation);
            r.Get("/station/objects", StationApi.Objects);
            r.Post("/station/save", StationApi.Save);

            // simulation
            r.Get("/simulation/status", StationApi.SimulationStatus);
            r.Post("/simulation/start", StationApi.SimulationStart);
            r.Post("/simulation/stop", StationApi.SimulationStop);
            r.Post("/simulation/pause", StationApi.SimulationPause);
            r.Post("/simulation/reset", StationApi.SimulationReset);
            r.Post("/simulation/speed", StationApi.SimulationSpeed);

            // paths, targets, collisions (station controllers only)
            r.Get("/paths", StationApi.Paths);
            r.Get("/paths/targets", StationApi.PathTargets);
            r.Post("/paths/create", StationApi.CreatePath);
            r.Post("/paths/delete", StationApi.DeletePath);
            r.Post("/targets/create", StationApi.CreateTarget);
            r.Post("/targets/delete", StationApi.DeleteTarget);
            r.Post("/collision/check", StationApi.CheckCollisions);

            // controllers (station VCs, other VCs, real controllers)
            r.Get("/controllers", ControllerApi.Controllers);
            r.Get("/controller/status", ControllerApi.Status);
            r.Post("/controller/restart", ControllerApi.Restart);
            r.Post("/controller/motors", ControllerApi.Motors);
            r.Get("/eventlog", ControllerApi.EventLog);
            r.Get("/robot/position", ControllerApi.Position);

            // RAPID
            r.Get("/rapid/tasks", ControllerApi.Tasks);
            r.Get("/rapid/modules", ControllerApi.Modules);
            r.Get("/rapid/module/text", ControllerApi.ReadModule);
            r.Post("/rapid/module/text", ControllerApi.WriteModule);
            r.Post("/rapid/module/delete", ControllerApi.DeleteModule);
            r.Get("/rapid/variable", ControllerApi.ReadVariable);
            r.Post("/rapid/variable", ControllerApi.WriteVariable);
            r.Post("/rapid/start", ControllerApi.StartProgram);
            r.Post("/rapid/stop", ControllerApi.StopProgram);
            r.Post("/rapid/resetpp", ControllerApi.ResetProgramPointer);
            r.Post("/rapid/pp", ControllerApi.SetProgramPointer);

            // I/O
            r.Get("/io/signals", ControllerApi.Signals);
            r.Get("/io/signal", ControllerApi.ReadSignal);
            r.Post("/io/signal", ControllerApi.WriteSignal);

            // configuration
            r.Get("/config", ControllerApi.ReadConfig);
            r.Post("/config", ControllerApi.LoadConfig);
            r.Get("/config/value", ControllerApi.ReadConfigValue);
            r.Post("/config/value", ControllerApi.WriteConfigValue);

            // virtual panel (virtual controllers only)
            r.Post("/panel/estop", ControllerApi.Estop);
            r.Post("/panel/clear_guardstop", ControllerApi.ClearGuardStop);
        }
    }
}

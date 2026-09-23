using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using ABB.Robotics.Controllers;
using ABB.Robotics.Controllers.EventLogDomain;
using ABB.Robotics.Controllers.IOSystemDomain;
using ABB.Robotics.Controllers.MotionDomain;
using ABB.Robotics.Controllers.RapidDomain;
using ABB.Robotics.RobotStudio.Stations;
using CfgLoadMode = ABB.Robotics.Controllers.ConfigurationDomain.LoadMode;
using RapidModule = ABB.Robotics.Controllers.RapidDomain.Module;
using RapidTask = ABB.Robotics.Controllers.RapidDomain.Task;
using SysTask = System.Threading.Tasks.Task;

namespace RobotStudioBridge
{
    // Operations on a controller through the PC SDK. These work on any controller the
    // PC SDK can reach -- a station VC, another VC, or a real IRC5/OmniCore -- and all of
    // them run on the request thread, never on RobotStudio's UI thread (see Ui.cs).
    internal static class ControllerApi
    {
        // -------------------------------------------------------------- discovery / status

        public static object Controllers(Req r)
        {
            var scan = r.Bool("scan", false);
            var station = Targets.StationControllers();
            var result = new Dictionary<string, object>
            {
                ["station"] = station.Select(c => new
                {
                    name = c.Name,
                    systemId = c.SystemId.ToString("D"),
                    systemState = c.SystemState,
                    systemPath = c.SystemPath,
                }).ToList(),
            };
            if (scan)
            {
                var ids = new HashSet<Guid>(station.Select(c => c.SystemId));
                result["network"] = Discovery.Scan(fresh: true).Select(i => new
                {
                    systemName = i.SystemName,
                    controllerName = i.ControllerName,
                    ip = i.IPAddress?.ToString(),
                    isVirtual = i.IsVirtual,
                    systemId = i.SystemId.ToString("D"),
                    robotWare = i.VersionName,
                    availability = i.Availability.ToString(),
                    inStation = ids.Contains(i.SystemId),
                }).ToList();
            }
            return result;
        }

        public static object Status(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            return Targets.With(t, r, c => new
            {
                controller = t.Describe(),
                systemName = c.SystemName,
                controllerName = c.Name,
                isVirtual = c.IsVirtual,
                ip = c.IPAddress?.ToString(),
                robotWare = c.RobotWareVersion?.ToString(),
                operatingMode = c.OperatingMode.ToString(),
                controllerState = c.State.ToString(),
                rapidExecution = c.Rapid.ExecutionStatus.ToString(),
                startTime = Iso(c.StartTime),
                tasks = c.Rapid.GetTasks().Select(k => new
                {
                    name = k.Name,
                    motion = k.Motion,
                    enabled = k.Enabled,
                    execution = k.ExecutionStatus.ToString(),
                }).ToList(),
            });
        }

        public static object Restart(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var mode = r.Choice("mode", "warm", "warm", "reset_rapid");
            var wait = r.Bool("wait", true);
            var timeoutS = r.Int("timeout_s", 240, 30, 900);
            var startMode = mode == "warm" ? ControllerStartMode.Warm : ControllerStartMode.PStart;

            DateTime before = default(DateTime);
            Targets.With(t, r, c =>
            {
                before = c.StartTime;
                using (Targets.MasterController(c, "a restart"))
                    c.Restart(startMode);
                return 0;
            });

            if (!wait)
                return new { controller = t.Describe(), mode, restarted = "requested", note = "Not waiting for the controller to come back (wait=false)." };

            // Wait until the controller answers with a new start time, then until its state
            // has held still for a few seconds: a RobotWare 6 VC with SafeMove measurably
            // passes through motors-on and a guard stop while its safety controller boots.
            var sw = Stopwatch.StartNew();
            string lastError = null, state = null, lastState = null, opMode = null, exec = null;
            var settledAt = TimeSpan.Zero;
            bool back = false;
            while (sw.Elapsed.TotalSeconds < timeoutS)
            {
                Thread.Sleep(2000);
                try
                {
                    var snap = Targets.With(t, r, c => new
                    {
                        start = c.StartTime,
                        st = c.State.ToString(),
                        om = c.OperatingMode.ToString(),
                        ex = c.Rapid.ExecutionStatus.ToString(),
                    });
                    if (snap.start == before || snap.st == "Init") { back = false; continue; }
                    if (!back || snap.st != lastState) { back = true; lastState = snap.st; settledAt = sw.Elapsed; }
                    state = snap.st; opMode = snap.om; exec = snap.ex;
                    if ((sw.Elapsed - settledAt).TotalSeconds >= 4) break;
                }
                catch (ApiException ex) { lastError = ex.Message; back = false; }
            }
            if (state == null)
                throw new ApiException(504, "restart_timeout",
                    $"The restart was issued but controller '{t.Name}' had not come back after {timeoutS} s." +
                    (lastError != null ? " Last error: " + lastError : ""));
            return new
            {
                controller = t.Describe(),
                mode,
                restarted = true,
                seconds = Math.Round(sw.Elapsed.TotalSeconds, 1),
                controllerState = state,
                operatingMode = opMode,
                rapidExecution = exec,
                note = state == "GuardStop" || state == "EmergencyStop"
                    ? "The controller came back stopped by its safety system; see the event log." : null,
            };
        }

        // A RAPID state change is acknowledged before the task has finished unwinding, so a
        // call right behind it can be refused as busy: controller code -4503, C0049007 through
        // the PC SDK (measured after a stop). Retry exactly that, briefly; any other error
        // surfaces at once.
        static T Busy<T>(Func<T> call)
        {
            for (int attempt = 1; ; attempt++)
            {
                try { return call(); }
                catch (Exception ex) when (attempt < 10 && Errors.Code(ex) == "C0049007") { Thread.Sleep(500); }
            }
        }

        static void Busy(Action call) => Busy<object>(() => { call(); return null; });

        // -------------------------------------------------------------- RAPID structure

        static RapidTask GetTask(Controller c, string name)
        {
            var tasks = c.Rapid.GetTasks();
            if (string.IsNullOrEmpty(name))
            {
                var motion = tasks.Where(k => k.Motion).ToList();
                if (tasks.Length == 1) return tasks[0];
                if (motion.Count == 1) return motion[0];
                throw ApiException.BadRequest($"Pass `task`: the controller has {tasks.Length} tasks ({string.Join(", ", tasks.Select(k => k.Name))}).");
            }
            return tasks.FirstOrDefault(k => k.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
                ?? throw ApiException.NotFound($"Task '{name}' not found. Tasks: {string.Join(", ", tasks.Select(k => k.Name))}.");
        }

        static RapidModule FindModule(RapidTask task, string name) =>
            task.GetModules().FirstOrDefault(m => m.Name.Equals(name, StringComparison.OrdinalIgnoreCase));

        static RapidModule GetModule(RapidTask task, string name) =>
            FindModule(task, name) ?? throw ApiException.NotFound(
                $"Module '{name}' not found in task {task.Name}. Modules: {string.Join(", ", task.GetModules().Select(m => m.Name))}.");

        public static object Tasks(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            return Targets.With(t, r, c => c.Rapid.GetTasks().Select(k =>
            {
                ProgramPosition pp = null;
                try { pp = k.ProgramPointer; } catch { }
                return new
                {
                    name = k.Name,
                    type = k.TaskType.ToString(),
                    motion = k.Motion,
                    enabled = k.Enabled,
                    execution = k.ExecutionStatus.ToString(),
                    programPointer = pp == null || string.IsNullOrEmpty(pp.Module) ? null : new { module = pp.Module, routine = pp.Routine },
                    modules = k.GetModules().Length,
                };
            }).ToList());
        }

        public static object Modules(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var taskName = r.Identifier("task", false);
            return Targets.With(t, r, c =>
            {
                var task = GetTask(c, taskName);
                return new
                {
                    task = task.Name,
                    modules = task.GetModules().Select(m => new
                    {
                        name = m.Name,
                        system = m.IsSystem,
                        encoded = m.IsEncoded,
                        noView = m.IsNoView,
                        readOnly = m.IsReadOnly,
                        viewOnly = m.IsViewOnly,
                    }).ToList(),
                };
            });
        }

        // Save the loaded module into a fresh controller temp directory and fetch the file:
        // this is the live loaded text, whatever file (if any) it was originally loaded from.
        static string SaveModuleText(Controller c, CtrlTemp tmp, LocalTemp local, RapidModule mod, string sub, out string fileName)
        {
            var dir = tmp.Sub(sub);
            mod.SaveToFile(tmp.CtrlPath(dir));
            foreach (var ext in new[] { ".modx", ".sysx", ".mod", ".sys" })
            {
                var rel = tmp.RelPath(dir + "/" + mod.Name + ext);
                if (!c.FileSystem.FileExists(rel)) continue;
                var lp = local.File(sub + "_" + mod.Name + ext);
                c.FileSystem.GetFile(rel, lp, true);
                fileName = mod.Name + ext;
                return TextFiles.Read(lp, ext.EndsWith("x"));
            }
            throw ApiException.Failed($"The controller saved module {mod.Name} but no {mod.Name}.(modx|sysx|mod|sys) file appeared.");
        }

        public static object ReadModule(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var taskName = r.Identifier("task", false);
            var modName = r.Identifier("module", true);
            return Targets.With(t, r, c =>
            {
                var task = GetTask(c, taskName);
                var mod = GetModule(task, modName);
                if (mod.IsEncoded || mod.IsNoView)
                    throw ApiException.Conflict($"Module {mod.Name} is {(mod.IsEncoded ? "encoded" : "NOVIEW")}; the controller does not expose its source.");
                using (var tmp = new CtrlTemp(c))
                using (var local = new LocalTemp())
                {
                    string file;
                    var text = SaveModuleText(c, tmp, local, mod, "read", out file);
                    return new { task = task.Name, module = mod.Name, system = mod.IsSystem, file, length = text.Length, text };
                }
            });
        }

        static readonly Regex ModuleHeader = new Regex(
            @"^\s*MODULE\s+([A-Za-z][A-Za-z0-9_]*)\s*(\(([^)]*)\))?",
            RegexOptions.Multiline | RegexOptions.IgnoreCase);

        static string ErrorKey(ProgramError e) => $"{e.TaskName}|{e.ModuleName}|{e.Line}|{e.Column}";

        static int NewestSeq(Controller c, CategoryType category)
        {
            try
            {
                var ms = c.EventLog.GetCategory(category).Messages;
                return ms.Count > 0 ? ms[0].SequenceNumber : -1;
            }
            catch { return int.MaxValue; } // no category: report no messages rather than wrong ones
        }

        static List<object> MessagesSince(Controller c, CategoryType category, int mark, int max = 20)
        {
            var result = new List<object>();
            if (mark == int.MaxValue) return result;
            try
            {
                var ms = c.EventLog.GetCategory(category).Messages;
                for (int i = 0; i < Math.Min(ms.Count, 200) && result.Count < max; i++)
                {
                    var m = ms[i];
                    if (m.SequenceNumber <= mark) break;
                    result.Add(new { code = m.Number, type = m.Type.ToString(), title = m.Title, description = m.Body });
                }
            }
            catch { }
            result.Reverse();
            return result;
        }

        public static object WriteModule(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var taskName = r.Identifier("task", false);
            var modName = r.Identifier("module", true);
            var code = r.Str("code", true);
            var onError = r.Choice("on_error", "restore", "restore", "keep");

            var header = ModuleHeader.Match(code);
            if (!header.Success)
                throw ApiException.BadRequest("`code` must be a whole RAPID module: it has no 'MODULE <name>' line.");
            if (!header.Groups[1].Value.Equals(modName, StringComparison.OrdinalIgnoreCase))
                throw ApiException.BadRequest($"`code` declares MODULE {header.Groups[1].Value} but `module` is {modName}; they must match.");
            if (!Regex.IsMatch(code, @"^\s*ENDMODULE\b", RegexOptions.Multiline | RegexOptions.IgnoreCase))
                throw ApiException.BadRequest("`code` has no ENDMODULE line; send the whole module.");
            bool sysModule = header.Groups[3].Success &&
                             Regex.IsMatch(header.Groups[3].Value, @"\bSYSMODULE\b", RegexOptions.IgnoreCase);

            return Targets.With(t, r, c =>
            {
                var task = GetTask(c, taskName);
                if (task.ExecutionStatus == TaskExecutionStatus.Running)
                    throw ApiException.Conflict($"Task {task.Name} is running. Stop RAPID before replacing a module.");
                bool rw7 = c.IsRobotWare7;
                if (!rw7) RejectNonAscii(code);

                var existing = FindModule(task, modName);
                if (existing != null && onError == "restore" && (existing.IsEncoded || existing.IsNoView))
                    throw ApiException.Conflict(
                        $"Module {existing.Name} is {(existing.IsEncoded ? "encoded" : "NOVIEW")}, so it cannot be backed up for restore-on-error. " +
                        "Pass on_error=\"keep\" to replace it anyway.");

                var ext = sysModule ? (rw7 ? ".sysx" : ".sys") : (rw7 ? ".modx" : ".mod");
                using (var tmp = new CtrlTemp(c))
                using (var local = new LocalTemp())
                {
                    string backupPath = null;
                    if (existing != null && onError == "restore")
                    {
                        string backupFile;
                        SaveModuleText(c, tmp, local, existing, "backup", out backupFile);
                        backupPath = tmp.CtrlPath("backup/" + backupFile);
                    }

                    var file = modName + ext;
                    var lf = local.File(file);
                    TextFiles.Write(lf, code, rw7);
                    c.FileSystem.PutFile(lf, tmp.RelPath(file), true);

                    var mark = NewestSeq(c, CategoryType.Program);

                    using (Targets.Master(c.Rapid, "RAPID"))
                    {
                        // CheckProgram needs RAPID mastership too (measured: C004841D without it).
                        var before = new HashSet<string>(task.CheckProgram().Errors.Select(ErrorKey));
                        bool ok = Busy(() => task.LoadModuleFromFile(tmp.CtrlPath(file), RapidLoadMode.Replace));
                        var newErrors = task.CheckProgram().Errors.Where(e => !before.Contains(ErrorKey(e))).ToList();
                        // LoadModuleFromFile returns false whenever the PROGRAM has errors, including
                        // ones that were already there in other modules (measured), so success is
                        // judged by the errors this load added.
                        if (newErrors.Count == 0 && (ok || before.Count > 0))
                            return new
                            {
                                task = task.Name,
                                module = modName,
                                replaced = existing != null,
                                length = code.Length,
                                result = existing != null ? "replaced" : "added",
                                warning = ok ? null : $"The program already had {before.Count} error(s) in other modules before this write; they are still there.",
                            };

                        var messages = MessagesSince(c, CategoryType.Program, mark);
                        string outcome;
                        if (onError == "keep")
                            outcome = "The module was left loaded WITH these errors (on_error=keep); the program cannot run until they are fixed.";
                        else if (backupPath != null)
                            outcome = Busy(() => task.LoadModuleFromFile(backupPath, RapidLoadMode.Replace))
                                ? "The previous version of the module was restored."
                                : "RESTORE FAILED: the previous version was reloaded but the controller reports errors; check the program.";
                        else
                        {
                            try { Busy(() => task.DeleteModule(modName)); outcome = "The module did not exist before, so it was removed again."; }
                            catch (Exception ex) { outcome = "The module did not exist before, but removing it failed: " + Errors.Clean(ex); }
                        }
                        throw ApiException.Failed(
                            $"The controller reported errors loading module {modName}. {outcome}",
                            new
                            {
                                errors = newErrors.Select(e => new { task = e.TaskName, module = e.ModuleName, line = e.Line, column = e.Column }).ToList(),
                                controllerMessages = messages,
                            });
                    }
                }
            });
        }

        // RobotWare 6's RAPID loader refuses a module with any non-ASCII character, even in
        // a comment, and reports it somewhere unhelpful. Say exactly where it is.
        static void RejectNonAscii(string code)
        {
            int line = 1, col = 0;
            foreach (var ch in code)
            {
                if (ch == '\n') { line++; col = 0; continue; }
                col++;
                if (ch > 127)
                    throw ApiException.BadRequest(
                        $"RobotWare 6 rejects non-ASCII characters anywhere in a module, comments included: " +
                        $"'{ch}' (U+{(int)ch:X4}) at line {line}, column {col}.");
            }
        }

        public static object DeleteModule(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var taskName = r.Identifier("task", false);
            var modName = r.Identifier("module", true);
            return Targets.With(t, r, c =>
            {
                var task = GetTask(c, taskName);
                var mod = GetModule(task, modName);
                if (task.ExecutionStatus == TaskExecutionStatus.Running)
                    throw ApiException.Conflict($"Task {task.Name} is running. Stop RAPID before deleting a module.");
                // Read everything needed from the module BEFORE deleting it: the handle of a
                // deleted module throws C0048409 on any property (measured).
                var name = mod.Name;
                var wasSystem = mod.IsSystem;
                using (Targets.Master(c.Rapid, "RAPID"))
                    Busy(() => task.DeleteModule(name));
                if (FindModule(task, modName) != null)
                    throw ApiException.Failed($"The controller accepted the delete but module {name} is still loaded.");
                return new { task = task.Name, module = name, deleted = true, wasSystem };
            });
        }

        // -------------------------------------------------------------- RAPID data

        static string Storage(SymbolTypes type) =>
            (type & SymbolTypes.Constant) != 0 ? "CONST"
            : (type & SymbolTypes.Persistent) != 0 ? "PERS"
            : (type & SymbolTypes.Variable) != 0 ? "VAR" : type.ToString();

        static RapidData FindData(RapidTask task, string module, string name, out string foundModule)
        {
            if (module != null)
            {
                var mod = GetModule(task, module);
                RapidData rd = null;
                try { rd = mod.GetRapidData(name); } catch { }
                if (rd == null)
                    throw ApiException.NotFound($"RAPID data '{name}' not found in module {mod.Name} of task {task.Name}.");
                foundModule = mod.Name;
                return rd;
            }

            var props = RapidSymbolSearchProperties.CreateDefaultForData(true);
            props.LocalSymbols = true;
            props.GlobalSymbols = true;
            props.InUse = false;
            var found = task.SearchRapidSymbol(props, "^" + name + "$")
                            .Where(s => s.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
                            .ToList();
            if (found.Count > 1)
                throw ApiException.Conflict(
                    $"'{name}' is declared in more than one module of task {task.Name} ({string.Join(", ", found.Select(s => string.Join("/", s.Scope)))}); pass `module`.");
            if (found.Count == 1)
            {
                var scope = found[0].Scope;
                foundModule = scope.Length >= 3 ? scope[scope.Length - 2] : null;
                return task.GetRapidData(found[0]);
            }
            throw ApiException.NotFound($"RAPID data '{name}' not found in task {task.Name} (searched every module).");
        }

        public static object ReadVariable(Req r)
        {
            var spec = r.Str("controller");
            var t = Targets.Resolve(spec);
            var taskName = r.Identifier("task", false);
            var module = r.Identifier("module", false);
            var name = r.Identifier("name", true);
            return Targets.With(t, r, c =>
            {
                var task = GetTask(c, taskName);
                string foundModule;
                var rd = FindData(task, module, name, out foundModule);
                try
                {
                    return new
                    {
                        task = task.Name,
                        module = foundModule,
                        name = rd.Name,
                        dataType = rd.RapidType,
                        storage = Storage(rd.Symbol.Type),
                        isArray = rd.IsArray,
                        isTaskPers = rd.IsTaskPers,
                        isLocal = rd.IsLocal,
                        value = rd.StringValue,
                    };
                }
                finally { (rd as IDisposable)?.Dispose(); }
            });
        }

        public static object WriteVariable(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var taskName = r.Identifier("task", false);
            var module = r.Identifier("module", false);
            var name = r.Identifier("name", true);
            var value = r.Str("value", true);
            return Targets.With(t, r, c =>
            {
                var task = GetTask(c, taskName);
                string foundModule;
                var rd = FindData(task, module, name, out foundModule);
                try
                {
                    var storage = Storage(rd.Symbol.Type);
                    if (storage == "CONST")
                        throw ApiException.Conflict($"{rd.Name} is a CONST; a constant's value can only change by editing the module.");
                    var previous = rd.StringValue;
                    using (Targets.Master(c.Rapid, "RAPID"))
                    {
                        try { rd.StringValue = value; }
                        catch (Exception ex)
                        {
                            var code = Errors.Code(ex);
                            var hint = code == "C004900D"
                                ? $" '{value}' is not a valid {rd.RapidType} literal (RAPID syntax: strings in double quotes, records in [ ], booleans TRUE/FALSE)."
                                : "";
                            throw ApiException.Failed($"The controller refused the write: {Errors.Clean(ex)}{hint}");
                        }
                    }
                    return new
                    {
                        task = task.Name,
                        module = foundModule,
                        name = rd.Name,
                        dataType = rd.RapidType,
                        storage,
                        previous,
                        value = rd.StringValue,
                    };
                }
                finally { (rd as IDisposable)?.Dispose(); }
            });
        }

        // -------------------------------------------------------------- motion / execution

        public static object Position(Req r)
        {
            var spec = r.Str("controller");
            List<CtrlTarget> targets;
            if (string.IsNullOrWhiteSpace(spec))
            {
                var station = Targets.StationControllers();
                if (station.Count == 0)
                    throw ApiException.BadRequest("No controller in the active station; pass `controller` (a name or IP).");
                targets = station.Select(s => new CtrlTarget { Name = s.Name, SystemId = s.SystemId, InStation = true }).ToList();
                var notStarted = station.Where(s => !s.SystemState.Equals("Started", StringComparison.OrdinalIgnoreCase)).ToList();
                var result = new List<object>();
                foreach (var s in notStarted)
                    result.Add(new { controller = s.Name, error = $"not started (state: {s.SystemState})" });
                foreach (var target in targets.Where(x => !notStarted.Any(n => n.SystemId == x.SystemId)))
                    result.Add(PositionOf(target, r));
                return result;
            }
            return new List<object> { PositionOf(Targets.Resolve(spec), r) };
        }

        static object PositionOf(CtrlTarget t, Req r)
        {
            try
            {
                return Targets.With(t, r, c =>
                {
                    var units = new List<object>();
                    foreach (MechanicalUnit mu in c.MotionSystem.MechanicalUnits)
                    {
                        object joints = null, ext = null, tcp = null;
                        var errors = new List<string>();
                        string taskName = null;
                        try { taskName = mu.Task?.Name; } catch { }
                        try
                        {
                            var jt = mu.GetPosition();
                            joints = new[] { (double)jt.RobAx.Rax_1, jt.RobAx.Rax_2, jt.RobAx.Rax_3, jt.RobAx.Rax_4, jt.RobAx.Rax_5, jt.RobAx.Rax_6 };
                            // Unused external axes read 9E9, the RAPID convention.
                            ext = new[] { (double)jt.ExtAx.Eax_a, jt.ExtAx.Eax_b, jt.ExtAx.Eax_c, jt.ExtAx.Eax_d, jt.ExtAx.Eax_e, jt.ExtAx.Eax_f };
                        }
                        catch (Exception ex) { errors.Add("joints: " + Errors.Clean(ex)); }
                        if (mu.Type == ABB.Robotics.Controllers.MotionDomain.MechanicalUnitType.TcpRobot)
                        {
                            try
                            {
                                var rt = mu.GetPosition(CoordinateSystemType.World);
                                tcp = new
                                {
                                    x = (double)rt.Trans.X, y = (double)rt.Trans.Y, z = (double)rt.Trans.Z,
                                    q1 = rt.Rot.Q1, q2 = rt.Rot.Q2, q3 = rt.Rot.Q3, q4 = rt.Rot.Q4,
                                };
                            }
                            catch (Exception ex) { errors.Add("tcp: " + Errors.Clean(ex)); }
                        }
                        units.Add(new
                        {
                            name = mu.Name,
                            model = mu.Model,
                            type = mu.Type.ToString(),
                            axes = mu.NumberOfAxes,
                            task = taskName,
                            joints_deg = joints,
                            external_axes = ext,
                            tcp_world_mm = tcp,
                            error = errors.Count > 0 ? string.Join("; ", errors) : null,
                        });
                    }
                    return new { controller = t.Name, controllerState = c.State.ToString(), units };
                });
            }
            catch (ApiException ex) when (ex.Status >= 500)
            {
                // One unreachable controller must not hide the others.
                return new { controller = t.Name, error = ex.Message };
            }
        }

        static ControllerState WaitState(Controller c, Func<ControllerState, bool> done, int timeoutMs, List<string> trace = null)
        {
            var sw = Stopwatch.StartNew();
            var last = c.State;
            trace?.Add($"{last}@0ms");
            while (!done(last) && sw.ElapsedMilliseconds < timeoutMs)
            {
                Thread.Sleep(100);
                var s = c.State;
                if (s != last) { last = s; trace?.Add($"{s}@{sw.ElapsedMilliseconds}ms"); }
            }
            return last;
        }

        public static object Motors(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var on = r.Choice("state", null, "on", "off") ?? throw ApiException.BadRequest("Missing required parameter 'state' (on or off).");
            return Targets.With(t, r, c =>
            {
                var target = on == "on" ? ControllerState.MotorsOn : ControllerState.MotorsOff;
                var before = c.State;
                if (before != target)
                {
                    try { c.State = target; }
                    catch (Exception ex)
                    {
                        throw ApiException.Failed($"The controller refused motors {on}: {Errors.Clean(ex)} " +
                            $"(state {before}, mode {c.OperatingMode}; remote motors-on needs AUTO mode and a closed safety chain).");
                    }
                }
                var after = WaitState(c, s => s == target, 5000);
                if (after != target)
                    throw ApiException.Failed($"Requested motors {on} but the controller is in {after} after 5 s.");
                return new { controller = t.Name, before = before.ToString(), controllerState = after.ToString() };
            });
        }

        static readonly Dictionary<string, ExecutionMode> ExecModes = new Dictionary<string, ExecutionMode>
        {
            ["continue"] = ExecutionMode.Continuous, ["stepin"] = ExecutionMode.StepIn, ["stepover"] = ExecutionMode.StepOver,
            ["stepout"] = ExecutionMode.StepOut, ["stepback"] = ExecutionMode.StepBack, ["steplast"] = ExecutionMode.StepLast,
            ["stepmotion"] = ExecutionMode.StepMotion,
        };

        public static object StartProgram(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var regain = r.Choice("regain", "continue", "continue", "regain", "clear");
            var exec = r.Choice("execmode", "continue", ExecModes.Keys.ToArray());
            var cycle = r.Choice("cycle", "forever", "forever", "once", "asis");
            var resetPp = r.Bool("reset_pp", false);
            return Targets.With(t, r, c =>
            {
                var tasks = new List<string>();
                StartResult result;
                using (Targets.Master(c.Rapid, "RAPID"))
                {
                    if (resetPp)
                        foreach (var k in c.Rapid.GetTasks().Where(k => k.Enabled)) { Busy(k.ResetProgramPointer); tasks.Add(k.Name); }
                    try
                    {
                        result = Busy(() => c.Rapid.Start(
                            regain == "continue" ? RegainMode.Continue : regain == "regain" ? RegainMode.Regain : RegainMode.Clear,
                            ExecModes[exec],
                            cycle == "forever" ? ExecutionCycle.Forever : cycle == "once" ? ExecutionCycle.Once : ExecutionCycle.AsIs,
                            StartCheck.None, true));
                    }
                    catch (Exception ex)
                    {
                        throw ApiException.Failed($"The controller refused to start RAPID: {Errors.Clean(ex)} " +
                            $"(state {c.State}, mode {c.OperatingMode}; remote start needs AUTO mode and motors on).");
                    }
                }
                if (result != StartResult.Ok)
                    throw ApiException.Failed($"RAPID start returned {result}.");
                Thread.Sleep(300);
                return new
                {
                    controller = t.Name,
                    result = result.ToString(),
                    ppResetIn = resetPp ? tasks : null,
                    rapidExecution = c.Rapid.ExecutionStatus.ToString(),
                };
            });
        }

        public static object StopProgram(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var mode = r.Choice("mode", "stop", "stop", "cycle", "instruction");
            return Targets.With(t, r, c =>
            {
                var stop = mode == "cycle" ? StopMode.Cycle : mode == "instruction" ? StopMode.Instruction : StopMode.Immediate;
                try { c.Rapid.Stop(stop); }
                catch (Exception ex) { throw ApiException.Failed("The controller refused to stop RAPID: " + Errors.Clean(ex)); }
                var sw = Stopwatch.StartNew();
                while (c.Rapid.ExecutionStatus == ExecutionStatus.Running && sw.ElapsedMilliseconds < (mode == "stop" ? 5000 : 1000))
                    Thread.Sleep(100);
                return new { controller = t.Name, mode, rapidExecution = c.Rapid.ExecutionStatus.ToString() };
            });
        }

        public static object ResetProgramPointer(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var taskName = r.Identifier("task", false);
            return Targets.With(t, r, c =>
            {
                var tasks = taskName == null ? c.Rapid.GetTasks().Where(k => k.Enabled).ToList()
                                             : new List<RapidTask> { GetTask(c, taskName) };
                if (c.Rapid.ExecutionStatus == ExecutionStatus.Running)
                    throw ApiException.Conflict("RAPID is running. Stop it before resetting the program pointer.");
                using (Targets.Master(c.Rapid, "RAPID"))
                    foreach (var k in tasks)
                    {
                        try { Busy(k.ResetProgramPointer); }
                        catch (Exception ex) { throw ApiException.Failed($"PP to main failed in task {k.Name}: {Errors.Clean(ex)}"); }
                    }
                return new
                {
                    controller = t.Name,
                    tasks = tasks.Select(k =>
                    {
                        ProgramPosition pp = null;
                        try { pp = k.ProgramPointer; } catch { }
                        return new { task = k.Name, module = pp?.Module, routine = pp?.Routine };
                    }).ToList(),
                };
            });
        }

        public static object SetProgramPointer(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var taskName = r.Identifier("task", false);
            var module = r.Identifier("module", true);
            var routine = r.Identifier("routine", true);
            return Targets.With(t, r, c =>
            {
                var task = GetTask(c, taskName);
                if (task.ExecutionStatus == TaskExecutionStatus.Running)
                    throw ApiException.Conflict($"Task {task.Name} is running. Stop it before moving the program pointer.");
                var mod = GetModule(task, module);
                using (Targets.Master(c.Rapid, "RAPID"))
                {
                    try { Busy(() => task.SetProgramPointer(mod.Name, routine)); }
                    catch (Exception ex)
                    {
                        throw ApiException.Failed($"Could not set the program pointer to {mod.Name}.{routine} in {task.Name}: {Errors.Clean(ex)} " +
                                                  "(the routine must exist, be a procedure without parameters, and the program must be free of errors).");
                    }
                }
                ProgramPosition pp = null;
                try { pp = task.ProgramPointer; } catch { }
                return new { controller = t.Name, task = task.Name, module = pp?.Module, routine = pp?.Routine };
            });
        }

        // -------------------------------------------------------------- I/O

        static string ShortType(SignalType t)
        {
            switch (t)
            {
                case SignalType.DigitalInput: return "DI";
                case SignalType.DigitalOutput: return "DO";
                case SignalType.AnalogInput: return "AI";
                case SignalType.AnalogOutput: return "AO";
                case SignalType.GroupInput: return "GI";
                case SignalType.GroupOutput: return "GO";
                default: return t.ToString();
            }
        }

        static T Try<T>(Func<T> read, List<string> errors, string what)
        {
            try { return read(); }
            catch (Exception ex) { errors.Add(what + ": " + Errors.Clean(ex)); return default(T); }
        }

        // Every property is read on its own: on a RobotWare 6 controller a group signal's
        // GroupValue/GroupMinValue/GroupMaxValue can throw C004A405 (measured), and one such
        // signal must not take the whole list down.
        static object SignalJson(Signal s)
        {
            var errors = new List<string>();
            var group = s as GroupSignal;
            bool? simulated = null;
            string quality = null;
            try { var st = s.State; simulated = st.Simulated; quality = st.Quality.ToString(); } catch { }
            double? value = group != null
                ? Try(() => (double?)group.GroupValue, errors, "value") ?? Try(() => (double?)s.Value, errors, "value")
                : Try(() => (double?)s.Value, errors, "value");
            double? min = group != null ? Try(() => (double?)group.GroupMinValue, errors, "min") : Try(() => (double?)s.MinValue, errors, "min");
            double? max = group != null ? Try(() => (double?)group.GroupMaxValue, errors, "max") : Try(() => (double?)s.MaxValue, errors, "max");
            return new
            {
                name = s.Name,
                device = Try(() => s.Unit, errors, "device"),
                type = ShortType(s.Type),
                value,
                min,
                max,
                simulated,
                quality,
                error = errors.Count > 0 ? string.Join("; ", errors) : null,
            };
        }

        static Signal FindSignal(Controller c, string spec)
        {
            // Accept a bare name or a Network/Device/Signal path; names are unique per controller.
            var parts = spec.Split('/');
            var name = parts[parts.Length - 1].Trim();
            if (name.Length == 0) throw ApiException.BadRequest("`signal` is empty.");
            Signal s = null;
            try { s = c.IOSystem.GetSignal(name); } catch { }
            if (s == null)
            {
                var near = c.IOSystem.GetSignals(IOFilterTypes.All).Cast<Signal>()
                    .Where(x => x.Name.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0)
                    .Take(10).Select(x => x.Name).ToList();
                throw ApiException.NotFound($"Signal '{name}' not found." + (near.Count > 0 ? " Similar: " + string.Join(", ", near) + "." : ""));
            }
            if (parts.Length >= 2)
            {
                var device = parts[parts.Length - 2].Trim();
                if (!string.IsNullOrEmpty(s.Unit) && !device.Equals(s.Unit, StringComparison.OrdinalIgnoreCase))
                    throw ApiException.NotFound($"Signal '{name}' exists but on device '{s.Unit}', not '{device}'.");
            }
            return s;
        }

        public static object Signals(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var filter = r.Str("filter");
            var type = r.Choice("type", null, "DI", "DO", "AI", "AO", "GI", "GO");
            var limit = r.Int("limit", 500, 1, 10000);
            return Targets.With(t, r, c =>
            {
                var all = c.IOSystem.GetSignals(IOFilterTypes.All).Cast<Signal>().ToList();
                var matched = all.Where(s =>
                        (filter == null || s.Name.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0
                                        || (s.Unit ?? "").IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0)
                        && (type == null || ShortType(s.Type) == type))
                    .ToList();
                return new
                {
                    controller = t.Name,
                    total = all.Count,
                    matched = matched.Count,
                    truncated = matched.Count > limit,
                    signals = matched.Take(limit).Select(SignalJson).ToList(),
                };
            });
        }

        public static object ReadSignal(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var name = r.Str("signal", true);
            return Targets.With(t, r, c => SignalJson(FindSignal(c, name)));
        }

        public static object WriteSignal(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var name = r.Str("signal", true);
            var value = r.Number("value", double.MinValue, double.MaxValue, true).Value;
            return Targets.With(t, r, c =>
            {
                var s = FindSignal(c, name);
                var before = SignalJson(s);
                try
                {
                    switch (s)
                    {
                        case DigitalSignal d:
                            if (value != 0 && value != 1)
                                throw ApiException.BadRequest($"{s.Name} is digital; the value must be 0 or 1, not {value}.");
                            if (value == 1) d.Set(); else d.Reset();
                            break;
                        case GroupSignal g:
                            if (value != Math.Floor(value) || value < g.GroupMinValue || value > g.GroupMaxValue)
                                throw ApiException.BadRequest($"{s.Name} is a group signal; the value must be a whole number in {g.GroupMinValue}..{g.GroupMaxValue}, not {value}.");
                            g.GroupValue = (uint)value;
                            break;
                        default:
                            if (value < s.MinValue || value > s.MaxValue)
                                throw ApiException.BadRequest($"{s.Name} accepts {s.MinValue}..{s.MaxValue}, not {value}.");
                            s.Value = (float)value;
                            break;
                    }
                }
                catch (ApiException) { throw; }
                catch (Exception ex)
                {
                    throw ApiException.Failed($"The controller refused the write to {s.Name}: {Errors.Clean(ex)} " +
                        "(inputs are normally read-only unless simulated, and the signal's Access Level must allow this client).");
                }
                Thread.Sleep(50);
                return new { controller = t.Name, before, after = SignalJson(FindSignal(c, s.Name)) };
            });
        }

        // -------------------------------------------------------------- configuration

        static ABB.Robotics.Controllers.ConfigurationDomain.Domain GetDomain(Controller c, string name)
        {
            var domains = c.Configuration.Domains.Cast<ABB.Robotics.Controllers.ConfigurationDomain.Domain>().ToList();
            return domains.FirstOrDefault(d => d.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
                ?? throw ApiException.NotFound($"Configuration domain '{name}' not found. Domains: {string.Join(", ", domains.Select(d => d.Name))}.");
        }

        public static object ReadConfig(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var domainName = r.Str("domain", true).Trim();
            if (domainName.EndsWith(".cfg", StringComparison.OrdinalIgnoreCase))
                domainName = domainName.Substring(0, domainName.Length - 4);
            return Targets.With(t, r, c =>
            {
                var domain = GetDomain(c, domainName);
                using (var tmp = new CtrlTemp(c))
                using (var local = new LocalTemp())
                {
                    var file = domain.Name + ".cfg";
                    try { domain.Save(tmp.CtrlPath(file)); }
                    catch (Exception ex) { throw ApiException.Failed($"Saving domain {domain.Name} failed: {Errors.Clean(ex)} (it needs the UAS_BACKUP grant)."); }
                    var lp = local.File(file);
                    c.FileSystem.GetFile(tmp.RelPath(file), lp, true);
                    var text = TextFiles.Read(lp, c.IsRobotWare7);
                    return new { controller = t.Name, domain = domain.Name, length = text.Length, content = text };
                }
            });
        }

        static string[] CfgPath(Req r) => new[]
        {
            r.Str("domain", true).Trim(), r.Str("type", true).Trim(), r.Str("instance", true).Trim(), r.Str("attribute", true).Trim(),
        };

        public static object ReadConfigValue(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var path = CfgPath(r);
            return Targets.With(t, r, c =>
            {
                GetDomain(c, path[0]);
                try { return new { controller = t.Name, path = string.Join("/", path), value = c.Configuration.Read(path) }; }
                catch (Exception ex) { throw ApiException.NotFound($"Could not read {string.Join("/", path)}: {Errors.Clean(ex)}"); }
            });
        }

        public static object WriteConfigValue(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var path = CfgPath(r);
            var value = r.Str("value", true);
            return Targets.With(t, r, c =>
            {
                GetDomain(c, path[0]);
                string previous;
                try { previous = c.Configuration.Read(path); }
                catch (Exception ex) { throw ApiException.NotFound($"Could not read {string.Join("/", path)}: {Errors.Clean(ex)}"); }
                using (Targets.Master(c.Configuration, "configuration"))
                {
                    try { c.Configuration.Write(value, path); }
                    catch (Exception ex) { throw ApiException.Failed($"The controller refused the write to {string.Join("/", path)}: {Errors.Clean(ex)}"); }
                }
                return new
                {
                    controller = t.Name,
                    path = string.Join("/", path),
                    previous,
                    value = c.Configuration.Read(path),
                    restartRequired = true,
                    note = "Most configuration changes take effect only after a warm restart (rs_restart_controller).",
                };
            });
        }

        public static object LoadConfig(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var content = r.Str("content", true);
            var mode = r.Choice("mode", "replace", "add", "replace", "reset_and_add");
            var m = Regex.Match(content, @"^\s*([A-Za-z]+):CFG_", RegexOptions.None);
            if (!m.Success)
                throw ApiException.BadRequest("`content` must be a configuration file: its first line reads e.g. 'MOC:CFG_1.0:6:0::'.");
            var domainName = m.Groups[1].Value;
            return Targets.With(t, r, c =>
            {
                var domain = GetDomain(c, domainName);
                bool rw7 = c.IsRobotWare7;
                if (!rw7) RejectNonAscii(content);
                using (var tmp = new CtrlTemp(c))
                using (var local = new LocalTemp())
                {
                    var file = domain.Name + ".cfg";
                    var lp = local.File(file);
                    TextFiles.Write(lp, content, rw7);
                    c.FileSystem.PutFile(lp, tmp.RelPath(file), true);
                    var loadMode = mode == "add" ? CfgLoadMode.Add : mode == "replace" ? CfgLoadMode.Replace : CfgLoadMode.ResetAndAdd;
                    using (Targets.Master(c.Configuration, "configuration"))
                    {
                        // RobotWare 6 takes the controller path. The RobotWare 7 PC SDK first checks
                        // that the file exists, accepts only the file system's own remote path
                        // for that, and rejects every controller-path form ("(HOME$)/", "HOME:/",
                        // "$HOME/") as "does not exist" (all measured on RW 7.21).
                        try { c.Configuration.Load(tmp.CtrlPath(file), loadMode); }
                        catch (ArgumentException) when (rw7)
                        {
                            try { c.Configuration.Load(c.FileSystem.RemoteDirectory.TrimEnd('/') + "/" + tmp.RelPath(file), loadMode); }
                            catch (Exception ex) { throw ApiException.Failed($"The controller refused the {domain.Name} parameters: {Errors.Clean(ex)}"); }
                        }
                        catch (Exception ex) { throw ApiException.Failed($"The controller refused the {domain.Name} parameters: {Errors.Clean(ex)}"); }
                    }
                    return new
                    {
                        controller = t.Name,
                        domain = domain.Name,
                        mode,
                        loaded = true,
                        restartRequired = true,
                        note = "Loaded into the configuration database. Most parameters take effect only after a warm restart (rs_restart_controller).",
                    };
                }
            });
        }

        // -------------------------------------------------------------- event log

        public static object EventLog(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var category = r.Int("category", 0, 0, 100);
            var count = r.Int("count", 20, 1, 1000);
            var sinceSeq = r.Number("since_seq", 0, int.MaxValue);
            return Targets.With(t, r, c =>
            {
                EventLogCategory cat = null;
                string why = null;
                try { cat = c.EventLog.GetCategory(category); } // returns null for an unknown id (measured)
                catch (Exception ex) { why = Errors.Clean(ex) + " "; }
                if (cat == null)
                    throw ApiException.NotFound($"Event log category {category} not found. {why}Categories: " +
                        string.Join(", ", c.EventLog.GetCategories().Select(x => $"{x.Id}={x.Name}")) + ".");
                var ms = cat.Messages;
                var list = new List<object>();
                for (int i = 0; i < ms.Count && list.Count < count; i++)
                {
                    var m = ms[i];
                    if (sinceSeq != null && m.SequenceNumber <= sinceSeq.Value) break;
                    list.Add(new
                    {
                        seq = m.SequenceNumber,
                        code = m.Number,
                        type = m.Type.ToString(),
                        timestamp = Iso(m.Timestamp),
                        title = m.Title,
                        description = m.Body,
                    });
                }
                return new { controller = t.Name, category = cat.Id, categoryName = cat.Name, total = ms.Count, messages = list };
            });
        }

        static string Iso(DateTime d) => d.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture);

        // -------------------------------------------------------------- virtual panel (VC only)
        //
        // A latched guard stop (typically 50027 from the controller's velocity projection)
        // cannot be cleared by turning motors on: RWS ctrl-state=motoron and the MotorOn
        // system input are both refused with SYS_CTRL_E_REJECT. The reset event it needs is a
        // pendant e-stop press + release. On a VIRTUAL controller that is reachable through
        // RobApi's simulated panel (RobControllerConnection.VcPanel), measured to work on
        // RobotWare 6.16 (which has a panel board) and 7.21 (which reports none).
        // Do NOT switch to the PC SDK's public VirtualPanel: on a VC with a panel board its
        // BeginChangeState is silently inert, and on the RW 7.21 VC it throws C0048416.
        // VcPanel is internal, hence the reflection. A real controller's e-stop cannot and
        // must not be operated from software, so these refuse anything but a VC.

        const System.Reflection.BindingFlags Any = System.Reflection.BindingFlags.Public
                                                   | System.Reflection.BindingFlags.NonPublic
                                                   | System.Reflection.BindingFlags.Instance;

        static object GetVcPanel(Controller c)
        {
            if (!c.IsVirtual)
                throw ApiException.Conflict("This controller is not virtual. The virtual panel exists only on virtual controllers; " +
                                            "a real controller's emergency stop cannot and must not be operated from software.");
            var ciField = typeof(Controller).GetField("_controller", Any)
                ?? throw ApiException.Failed("PC SDK layout changed: Controller._controller not found.");
            var ci = ciField.GetValue(c) ?? throw ApiException.Failed("PC SDK: Controller._controller is null.");
            var conn = ci.GetType().GetProperty("Connection", Any)?.GetValue(ci)
                ?? throw ApiException.Failed("PC SDK layout changed: ControllerInternal.Connection not found.");
            return conn.GetType().GetProperty("VcPanel", Any)?.GetValue(conn)
                ?? throw ApiException.Failed("This virtual controller exposes no VcPanel.");
        }

        // Invoke a VcPanel method (they all return Task / Task<T>) and wait for it on THIS
        // thread -- never the UI thread (see Ui.cs).
        static object PanelCall(object panel, string method, params object[] args)
        {
            var mi = panel.GetType().GetMethod(method, args.Select(a => a.GetType()).ToArray())
                ?? throw ApiException.Failed($"VcPanel.{method} not found (RobApi layout changed).");
            var task = mi.Invoke(panel, args) as SysTask;
            if (task == null) return null;
            try
            {
                if (!task.Wait(20000))
                    throw new ApiException(504, "panel_timeout", $"VcPanel.{method} did not complete within 20 s.");
            }
            catch (AggregateException ex)
            {
                throw ApiException.Failed($"VcPanel.{method} failed: {Errors.Clean(ex)}");
            }
            var type = task.GetType();
            return type.IsGenericType ? type.GetProperty("Result")?.GetValue(task) : null;
        }

        // On a RobotWare 6 VC, CREATING a VcPanel writes the panel board's inputs back to their
        // released state, so it releases a pressed e-stop (measured: a second connection's
        // panel read EmergencyStopReset; closing the pressing connection released nothing).
        // Read the controller state before touching the panel, and say so in the result.
        // Measured on RobotWare 6.16: Controller.Connect itself (before any logon) resets a
        // panel-board VC's virtual panel, so ANY new PC SDK connection releases a pressed virtual
        // e-stop (the controller goes to EmergencyStopReset; motors stay off). RobotWare 7.21
        // keeps the press across connections.
        static string PanelNote(Controller c) => c.IsRobotWare7 ? null :
            "RobotWare 6 virtual controllers reset their virtual panel whenever a PC SDK client connects: a pressed virtual e-stop " +
            "(from this tool or RobotStudio's control panel) is released by the next rs_* call to this controller, leaving it in " +
            "EmergencyStopReset with the motors off.";

        public static object Estop(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var state = r.Choice("state", null, "press", "release") ?? throw ApiException.BadRequest("Missing required parameter 'state' (press or release).");
            return Targets.With(t, r, c =>
            {
                var before = c.State;
                var panel = GetVcPanel(c);
                var trace = new List<string>();
                PanelCall(panel, "SetEmergencyStop", state == "press");
                var after = state == "press"
                    ? WaitState(c, s => s == ControllerState.EmergencyStop, 5000, trace)
                    : WaitState(c, s => s != ControllerState.EmergencyStop && s != ControllerState.GuardStop, 5000, trace);
                return new
                {
                    controller = t.Name,
                    action = state,
                    before = before.ToString(),
                    controllerState = after.ToString(),
                    estopPressed = PanelCall(panel, "GetEmergencyStop"),
                    transitions = trace,
                    note = PanelNote(c),
                };
            });
        }

        public static object ClearGuardStop(Req r)
        {
            var t = Targets.Resolve(r.Str("controller"));
            var motorsOn = r.Bool("motors_on", true);
            var force = r.Bool("force", false);
            return Targets.With(t, r, c =>
            {
                if (!c.IsVirtual) GetVcPanel(c); // refuses a real controller before anything else
                var before = c.State;
                var stopped = before == ControllerState.GuardStop || before == ControllerState.EmergencyStop
                              || before == ControllerState.EmergencyStopReset;
                if (!stopped && !force)
                    throw ApiException.Conflict($"Controller '{t.Name}' is in {before}, not stopped; there is nothing to clear. " +
                                                "Pass force=true to pulse the e-stop anyway (that WILL stop a running program).");
                var panel = GetVcPanel(c);
                var steps = new List<object>();

                // Press only if not already pressed: pressing an already-open e-stop circuit
                // raises 90202 "Emergency Stop open", an error we would have made ourselves.
                if (Equals(PanelCall(panel, "GetEmergencyStop"), true))
                    steps.Add(new { step = "press", skipped = "e-stop already pressed" });
                else
                {
                    var trace = new List<string>();
                    PanelCall(panel, "SetEmergencyStop", true);
                    WaitState(c, s => s == ControllerState.EmergencyStop, 5000, trace);
                    steps.Add(new { step = "press", transitions = trace });
                }

                var releaseTrace = new List<string>();
                PanelCall(panel, "SetEmergencyStop", false);
                // RW6 lands in EmergencyStopReset; RW7 passes through GuardStop to MotorsOff.
                var afterRelease = WaitState(c, s => s == ControllerState.EmergencyStopReset || s == ControllerState.MotorsOff
                                                     || s == ControllerState.MotorsOn, 5000, releaseTrace);
                steps.Add(new { step = "release", transitions = releaseTrace });

                if (motorsOn)
                {
                    // Let the safety system settle after the release: on the RW6 VC (SafeMove) a
                    // motors-on ~0.1 s after the release is answered with a guard stop and then
                    // motors off (measured); the original recipe waited ~1 s. One more attempt
                    // covers a slow settle; a real latch still fails and is reported.
                    Thread.Sleep(1000);
                    for (int attempt = 1; attempt <= 2; attempt++)
                    {
                        var trace = new List<string>();
                        PanelCall(panel, "PressMotorsOn");
                        var s = WaitState(c, x => x == ControllerState.MotorsOn, 5000, trace);
                        steps.Add(new { step = attempt == 1 ? "motors_on" : "motors_on (retry)", transitions = trace });
                        if (s == ControllerState.MotorsOn || s == ControllerState.EmergencyStop || s == ControllerState.EmergencyStopReset) break;
                        Thread.Sleep(1000);
                    }
                }
                var after = c.State;
                var ok = motorsOn ? after == ControllerState.MotorsOn
                                  : after == ControllerState.MotorsOff || after == ControllerState.EmergencyStopReset;
                var result = new { controller = t.Name, before = before.ToString(), controllerState = after.ToString(), steps, note = PanelNote(c) };
                if (!ok)
                    throw ApiException.Failed($"The guard stop did not clear: the controller is in {after}" +
                        (afterRelease == ControllerState.EmergencyStop || afterRelease == ControllerState.GuardStop
                            ? " (still stopped after the e-stop release; read the event log for what is holding it)." : "."),
                        result);
                return result;
            });
        }
    }
}

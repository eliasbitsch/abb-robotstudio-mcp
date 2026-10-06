using System;
using System.Collections.Generic;
using System.Linq;
using ABB.Robotics.Math;
using ABB.Robotics.RobotStudio;
using ABB.Robotics.RobotStudio.Stations;
using SysTask = System.Threading.Tasks.Task;

namespace RobotStudioBridge
{
    // Operations on the active RobotStudio station. The Station API is UI-thread-only, so
    // everything here runs inside Ui.Invoke; anything that returns a Task is started on the
    // UI thread and awaited on the request thread (never block the UI thread on it).
    internal static class StationApi
    {
        static Station ActiveStation() =>
            Station.ActiveStation ?? throw ApiException.Conflict("No station is open in RobotStudio.");

        static List<RsIrc5Controller> Controllers(Station s) => s.Irc5Controllers.Cast<RsIrc5Controller>().ToList();

        static bool Is(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

        static bool MatchesController(RsIrc5Controller c, string spec)
        {
            Guid a, b;
            return Is(c.Name, spec.Trim())
                   || (Guid.TryParse(spec.Trim().Trim('{', '}'), out a) && Guid.TryParse(c.SystemId, out b) && a == b);
        }

        // Station tools act on station controllers only; a network controller has no station tasks.
        static List<RsIrc5Controller> SelectControllers(Station s, string spec)
        {
            var all = Controllers(s);
            if (string.IsNullOrWhiteSpace(spec)) return all;
            var match = all.Where(c => MatchesController(c, spec)).ToList();
            if (match.Count == 0)
                throw ApiException.NotFound(all.Count == 0
                    ? "The active station has no controllers."
                    : $"'{spec}' is not a controller in the active station. Station controllers: {string.Join(", ", all.Select(c => c.Name))}.");
            return match;
        }

        static RsIrc5Controller OneController(Station s, string spec)
        {
            var list = SelectControllers(s, spec);
            if (list.Count == 0) throw ApiException.Conflict("The active station has no controllers.");
            if (list.Count > 1)
                throw ApiException.BadRequest($"The station has {list.Count} controllers ({string.Join(", ", list.Select(c => c.Name))}); pass `controller`.");
            return list[0];
        }

        static List<RsTask> AllTasks(RsIrc5Controller c) =>
            c.Tasks.Cast<RsTask>().Concat(c.NonMotionTasks.Cast<RsTask>()).ToList();

        static RsTask OneTask(RsIrc5Controller c, string name)
        {
            var tasks = AllTasks(c);
            if (name == null)
            {
                var motion = tasks.Where(t => t.IsMotionTask).ToList();
                if (motion.Count == 1) return motion[0];
                throw ApiException.BadRequest($"Pass `task`: controller {c.Name} has tasks {string.Join(", ", tasks.Select(t => t.Name))}.");
            }
            return tasks.FirstOrDefault(t => Is(t.Name, name))
                ?? throw ApiException.NotFound($"Task '{name}' not found on {c.Name}. Tasks: {string.Join(", ", tasks.Select(t => t.Name))}.");
        }

        static object SavedStates(Station s)
        {
            var list = new List<object>();
            try
            {
                foreach (SavedState st in s.SavedStates)
                    list.Add(new { name = st.Name, description = st.Description, time = st.Time.ToString("s"), canRestore = st.CanRestore() });
            }
            catch { }
            return list;
        }

        static object Simulation() => new
        {
            state = Simulator.State.ToString(),
            time = Simulator.CurrentTime,
            speed = Simulator.SimulationSpeed,
        };

        static void Await(SysTask task, string what, int timeoutMs = 60000)
        {
            if (task == null) return;
            try
            {
                if (!task.Wait(timeoutMs))
                    throw new ApiException(504, "timeout", $"{what} did not complete within {timeoutMs / 1000} s.");
            }
            catch (AggregateException ex)
            {
                throw ApiException.Failed($"{what} failed: {Errors.Clean(ex)}");
            }
        }

        // -------------------------------------------------------------- station

        public static object GetStation(Req r) => Ui.Invoke(() =>
        {
            var s = ActiveStation();
            return new
            {
                name = s.Name,
                file = s.FileInfo?.FullName,
                controllers = Controllers(s).Select(c => new
                {
                    name = c.Name,
                    systemId = c.SystemId,
                    systemState = c.SystemState.ToString(),
                    systemPath = c.SystemPath,
                }).ToList(),
                savedStates = SavedStates(s),
                collisionSets = s.CollisionSets.Cast<CollisionSet>().Select(cs => new
                {
                    name = cs.Name,
                    active = cs.Active,
                    nearMiss_mm = cs.NearMissDistance * 1000,
                    firstGroup = cs.FirstGroup.Count,
                    secondGroup = cs.SecondGroup.Count,
                }).ToList(),
                simulation = Simulation(),
            };
        });

        public static object Objects(Req r)
        {
            var nameFilter = r.Str("name");
            var typeFilter = r.Str("type");
            var filtered = nameFilter != null || typeFilter != null;
            var maxDepth = r.Int("max_depth", filtered ? 12 : 2, 0, 50);
            var limit = r.Int("limit", 300, 1, 5000);
            return Ui.Invoke(() =>
            {
                var s = ActiveStation();
                var list = new List<object>();
                int total = 0;
                void Walk(ProjectObject parent, string prefix, int depth)
                {
                    foreach (ProjectObject child in parent.Children)
                    {
                        var path = prefix.Length == 0 ? child.Name : prefix + "/" + child.Name;
                        var type = child.GetType().Name;
                        if ((nameFilter == null || (child.Name ?? "").IndexOf(nameFilter, StringComparison.OrdinalIgnoreCase) >= 0)
                            && (typeFilter == null || type.IndexOf(typeFilter, StringComparison.OrdinalIgnoreCase) >= 0))
                        {
                            total++;
                            if (list.Count < limit) list.Add(new { path, name = child.Name, type, depth });
                        }
                        if (depth < maxDepth) Walk(child, path, depth + 1);
                    }
                }
                Walk(s, "", 0);
                return new { total, returned = list.Count, truncated = total > list.Count, maxDepth, objects = list };
            });
        }

        public static object Save(Req r) => Ui.Invoke(() =>
        {
            var s = ActiveStation();
            s.Save();
            return new { saved = true, station = s.Name, file = s.FileInfo?.FullName };
        });

        // -------------------------------------------------------------- simulation

        public static object SimulationStatus(Req r) => Ui.Invoke(() =>
        {
            var s = Station.ActiveStation;
            return new
            {
                simulation = Simulation(),
                savedStates = s == null ? null : SavedStates(s),
            };
        });

        public static object SimulationStart(Req r)
        {
            Await(Ui.Invoke<SysTask>(() => { ActiveStation(); return Simulator.StartAsync(); }), "Starting the simulation");
            return Ui.Invoke(Simulation);
        }

        public static object SimulationStop(Req r)
        {
            Await(Ui.Invoke<SysTask>(() => Simulator.StopAsync()), "Stopping the simulation");
            return Ui.Invoke(Simulation);
        }

        public static object SimulationPause(Req r)
        {
            var state = Ui.Invoke(() => Simulator.State);
            if (state != SimulationState.Running)
                throw ApiException.Conflict($"The simulation is {state}, not running; there is nothing to pause.");
            Await(Ui.Invoke<SysTask>(() => Simulator.PauseAsync()), "Pausing the simulation");
            return Ui.Invoke(Simulation);
        }

        public static object SimulationSpeed(Req r)
        {
            var speed = r.Number("speed", 0.01, 100, true).Value;
            return Ui.Invoke(() =>
            {
                Simulator.SimulationSpeed = speed;
                return Simulation();
            });
        }

        // RobotStudio's Reset restores a saved station state; that is what this does too.
        public static object SimulationReset(Req r)
        {
            var wanted = r.Str("state");
            var chosen = Ui.Invoke(() =>
            {
                var s = ActiveStation();
                var states = s.SavedStates.Cast<SavedState>().ToList();
                if (states.Count == 0)
                    throw ApiException.Conflict("The station has no saved states to reset to. Save one in RobotStudio " +
                                                "(Simulation > Reset > Save Current State) first; nothing was changed.");
                SavedState st;
                if (wanted == null)
                {
                    if (states.Count > 1)
                        throw ApiException.BadRequest($"The station has {states.Count} saved states ({string.Join(", ", states.Select(x => x.Name))}); pass `state`.");
                    st = states[0];
                }
                else
                {
                    st = states.FirstOrDefault(x => Is(x.Name, wanted))
                         ?? throw ApiException.NotFound($"Saved state '{wanted}' not found. Saved states: {string.Join(", ", states.Select(x => x.Name))}.");
                }
                if (!st.CanRestore())
                    throw ApiException.Conflict($"Saved state '{st.Name}' cannot be restored right now (RobotStudio says CanRestore is false).");
                return st.Name;
            });
            if (Ui.Invoke(() => Simulator.State) != SimulationState.Stopped)
                Await(Ui.Invoke<SysTask>(() => Simulator.StopAsync()), "Stopping the simulation");
            Await(Ui.Invoke<SysTask>(() => ActiveStation().SavedStates[chosen].RestoreAsync()), $"Restoring saved state '{chosen}'", 120000);
            return Ui.Invoke(() => new { restored = chosen, simulation = Simulation() });
        }

        // -------------------------------------------------------------- paths & targets

        public static object Paths(Req r)
        {
            var spec = r.Str("controller");
            var taskName = r.Identifier("task", false);
            return Ui.Invoke(() =>
            {
                var s = ActiveStation();
                var list = new List<object>();
                foreach (var c in SelectControllers(s, spec))
                    foreach (var t in AllTasks(c))
                    {
                        if (taskName != null && !Is(t.Name, taskName)) continue;
                        foreach (RsPathProcedure p in t.PathProcedures)
                            list.Add(new { controller = c.Name, task = t.Name, module = p.ModuleName, name = p.Name, instructions = p.Instructions.Count });
                    }
                return list;
            });
        }

        static double Mm(double metres) => Math.Round(metres * 1000.0, 4);
        static double R6(double v) => Math.Round(v, 6);

        static object RobTargetJson(RsRobTarget rt)
        {
            var q = rt.Frame.Matrix.Quaternion;
            return new
            {
                name = rt.Name,
                module = rt.ModuleName,
                frame = "work object",
                x_mm = Mm(rt.Frame.X), y_mm = Mm(rt.Frame.Y), z_mm = Mm(rt.Frame.Z),
                q1 = R6(q.q1), q2 = R6(q.q2), q3 = R6(q.q3), q4 = R6(q.q4),
            };
        }

        static object InstructionJson(RsInstruction ins, int index)
        {
            var move = ins as RsMoveInstruction;
            object toTarget = null, toJointTarget = null;
            if (move != null)
            {
                try { var rt = move.GetToRobTarget(); if (rt != null) toTarget = RobTargetJson(rt); } catch { }
                try { var jt = move.GetToJointTarget(); if (jt != null) toJointTarget = new { name = jt.Name, module = jt.ModuleName }; } catch { }
            }
            var args = new List<object>();
            try
            {
                foreach (RsInstructionArgument a in ins.InstructionArguments)
                    if (a.Enabled) args.Add(new { name = a.Name, value = a.Value });
            }
            catch { }
            return new { index, instruction = ins.Name, text = ins.DisplayName, toTarget, toJointTarget, arguments = args };
        }

        public static object PathTargets(Req r)
        {
            var spec = r.Str("controller");
            var taskName = r.Identifier("task", false);
            var module = r.Identifier("module", false);
            var name = r.Identifier("path", true);
            return Ui.Invoke(() =>
            {
                var s = ActiveStation();
                var c = OneController(s, spec);
                var hits = AllTasks(c)
                    .Where(t => taskName == null || Is(t.Name, taskName))
                    .SelectMany(t => t.PathProcedures.Cast<RsPathProcedure>()
                        .Where(p => Is(p.Name, name) && (module == null || Is(p.ModuleName, module)))
                        .Select(p => new { task = t, path = p }))
                    .ToList();
                if (hits.Count == 0)
                    throw ApiException.NotFound($"Path '{name}' not found on {c.Name}" + (taskName != null ? $" task {taskName}" : "") + ".");
                if (hits.Count > 1)
                    throw ApiException.Conflict($"'{name}' matches {hits.Count} paths ({string.Join(", ", hits.Select(h => $"{h.task.Name}/{h.path.ModuleName}/{h.path.Name}"))}); pass `task` and/or `module`.");
                var hit = hits[0];
                var list = new List<object>();
                int i = 0;
                foreach (RsInstruction ins in hit.path.Instructions) list.Add(InstructionJson(ins, ++i));
                return new { controller = c.Name, task = hit.task.Name, module = hit.path.ModuleName, path = hit.path.Name, instructions = list };
            });
        }

        public static object CreatePath(Req r)
        {
            var spec = r.Str("controller");
            var taskName = r.Identifier("task", false);
            var name = r.Identifier("name", true);
            var module = r.Identifier("module", false);
            return Ui.Invoke(() =>
            {
                var c = OneController(ActiveStation(), spec);
                var t = OneTask(c, taskName);
                if (t.PathProcedures.Cast<RsPathProcedure>().Any(p => Is(p.Name, name)))
                    throw ApiException.Conflict($"Task {t.Name} already has a path named {name}.");
                var p = new RsPathProcedure(name);
                if (module != null) p.ModuleName = module;
                t.PathProcedures.Add(p);
                return new
                {
                    controller = c.Name, task = t.Name, name = p.Name, module = p.ModuleName, created = true,
                    note = "Created in the station only. Synchronize to RAPID in RobotStudio to load it into the controller.",
                };
            });
        }

        public static object CreateTarget(Req r)
        {
            var spec = r.Str("controller");
            var taskName = r.Identifier("task", false);
            var name = r.Identifier("name", true);
            var module = r.Identifier("module", false);
            var wobjName = r.Identifier("workobject", false);
            const double reach = 100000; // mm
            var x = r.Number("x", -reach, reach, true).Value;
            var y = r.Number("y", -reach, reach, true).Value;
            var z = r.Number("z", -reach, reach, true).Value;
            var q = new[] { r.Number("q1", -1e6, 1e6), r.Number("q2", -1e6, 1e6), r.Number("q3", -1e6, 1e6), r.Number("q4", -1e6, 1e6) };
            var e = new[] { r.Number("rx", -360, 360), r.Number("ry", -360, 360), r.Number("rz", -360, 360) };
            bool anyQ = q.Any(v => v != null), anyE = e.Any(v => v != null);
            if (anyQ && q.Any(v => v == null)) throw ApiException.BadRequest("Give all four of q1..q4, or none.");
            if (anyE && e.Any(v => v == null)) throw ApiException.BadRequest("Give all three of rx, ry, rz, or none.");
            if (anyQ && anyE) throw ApiException.BadRequest("Give the orientation as q1..q4 OR as rx, ry, rz, not both.");

            Quaternion rot = Quaternion.Identity;
            if (anyQ)
            {
                var n = Math.Sqrt(q.Sum(v => v.Value * v.Value));
                if (n < 1e-9) throw ApiException.BadRequest("q1..q4 is a zero quaternion.");
                rot = new Quaternion(q[0].Value / n, q[1].Value / n, q[2].Value / n, q[3].Value / n);
            }
            else if (anyE)
            {
                var d2r = Math.PI / 180.0;
                rot = new Quaternion(new Vector3(e[0].Value * d2r, e[1].Value * d2r, e[2].Value * d2r));
            }

            return Ui.Invoke(() =>
            {
                var c = OneController(ActiveStation(), spec);
                var t = OneTask(c, taskName);
                if (!t.IsMotionTask) throw ApiException.BadRequest($"Task {t.Name} is not a motion task.");
                if (t.DataDeclarations.Cast<RsDataDeclaration>().Any(d => Is(d.Name, name)))
                    throw ApiException.Conflict($"Task {t.Name} already has data named {name}.");
                RsWorkObject wobj;
                if (wobjName == null)
                {
                    wobj = t.ActiveWorkObject ?? throw ApiException.Conflict($"Task {t.Name} has no active work object; pass `workobject`.");
                }
                else
                {
                    var wobjs = t.DataDeclarations.Cast<RsDataDeclaration>().OfType<RsWorkObject>().ToList();
                    wobj = wobjs.FirstOrDefault(w => Is(w.Name, wobjName))
                           ?? throw ApiException.NotFound($"Work object '{wobjName}' not found in {t.Name}. Work objects: {string.Join(", ", wobjs.Select(w => w.Name))}.");
                }

                var rt = new RsRobTarget { Name = name };
                if (module != null) rt.ModuleName = module;
                t.DataDeclarations.Add(rt);
                rt.Frame.Matrix = new Matrix4(new Vector3(x / 1000.0, y / 1000.0, z / 1000.0), rot);
                var target = new RsTarget(wobj, rt) { Name = name };
                t.Targets.Add(target);
                return new
                {
                    controller = c.Name, task = t.Name, workobject = wobj.Name, created = true,
                    target = RobTargetJson(rt),
                    note = "Created in the station only. Synchronize to RAPID in RobotStudio to load it into the controller.",
                };
            });
        }

        public static object DeletePath(Req r)
        {
            var spec = r.Str("controller");
            var taskName = r.Identifier("task", false);
            var module = r.Identifier("module", false);
            var name = r.Identifier("name", true);
            return Ui.Invoke(() =>
            {
                var c = OneController(ActiveStation(), spec);
                var hits = AllTasks(c)
                    .Where(t => taskName == null || Is(t.Name, taskName))
                    .SelectMany(t => t.PathProcedures.Cast<RsPathProcedure>()
                        .Where(p => Is(p.Name, name) && (module == null || Is(p.ModuleName, module)))
                        .Select(p => new { task = t, path = p }))
                    .ToList();
                if (hits.Count == 0) throw ApiException.NotFound($"Path '{name}' not found on {c.Name}.");
                if (hits.Count > 1)
                    throw ApiException.Conflict($"'{name}' matches {hits.Count} paths ({string.Join(", ", hits.Select(h => $"{h.task.Name}/{h.path.ModuleName}/{h.path.Name}"))}); pass `task` and/or `module`.");
                hits[0].task.PathProcedures.Remove(hits[0].path);
                return new
                {
                    controller = c.Name, task = hits[0].task.Name, name, deleted = true,
                    note = "Deleted from the station. If it was synchronized to RAPID, the controller keeps it until the next synchronization.",
                };
            });
        }

        public static object DeleteTarget(Req r)
        {
            var spec = r.Str("controller");
            var taskName = r.Identifier("task", false);
            var name = r.Identifier("name", true);
            return Ui.Invoke(() =>
            {
                var c = OneController(ActiveStation(), spec);
                var t = OneTask(c, taskName);
                var rt = t.DataDeclarations.Cast<RsDataDeclaration>().OfType<RsRobTarget>().FirstOrDefault(d => Is(d.Name, name))
                         ?? throw ApiException.NotFound($"No robot target named '{name}' in {t.Name}.");
                var users = t.PathProcedures.Cast<RsPathProcedure>()
                    .Where(p => p.Instructions.Cast<RsInstruction>().OfType<RsMoveInstruction>().Any(m =>
                    {
                        try { return m.GetAllRobTargets().Contains(rt); } catch { return false; }
                    }))
                    .Select(p => p.Name).ToList();
                if (users.Count > 0)
                    throw ApiException.Conflict($"Target {rt.Name} is used by path(s) {string.Join(", ", users)}; delete or change those instructions first.");
                var targets = t.Targets.Cast<RsTarget>().Where(x => ReferenceEquals(x.RobTarget, rt)).ToList();
                foreach (var x in targets) t.Targets.Remove(x);
                t.DataDeclarations.Remove(rt);
                return new { controller = c.Name, task = t.Name, name = rt.Name, deleted = true, graphicalTargetsRemoved = targets.Count };
            });
        }

        // -------------------------------------------------------------- collisions

        static GraphicComponent FindComponent(Station s, string spec)
        {
            var hits = new List<(GraphicComponent comp, string path)>();
            void Walk(ProjectObject parent, string prefix, int depth)
            {
                foreach (ProjectObject child in parent.Children)
                {
                    var path = prefix.Length == 0 ? child.Name : prefix + "/" + child.Name;
                    if (child is GraphicComponent gc && (Is(child.Name, spec) || Is(path, spec))) hits.Add((gc, path));
                    if (depth < 12) Walk(child, path, depth + 1);
                }
            }
            Walk(s, "", 0);
            if (hits.Count == 0) throw ApiException.NotFound($"No station object named '{spec}' (use rs_get_station_objects to list them).");
            if (hits.Count > 1)
                throw ApiException.Conflict($"'{spec}' matches {hits.Count} objects ({string.Join(", ", hits.Take(10).Select(h => h.path))}); pass the full path.");
            return hits[0].comp;
        }

        static object Check(GraphicComponent a, GraphicComponent b, double nearMiss)
        {
            Part pa, pb;
            var type = CollisionDetector.CheckCollision(a, b, nearMiss, out pa, out pb);
            return type == CollisionType.None ? null : new
            {
                a = a.Name, b = b.Name, result = type.ToString(),
                partA = pa?.Name, partB = pb?.Name,
            };
        }

        public static object CheckCollisions(Req r)
        {
            var setName = r.Str("set");
            var objects = r.StrList("objects");
            var nearMissMm = r.Number("near_miss_mm", 0, 10000);
            return Ui.Invoke<object>(() =>
            {
                var s = ActiveStation();
                if (objects != null)
                {
                    if (objects.Count < 2) throw ApiException.BadRequest("`objects` needs at least two station object names.");
                    var comps = objects.Select(o => FindComponent(s, o)).ToList();
                    var nm = (nearMissMm ?? 0) / 1000.0;
                    var found = new List<object>();
                    int pairs = 0;
                    for (int i = 0; i < comps.Count; i++)
                        for (int j = i + 1; j < comps.Count; j++)
                        {
                            pairs++;
                            var hit = Check(comps[i], comps[j], nm);
                            if (hit != null) found.Add(hit);
                        }
                    return new { mode = "objects", pairsChecked = pairs, nearMiss_mm = nm * 1000, clear = found.Count == 0, results = found };
                }

                var sets = s.CollisionSets.Cast<CollisionSet>().ToList();
                if (setName != null)
                {
                    var match = sets.Where(cs => Is(cs.Name, setName)).ToList();
                    if (match.Count == 0)
                        throw ApiException.NotFound($"Collision set '{setName}' not found. Sets: {(sets.Count == 0 ? "(none)" : string.Join(", ", sets.Select(cs => cs.Name)))}.");
                    sets = match;
                }
                if (sets.Count == 0)
                    throw ApiException.Conflict("The station has no collision sets. Create one in RobotStudio, or pass `objects` to check specific objects against each other.");
                var results = new List<object>();
                foreach (var cs in sets)
                {
                    var nm = nearMissMm != null ? nearMissMm.Value / 1000.0 : cs.NearMissDistance;
                    var found = new List<object>();
                    int pairs = 0;
                    foreach (GraphicComponent a in cs.FirstGroup)
                        foreach (GraphicComponent b in cs.SecondGroup)
                        {
                            if (ReferenceEquals(a, b)) continue;
                            if (++pairs > 20000) throw ApiException.BadRequest($"Collision set {cs.Name} has too many object pairs to check here.");
                            var hit = Check(a, b, nm);
                            if (hit != null) found.Add(hit);
                        }
                    results.Add(new { set = cs.Name, active = cs.Active, nearMiss_mm = nm * 1000, pairsChecked = pairs, clear = found.Count == 0, results = found });
                }
                return new { mode = "collision sets", sets = results };
            });
        }
    }
}

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Text;
using ABB.Robotics.Controllers;
using ABB.Robotics.Controllers.Discovery;
using ABB.Robotics.RobotStudio.Stations;

namespace RobotStudioBridge
{
    // A controller in the active RobotStudio station, captured on the UI thread so the
    // PC SDK work that follows can run off it.
    internal sealed class StationController
    {
        public string Name;
        public Guid SystemId;
        public string SystemPath;
        public string SystemState;
    }

    // The controller a request is aimed at: a station controller, or any controller the
    // PC SDK can discover on the network (real or virtual), chosen by name, system id or IP.
    internal sealed class CtrlTarget
    {
        public string Name;
        public Guid SystemId;
        public bool InStation;
        public ControllerInfo Info;   // set when the target came from network discovery

        public object Describe() => new
        {
            name = Name,
            systemId = SystemId.ToString("D"),
            inStation = InStation,
            ip = Info?.IPAddress?.ToString(),
        };
    }

    internal static class Targets
    {
        public static List<StationController> StationControllers() => Ui.Invoke(() =>
        {
            var list = new List<StationController>();
            var station = Station.ActiveStation;
            if (station == null) return list;
            foreach (RsIrc5Controller c in station.Irc5Controllers)
            {
                Guid id;
                Guid.TryParse(c.SystemId, out id);
                list.Add(new StationController
                {
                    Name = c.Name,
                    SystemId = id,
                    SystemPath = c.SystemPath,
                    SystemState = c.SystemState.ToString(),
                });
            }
            return list;
        });

        static bool SameId(Guid id, string spec)
        {
            Guid g;
            return Guid.TryParse(spec.Trim().Trim('{', '}'), out g) && g == id;
        }

        static string Names(IEnumerable<StationController> list) =>
            string.Join(", ", list.Select(c => c.Name));

        // Resolve the `controller` parameter. Omitted: the station's only controller.
        // Otherwise a station controller by name or system id, then (unless the caller is a
        // station-only tool) a network controller by system name, controller name, system id
        // or IP address. Anything ambiguous is refused with the candidates, never guessed.
        public static CtrlTarget Resolve(string spec, bool stationOnly = false)
        {
            var station = StationControllers();
            if (string.IsNullOrWhiteSpace(spec))
            {
                if (station.Count == 1) return FromStation(station[0]);
                if (station.Count == 0)
                    throw ApiException.BadRequest(stationOnly
                        ? "There is no controller in the active RobotStudio station (or no station is open)."
                        : "There is no controller in the active RobotStudio station (or no station is open). " +
                          "Pass `controller` as a network controller's system name or IP address.");
                throw ApiException.BadRequest(
                    $"The station has {station.Count} controllers ({Names(station)}); pass `controller` to choose one.");
            }

            spec = spec.Trim();
            var matches = station.Where(c => c.Name.Equals(spec, StringComparison.OrdinalIgnoreCase)
                                             || SameId(c.SystemId, spec)).ToList();
            if (matches.Count == 1) return FromStation(matches[0]);
            if (matches.Count > 1)
                throw ApiException.Conflict($"'{spec}' matches more than one station controller ({Names(matches)}); pass its system id.");
            if (stationOnly)
                throw ApiException.NotFound(station.Count == 0
                    ? $"'{spec}' is not a station controller: the active station has none."
                    : $"'{spec}' is not a controller in the active station. Station controllers: {Names(station)}.");
            return FromNetwork(spec);
        }

        static CtrlTarget FromStation(StationController c)
        {
            if (!c.SystemState.Equals("Started", StringComparison.OrdinalIgnoreCase))
                throw ApiException.Conflict(
                    $"Station controller '{c.Name}' is not started (state: {c.SystemState}). Start it in RobotStudio first.");
            return new CtrlTarget { Name = c.Name, SystemId = c.SystemId, InStation = true };
        }

        static CtrlTarget FromNetwork(string spec)
        {
            IPAddress ip;
            bool isIp = IPAddress.TryParse(spec, out ip);
            if (isIp) Discovery.AddRemote(ip);

            List<ControllerInfo> Match(ControllerInfo[] all) => all.Where(i =>
                isIp ? ip.Equals(i.IPAddress)
                     : spec.Equals(i.SystemName, StringComparison.OrdinalIgnoreCase)
                       || spec.Equals(i.ControllerName, StringComparison.OrdinalIgnoreCase)
                       || spec.Equals(i.Name, StringComparison.OrdinalIgnoreCase)
                       || SameId(i.SystemId, spec)).ToList();

            var found = Match(Discovery.Scan(fresh: false));
            if (found.Count == 0) found = Match(Discovery.Scan(fresh: true));
            if (found.Count == 0)
            {
                var seen = Discovery.Scan(fresh: false);
                throw ApiException.NotFound(
                    $"No controller matching '{spec}' in the station or on the network. " +
                    (seen.Length == 0 ? "Network discovery found no controllers."
                                      : "Discovered: " + string.Join("; ", seen.Select(Describe)) + "."));
            }
            if (found.Count > 1)
                throw ApiException.Conflict(
                    $"'{spec}' matches {found.Count} controllers ({string.Join("; ", found.Select(Describe))}); pass the system id.");
            var info = found[0];
            return new CtrlTarget { Name = info.SystemName, SystemId = info.SystemId, InStation = false, Info = info };
        }

        public static string Describe(ControllerInfo i) =>
            $"{i.SystemName} @ {i.IPAddress} ({(i.IsVirtual ? "virtual" : "real")}, id {i.SystemId:D})";

        static UserInfo UserFor(Req req)
        {
            var user = req?.Header("X-ABB-User");
            if (string.IsNullOrEmpty(user)) return UserInfo.DefaultUser;
            return new UserInfo(user, req.Header("X-ABB-Password") ?? "");
        }

        // Connect + log on for the duration of one operation. A fresh connection per request
        // keeps no state between requests (nothing stale after a controller restart) and
        // leaves no idle session holding one of the controller's client slots.
        public static T With<T>(CtrlTarget target, Req req, Func<Controller, T> op)
        {
            Controller c = null;
            try
            {
                try
                {
                    c = target.Info != null
                        ? Controller.Connect(target.Info, ConnectionType.Standalone, false)
                        : Controller.Connect(target.SystemId, ConnectionType.Standalone, false);
                }
                catch (Exception ex)
                {
                    throw new ApiException(502, "connect_failed",
                        $"Could not connect to controller '{target.Name}': {Errors.Clean(ex)}");
                }
                var user = UserFor(req);
                try { c.Logon(user); }
                catch (Exception ex)
                {
                    throw new ApiException(502, "logon_failed",
                        $"Logon to controller '{target.Name}' as '{user.Name}' failed: {Errors.Clean(ex)}");
                }
                return op(c);
            }
            finally
            {
                if (c != null)
                {
                    try { c.Logoff(); } catch { }
                    try { c.Dispose(); } catch { }
                }
            }
        }

        // Mastership over a resource (c.Rapid, c.Configuration, or the whole controller),
        // with a message that says who is likely holding it when it is refused.
        // Per-domain mastership (RAPID only for RAPID writes, configuration only for config
        // writes). The PC SDK marks this overload obsolete in favour of taking every domain at
        // once, but taking motion mastership just to write a RAPID variable would also block the
        // FlexPendant from jogging; the per-domain form is measured to work on RW 6.16 and 7.21.
        public static Mastership Master(IMastershipResource resource, string what)
        {
#pragma warning disable CS0618
            try { return Mastership.Request(resource); }
#pragma warning restore CS0618
            catch (Exception ex)
            {
                throw ApiException.Conflict(
                    $"Could not get {what} mastership: {Errors.Clean(ex)} It may be held by the FlexPendant, " +
                    "RobotStudio (e.g. an open RAPID editor with write access) or another RWS/PC SDK client. " +
                    "In manual mode the FlexPendant must grant write access.");
            }
        }

        public static Mastership MasterController(Controller c, string what)
        {
            try { return Mastership.Request((IMastershipResourceController)c); }
            catch (Exception ex)
            {
                throw ApiException.Conflict(
                    $"Could not get controller mastership for {what}: {Errors.Clean(ex)} Another client " +
                    "(FlexPendant, RobotStudio, RWS/PC SDK) may hold mastership of a domain.");
            }
        }
    }

    // Network discovery of controllers. A scan is a LAN broadcast plus unicast probes of
    // any controller added by IP; results are cached for a short while because a scan
    // takes seconds.
    internal static class Discovery
    {
        static readonly object Lock = new object();
        static ControllerInfo[] _last;
        static DateTime _lastAt = DateTime.MinValue;
        static readonly TimeSpan MaxAge = TimeSpan.FromSeconds(30);

        public static ControllerInfo[] Scan(bool fresh)
        {
            lock (Lock)
            {
                if (!fresh && _last != null && DateTime.UtcNow - _lastAt < MaxAge) return _last;
                var scanner = new NetworkScanner();
                scanner.Scan();
                _last = scanner.GetControllers() ?? new ControllerInfo[0];
                _lastAt = DateTime.UtcNow;
                return _last;
            }
        }

        public static void AddRemote(IPAddress ip)
        {
            NetworkScanner.AddRemoteController(ip);
            lock (Lock) _last = null;
        }
    }

    // A uniquely named directory in the controller's HOME for file round trips. The same
    // directory is addressed two ways: FileSystem calls take a HOME-relative path, while
    // RAPID and configuration calls take a controller path, "(HOME$)/...". Both forms were
    // verified on RobotWare 6.16 and 7.21 controllers.
    internal sealed class CtrlTemp : IDisposable
    {
        readonly Controller _c;
        public readonly string Rel;

        public CtrlTemp(Controller c)
        {
            _c = c;
            Rel = "_mcp_tmp_" + Guid.NewGuid().ToString("N").Substring(0, 12);
            _c.FileSystem.CreateDirectory(Rel);
        }

        public string Sub(string name)
        {
            _c.FileSystem.CreateDirectory(Rel + "/" + name);
            return name;
        }

        public string CtrlPath(string file = null) => "(HOME$)/" + Rel + (file == null ? "" : "/" + file);
        public string RelPath(string file) => Rel + "/" + file;

        public void Dispose()
        {
            try { _c.FileSystem.RemoveDirectory(Rel, true); }
            catch (Exception ex) { Log.Warn($"Could not remove controller temp directory HOME/{Rel}: {Errors.Clean(ex)}"); }
        }
    }

    // A scratch directory on this PC.
    internal sealed class LocalTemp : IDisposable
    {
        public readonly string Dir;

        public LocalTemp()
        {
            Dir = Path.Combine(Path.GetTempPath(), "RobotStudioBridge", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Dir);
        }

        public string File(string name) => Path.Combine(Dir, name);

        public void Dispose()
        {
            try { Directory.Delete(Dir, true); } catch { }
        }
    }

    internal static class Errors
    {
        // RobApi exceptions carry a multi-line dump (the controller's source file, the
        // request history). Keep the part a person can act on: the first line, which holds
        // the controller's code and message.
        public static string Clean(Exception ex)
        {
            while (ex is AggregateException || ex is TargetInvocationException)
            {
                if (ex.InnerException == null) break;
                ex = ex.InnerException;
            }
            var msg = ex.Message ?? ex.GetType().Name;
            var first = msg.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                           .Select(l => l.Trim())
                           .FirstOrDefault(l => l.Length > 0) ?? msg;
            return first.EndsWith(".") ? first : first + ".";
        }

        // The controller's hex return code, e.g. "C004900D", when present.
        public static string Code(Exception ex)
        {
            var m = System.Text.RegularExpressions.Regex.Match(Clean(ex), @"\b(C00[0-9A-F]{5})\b");
            return m.Success ? m.Groups[1].Value : null;
        }
    }

    internal static class TextFiles
    {
        static readonly Encoding Latin1 = Encoding.GetEncoding(28591);
        static readonly Encoding Utf8NoBom = new UTF8Encoding(false);

        // RobotWare 7 writes .modx/.sysx/.cfg as UTF-8; RobotWare 6 files are single-byte.
        public static string Read(string path, bool utf8)
        {
            var bytes = System.IO.File.ReadAllBytes(path);
            var text = (utf8 ? Utf8NoBom : Latin1).GetString(bytes);
            return text.Length > 0 && text[0] == (char)0xFEFF ? text.Substring(1) : text;
        }

        public static void Write(string path, string text, bool utf8) =>
            System.IO.File.WriteAllText(path, text, utf8 ? Utf8NoBom : Latin1);
    }
}

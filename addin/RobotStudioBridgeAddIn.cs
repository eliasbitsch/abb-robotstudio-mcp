using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using ABB.Robotics.RobotStudio;
using ABB.Robotics.RobotStudio.Stations;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RobotStudioBridge
{
    // RobotStudio add-in entry point and the loopback HTTP server that the MCP server's
    // rs_* tools call.
    //
    // SECURITY MODEL. The listener's only prefix is http://localhost:<port>/, so http.sys
    // rejects any request whose Host header is not localhost -- that also defeats DNS
    // rebinding. What is left is a web page in the user's own browser sending requests to
    // localhost. So every route except GET /ping requires the X-RobotStudioBridge-Client header
    // and refuses any request carrying an Origin header: a page cannot add a custom header
    // to a cross-origin request without a CORS preflight, and this server never approves
    // one (OPTIONS is refused). Every route also enforces its HTTP method, so a plain link
    // or <img> can never trigger an action. Other local processes are out of scope: a
    // process that can send this header can already read and write the user's files.
    public class RobotStudioBridgeAddIn
    {
        public const string ClientHeader = "X-RobotStudioBridge-Client";
        public const int DefaultPort = 58080;
        const long MaxBodyBytes = 64L * 1024 * 1024;

        static RobotStudioBridgeAddIn _instance; // keeps the listener rooted for the process lifetime

        HttpListener _listener;
        public int Port { get; private set; }
        readonly Router _router = new Router();

        static readonly JsonSerializerSettings JsonSettings = new JsonSerializerSettings
        {
            Formatting = Formatting.None,
            FloatFormatHandling = FloatFormatHandling.String, // never emit bare NaN/Infinity
            ReferenceLoopHandling = ReferenceLoopHandling.Error,
        };

        public static string Version =>
            Assembly.GetExecutingAssembly().GetName().Version.ToString(3);

        // RobotStudio calls this on its UI thread when the add-in loads.
        public static void AddinMain()
        {
            Ui.Init();
            var addIn = new RobotStudioBridgeAddIn();
            try
            {
                addIn.Start();
                _instance = addIn;
                Log.Info($"RobotStudioBridge {Version} listening on http://localhost:{addIn.Port}/ (UI dispatch: {Ui.Mode}).");
            }
            catch (Exception ex)
            {
                Log.Error($"RobotStudioBridge {Version} could not start its HTTP listener on port {addIn.Port}: {ex.Message} " +
                          "Is another RobotStudio instance (or another program) using that port? " +
                          "Set the ABB_BRIDGE_PORT environment variable to use a different port.");
            }
        }

        void Start()
        {
            Port = DefaultPort;
            var env = Environment.GetEnvironmentVariable("ABB_BRIDGE_PORT");
            if (!string.IsNullOrWhiteSpace(env))
            {
                int p;
                if (int.TryParse(env.Trim(), out p) && p > 0 && p < 65536) Port = p;
                else Log.Warn($"Ignoring ABB_BRIDGE_PORT='{env}' (not a valid port); using {DefaultPort}.");
            }

            Routes.Register(_router, Port);

            _listener = new HttpListener();
            _listener.Prefixes.Add($"http://localhost:{Port}/");
            _listener.Start();
            var thread = new Thread(ListenLoop) { IsBackground = true, Name = "RobotStudioBridge listener" };
            thread.Start();
        }

        void ListenLoop()
        {
            while (_listener.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = _listener.GetContext(); }
                catch (HttpListenerException) { if (!_listener.IsListening) return; continue; }
                catch (ObjectDisposedException) { return; }
                catch (Exception ex) { Log.Warn("Listener error: " + ex.Message); continue; }
                ThreadPool.QueueUserWorkItem(_ => Handle(ctx));
            }
        }

        void Handle(HttpListenerContext ctx)
        {
            int status = 200;
            object payload;
            var allow = (string)null;
            try
            {
                payload = Dispatch(ctx, ref status, ref allow);
            }
            catch (ApiException ex)
            {
                status = ex.Status;
                payload = new { error = ex.Message, code = ex.Code, details = ex.Details };
            }
            catch (Exception ex)
            {
                status = 500;
                payload = new { error = Errors.Clean(ex), code = "internal" };
            }
            Write(ctx, status, payload, allow);
        }

        object Dispatch(HttpListenerContext ctx, ref int status, ref string allow)
        {
            var request = ctx.Request;
            var path = request.Url.AbsolutePath.TrimEnd('/').ToLowerInvariant();
            if (path.Length == 0) path = "/";
            var method = request.HttpMethod.ToUpperInvariant();

            if (!string.IsNullOrEmpty(request.Headers["Origin"]))
                throw new ApiException(403, "forbidden",
                    "Requests from web pages are refused (an Origin header was present).");
            if (method == "OPTIONS")
                throw new ApiException(403, "forbidden", "Cross-origin requests are not supported.");

            var route = _router.Find(path);
            if (route == null)
                throw ApiException.NotFound($"Unknown endpoint: {path}");
            if (!route.Handlers.ContainsKey(method))
            {
                allow = string.Join(", ", route.Handlers.Keys);
                throw new ApiException(405, "method_not_allowed", $"{path} accepts {allow}, not {method}.");
            }
            if (!route.Public && string.IsNullOrEmpty(request.Headers[ClientHeader]))
                throw new ApiException(403, "forbidden",
                    $"Missing the {ClientHeader} header. Only the abb-robotstudio-mcp server (or a client that sends that header) may call this endpoint.");

            JObject body = null;
            if (method == "POST")
                body = ReadBody(request);

            return route.Handlers[method](new Req(request, path, body));
        }

        static JObject ReadBody(HttpListenerRequest request)
        {
            if (request.ContentLength64 > MaxBodyBytes)
                throw new ApiException(413, "too_large", $"Request body is larger than {MaxBodyBytes / (1024 * 1024)} MB.");
            string text;
            using (var reader = new StreamReader(request.InputStream, Encoding.UTF8))
                text = reader.ReadToEnd();
            if (string.IsNullOrWhiteSpace(text)) return new JObject();
            var ct = request.ContentType ?? "";
            if (!ct.StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
                throw new ApiException(415, "unsupported_media_type", "POST bodies must be application/json.");
            try
            {
                var token = JToken.Parse(text);
                if (!(token is JObject obj))
                    throw ApiException.BadRequest("The request body must be a JSON object.");
                return obj;
            }
            catch (JsonReaderException ex)
            {
                throw ApiException.BadRequest("The request body is not valid JSON: " + ex.Message);
            }
        }

        static void Write(HttpListenerContext ctx, int status, object payload, string allow)
        {
            try
            {
                string json;
                try { json = JsonConvert.SerializeObject(payload, JsonSettings); }
                catch (Exception ex)
                {
                    status = 500;
                    json = JsonConvert.SerializeObject(new { error = "Could not serialize the response: " + ex.Message, code = "internal" });
                }
                var bytes = Encoding.UTF8.GetBytes(json);
                ctx.Response.StatusCode = status;
                ctx.Response.ContentType = "application/json; charset=utf-8";
                ctx.Response.Headers["Cache-Control"] = "no-store";
                ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
                if (allow != null) ctx.Response.Headers["Allow"] = allow;
                ctx.Response.ContentLength64 = bytes.Length;
                ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
            }
            catch (Exception ex)
            {
                Log.Warn("Could not send a response: " + ex.Message);
            }
            finally
            {
                try { ctx.Response.Close(); } catch { }
            }
        }
    }

    internal sealed class Route
    {
        public bool Public;
        public readonly Dictionary<string, Func<Req, object>> Handlers =
            new Dictionary<string, Func<Req, object>>(StringComparer.Ordinal);
    }

    internal sealed class Router
    {
        readonly Dictionary<string, Route> _routes = new Dictionary<string, Route>(StringComparer.Ordinal);

        Route Get(string path)
        {
            Route r;
            if (!_routes.TryGetValue(path, out r)) _routes[path] = r = new Route();
            return r;
        }

        public void Get(string path, Func<Req, object> handler, bool isPublic = false)
        {
            var r = Get(path);
            r.Handlers["GET"] = handler;
            r.Public |= isPublic;
        }

        public void Post(string path, Func<Req, object> handler) => Get(path).Handlers["POST"] = handler;

        public Route Find(string path)
        {
            Route r;
            return _routes.TryGetValue(path, out r) ? r : null;
        }
    }

    internal static class Log
    {
        public static void Info(string text) => Add(text, LogMessageSeverity.Information);
        public static void Warn(string text) => Add(text, LogMessageSeverity.Warning);
        public static void Error(string text) => Add(text, LogMessageSeverity.Error);

        static void Add(string text, LogMessageSeverity severity)
        {
            try { Logger.AddMessage("RobotStudioBridge: " + text, severity); } catch { }
        }
    }
}

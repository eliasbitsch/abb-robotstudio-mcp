using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace RobotStudioBridge
{
    // An error with an HTTP status the router sends back verbatim. Anything else that
    // escapes a handler becomes a 500 carrying the exception's (cleaned) message.
    internal sealed class ApiException : Exception
    {
        public int Status { get; }
        public string Code { get; }
        public object Details { get; }

        public ApiException(int status, string code, string message, object details = null)
            : base(message)
        {
            Status = status;
            Code = code;
            Details = details;
        }

        public static ApiException BadRequest(string message) =>
            new ApiException(400, "bad_request", message);

        public static ApiException NotFound(string message) =>
            new ApiException(404, "not_found", message);

        public static ApiException Conflict(string message, object details = null) =>
            new ApiException(409, "conflict", message, details);

        // The request was valid and reached the controller, which refused or failed it.
        public static ApiException Failed(string message, object details = null) =>
            new ApiException(422, "failed", message, details);
    }

    // One HTTP request. Parameters come from the JSON body first, then the query string,
    // so GET routes use the query and POST routes use the body.
    internal sealed class Req
    {
        static readonly Regex RapidIdentifier = new Regex("^[A-Za-z][A-Za-z0-9_]{0,31}$");

        readonly HttpListenerRequest _request;
        readonly JObject _body;

        public string Method { get; }
        public string Path { get; }

        public Req(HttpListenerRequest request, string path, JObject body)
        {
            _request = request;
            _body = body;
            Method = request.HttpMethod;
            Path = path;
        }

        public string Header(string name) => _request.Headers[name];

        JToken Raw(string name)
        {
            if (_body != null && _body.TryGetValue(name, StringComparison.Ordinal, out var token)
                && token.Type != JTokenType.Null)
                return token;
            var q = _request.QueryString[name];
            return q == null ? null : new JValue(q);
        }

        public string Str(string name, bool required = false)
        {
            var t = Raw(name);
            if (t == null)
            {
                if (required) throw ApiException.BadRequest($"Missing required parameter '{name}'.");
                return null;
            }
            if (t.Type == JTokenType.Object || t.Type == JTokenType.Array)
                throw ApiException.BadRequest($"Parameter '{name}' must be a string.");
            var s = t.Type == JTokenType.String ? (string)t : t.ToString();
            if (required && string.IsNullOrWhiteSpace(s))
                throw ApiException.BadRequest($"Parameter '{name}' must not be empty.");
            return s;
        }

        // A RAPID identifier: task, module, data, routine, path and target names.
        public string Identifier(string name, bool required)
        {
            var s = Str(name, required);
            if (s == null) return null;
            s = s.Trim();
            if (!RapidIdentifier.IsMatch(s))
                throw ApiException.BadRequest(
                    $"Parameter '{name}' must be a RAPID identifier (a letter, then letters, digits or '_', at most 32 characters); got '{s}'.");
            return s;
        }

        public double? Number(string name, double min, double max, bool required = false)
        {
            var t = Raw(name);
            if (t == null)
            {
                if (required) throw ApiException.BadRequest($"Missing required parameter '{name}'.");
                return null;
            }
            double v;
            if (t.Type == JTokenType.Integer || t.Type == JTokenType.Float)
                v = t.Value<double>();
            else if (!double.TryParse(t.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out v))
                throw ApiException.BadRequest($"Parameter '{name}' must be a number; got '{t}'.");
            if (double.IsNaN(v) || double.IsInfinity(v))
                throw ApiException.BadRequest($"Parameter '{name}' must be a finite number.");
            if (v < min || v > max)
                throw ApiException.BadRequest($"Parameter '{name}' must be between {min} and {max}; got {v}.");
            return v;
        }

        public int Int(string name, int def, int min, int max)
        {
            var v = Number(name, min, max);
            if (v == null) return def;
            if (v.Value != Math.Floor(v.Value))
                throw ApiException.BadRequest($"Parameter '{name}' must be a whole number; got {v.Value}.");
            return (int)v.Value;
        }

        public bool Bool(string name, bool def)
        {
            var t = Raw(name);
            if (t == null) return def;
            if (t.Type == JTokenType.Boolean) return t.Value<bool>();
            switch (t.ToString().Trim().ToLowerInvariant())
            {
                case "true": case "1": return true;
                case "false": case "0": return false;
                default: throw ApiException.BadRequest($"Parameter '{name}' must be true or false; got '{t}'.");
            }
        }

        public string Choice(string name, string def, params string[] allowed)
        {
            var s = Str(name);
            if (s == null) return def;
            var match = allowed.FirstOrDefault(a => a.Equals(s.Trim(), StringComparison.OrdinalIgnoreCase));
            if (match == null)
                throw ApiException.BadRequest(
                    $"Parameter '{name}' must be one of: {string.Join(", ", allowed)}; got '{s}'.");
            return match;
        }

        // A list of strings: a JSON array, or a comma-separated string.
        public List<string> StrList(string name)
        {
            var t = Raw(name);
            if (t == null) return null;
            List<string> items;
            if (t.Type == JTokenType.Array)
            {
                items = new List<string>();
                foreach (var e in t)
                {
                    if (e.Type == JTokenType.Object || e.Type == JTokenType.Array)
                        throw ApiException.BadRequest($"Parameter '{name}' must be a list of strings.");
                    items.Add(e.ToString());
                }
            }
            else
            {
                items = t.ToString().Split(',').ToList();
            }
            return items.Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
        }
    }
}

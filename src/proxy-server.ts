import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createProxyRequest, updateProxyRequest } from "./lib/db-requests";
import { dbNotifier } from "./lib/db-notifier";
import { bufferToDataUrl } from "./lib/data-url";
import { handleWebSocketProxy } from "./lib/websocket-proxy";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = parseArgs({
  options: {
    port: { type: "string", short: "p", default: "27890" },
    config: { type: "string", short: "c" },
    instance: { type: "string", short: "i" },
  },
});

const PROXY_PORT = args.values.port;
const INSTANCE_NAME = args.values.instance ?? "default";

interface ForwardRule {
  name: string;
  target: string;
  enabled: boolean;
  description?: string | null;
  path?: string | null;
  methods?: string[];
  headers?: Record<string, string> | null;
}

let forwards: ForwardRule[] = [];
let instanceHeaders: Record<string, string> | null = null;

if (args.values.config) {
  try {
    const content = fs.readFileSync(args.values.config, "utf-8");
    const parsed = JSON.parse(content) as {
      instances: Array<{
        name: string;
        enabled?: boolean;
        headers?: Record<string, string> | null;
        forwards: ForwardRule[];
      }>;
    };

    const instance = parsed.instances.find((i) => i.name === INSTANCE_NAME);
    if (!instance) {
      console.error(`[Config] Instance "${INSTANCE_NAME}" not found`);
      process.exit(1);
    }
    forwards = (instance.forwards ?? []).filter((f) => f && f.enabled);
    instanceHeaders = instance.headers ?? null;
    console.log(`[Config] Loaded ${forwards.length} forward rules for "${INSTANCE_NAME}"`);
  } catch (error) {
    console.error("[Config] Failed to load config:", error);
    process.exit(1);
  }
}

function normalizePathname(pathname: string | null | undefined): string {
  if (!pathname || pathname === "") return "/";
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function matchMethod(
  ruleMethods: string[] | undefined,
  requestMethod: string,
): boolean {
  const method = (requestMethod || "GET").toUpperCase();
  if (!ruleMethods || ruleMethods.length === 0) return true;
  if (ruleMethods.includes("*")) return true;
  return ruleMethods.map((m) => m.toUpperCase()).includes(method);
}

function matchForwardRule(
  requestMethod: string,
  pathname: string,
): ForwardRule | null {
  if (forwards.length === 0) return null;
  const normalizedPath = normalizePathname(pathname);
  const method = (requestMethod || "GET").toUpperCase();

  let fallback: ForwardRule | null = null;
  for (const rule of forwards) {
    if (!matchMethod(rule.methods, method)) continue;
    const rulePath = normalizePathname(rule.path || "");
    if (!rule.path || rule.path.trim() === "") {
      if (!fallback) fallback = rule;
      continue;
    }
    if (normalizedPath.startsWith(rulePath)) return rule;
  }
  return fallback;
}

function joinPaths(basePath: string, suffix: string): string {
  const base = normalizePathname(basePath);
  if (!suffix || suffix === "/") return base;
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const s = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${b}${s}`;
}

function buildTargetUrl(rule: ForwardRule, requestUrl: URL): URL {
  const targetBase = new URL(rule.target);
  const incomingPath = normalizePathname(requestUrl.pathname);
  const rulePathRaw = rule.path ? normalizePathname(rule.path) : "";

  let finalPath: string;
  if (rulePathRaw && incomingPath.startsWith(rulePathRaw)) {
    const suffix = incomingPath.slice(rulePathRaw.length) || "/";
    finalPath =
      suffix === "/"
        ? targetBase.pathname || "/"
        : joinPaths(targetBase.pathname || "/", suffix);
  } else if (!rulePathRaw) {
    const basePath = targetBase.pathname || "/";
    finalPath = basePath === "/" || basePath === "" ? incomingPath : basePath;
  } else {
    finalPath = joinPaths(targetBase.pathname || "/", incomingPath);
  }
  targetBase.pathname = finalPath;
  targetBase.search = requestUrl.search;
  return targetBase;
}

function applyCustomHeaders(
  headers: http.OutgoingHttpHeaders,
  additions: Record<string, string> | null | undefined,
): void {
  if (!additions) return;
  for (const [rawKey, value] of Object.entries(additions)) {
    const isRegex =
      rawKey.startsWith("/") && rawKey.endsWith("/") && rawKey.length > 2;
    const targetKeys: string[] = [];
    if (isRegex) {
      const pattern = rawKey.slice(1, -1);
      const regex = new RegExp(pattern, "i");
      for (const existing of Object.keys(headers)) {
        if (regex.test(existing)) targetKeys.push(existing);
      }
      if (targetKeys.length === 0) continue;
    } else {
      targetKeys.push(rawKey.toLowerCase());
    }
    for (const key of targetKeys) {
      if (value === "/DELETE") {
        delete headers[key];
      } else {
        headers[key] = value;
      }
    }
  }
}

let requestCounter = 0;

const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  const requestId = `${++requestCounter}`;
  const timestamp = new Date().toISOString();

  const protocol = req.headers["x-forwarded-proto"] || "http";
  const requestUrl = new URL(
    req.url || "/",
    `${protocol}://${req.headers.host || `localhost:${PROXY_PORT}`}`,
  );
  const method = (req.method || "GET").toUpperCase();
  const forwardRule = matchForwardRule(method, requestUrl.pathname);
  if (!forwardRule) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "No forward rules configured" }));
    return;
  }

  const targetUrl = buildTargetUrl(forwardRule, requestUrl);

  const requestBodyChunks: Buffer[] = [];
  for await (const chunk of req) {
    requestBodyChunks.push(chunk as Buffer);
  }
  const requestBody = Buffer.concat(requestBodyChunks);
  const requestContentType = (req.headers["content-type"] as string) || null;
  const requestBodyDataUrl =
    requestBody.length > 0
      ? bufferToDataUrl(requestBody, requestContentType)
      : null;

  const forwardHeaders: http.OutgoingHttpHeaders = { ...req.headers };
  forwardHeaders.host = targetUrl.host;
  applyCustomHeaders(forwardHeaders, instanceHeaders);
  applyCustomHeaders(forwardHeaders, forwardRule.headers ?? null);

  const dbRecordId = createProxyRequest({
    request_id: requestId,
    timestamp,
    instance_name: INSTANCE_NAME,
    forward_name: forwardRule.name,
    group_name: `${INSTANCE_NAME}/${forwardRule.name}`,
    status: "pending",
    is_websocket: false,
    websocket_direction: null,
    error_message: null,
    request: {
      method,
      url: requestUrl.href,
      headers: req.headers as Record<string, string | string[]>,
      forwardedHeaders: forwardHeaders as Record<string, string | string[]>,
      bodyDataUrl: requestBodyDataUrl,
      bodySize: requestBody.length,
    },
    response: undefined,
  });

  const isHttps = targetUrl.protocol === "https:";
  const requestModule = isHttps ? https : http;
  const defaultPort = isHttps ? 443 : 80;

  const proxyReq = requestModule.request(
    {
      hostname: targetUrl.hostname,
      port: targetUrl.port || defaultPort,
      path: targetUrl.pathname + targetUrl.search,
      method,
      headers: forwardHeaders,
    },
    (proxyRes) => {
      const responseChunks: Buffer[] = [];
      proxyRes.on("data", (chunk) => {
        responseChunks.push(chunk as Buffer);
        res.write(chunk);
      });

      proxyRes.on("end", () => {
        const duration = Date.now() - startTime;
        const responseBody = Buffer.concat(responseChunks);
        const contentType = proxyRes.headers["content-type"] as
          | string
          | undefined;
        const responseBodyDataUrl =
          responseBody.length > 0
            ? bufferToDataUrl(responseBody, contentType)
            : null;

        updateProxyRequest(dbRecordId, {
          status: "completed",
          response: {
            statusCode: proxyRes.statusCode ?? null,
            statusMessage: proxyRes.statusMessage ?? null,
            headers: proxyRes.headers as Record<string, string | string[]>,
            bodyDataUrl: responseBodyDataUrl,
            bodySize: responseBody.length,
            durationMs: duration,
            contentType: contentType ?? null,
          },
        });

        res.end();
      });

      res.writeHead(proxyRes.statusCode || 502, proxyRes.statusMessage, {
        ...proxyRes.headers,
      });
    },
  );

  proxyReq.on("error", (error) => {
    const duration = Date.now() - startTime;
    const errorBody = Buffer.from(
      JSON.stringify({
        error: "代理请求失败",
        message: error.message,
      }),
    );

    updateProxyRequest(dbRecordId, {
      status: "error",
      error_message: error.message,
      response: {
        statusCode: 502,
        statusMessage: "Bad Gateway",
        headers: { "content-type": "application/json" },
        bodyDataUrl: bufferToDataUrl(errorBody, "application/json"),
        bodySize: errorBody.length,
        durationMs: duration,
        contentType: "application/json",
      },
    });

    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: "代理请求失败", message: error.message }));
  });

  if (requestBody.length > 0) proxyReq.write(requestBody);
  proxyReq.end();
});

server.on("upgrade", (req, socket, head) => {
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const requestUrl = new URL(
    req.url || "/",
    `${protocol}://${req.headers.host || `localhost:${PROXY_PORT}`}`,
  );

  const forwardRule = matchForwardRule("GET", requestUrl.pathname);
  if (!forwardRule) {
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    socket.destroy();
    return;
  }

  const targetUrl = buildTargetUrl(forwardRule, requestUrl);

  handleWebSocketProxy(
    req,
    socket,
    head,
    targetUrl,
    INSTANCE_NAME,
    forwardRule.name,
  );
});

server.on("error", (error) => {
  console.error("服务器错误:", error);
});

dbNotifier.init();

server.listen(PROXY_PORT, () => {
  console.log(
    `Proxy running on http://localhost:${PROXY_PORT} (instance: ${INSTANCE_NAME})`,
  );
});

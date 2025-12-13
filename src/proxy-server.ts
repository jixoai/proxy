import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parentPort } from "node:worker_threads";
import createDebug from "debug";
import { createProxyRequest, updateProxyRequest } from "./lib/db-requests";
import { dbNotifier } from "./lib/db-notifier";
import { bufferToDataUrl } from "./lib/data-url";
import { handleWebSocketProxy } from "./lib/websocket-proxy";
import { HooksExecutor, stopAllHooks } from "./lib/hooks-executor";
import type { HooksConfig } from "./types/proxy";
import type {
  WorkerMessage,
  WorkerResponse,
  InstanceRuntimeConfig,
  ForwardRuleConfig,
} from "./types/worker-messages";
import { normalizeForwardGroups, normalizePathname } from "./lib/forward-utils";
import { createLogger, installGlobalErrorLogger } from "./lib/logger";
import { forwardStatsManager } from "./lib/forward-stats-manager";

const debugNotifier = createDebug("plugins:db-notifier");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = parseArgs({
  argv: process.argv.slice(2),
  allowPositionals: true,
  options: {
    port: { type: "string", short: "p", default: "27890" },
    config: { type: "string", short: "c" },
    instance: { type: "string", short: "i" },
  },
});

const PROXY_PORT = args.values.port;
const INSTANCE_NAME = args.values.instance ?? "default";
const log = createLogger(`proxy:server:${INSTANCE_NAME}`);
installGlobalErrorLogger(`proxy-server:${INSTANCE_NAME}`);

// 在 worker 模式下，将日志透传给父线程以便 UI 实时展示
if (parentPort) {
  const originalConsole = { ...console };
  (["log", "info", "warn", "error"] as const).forEach((level) => {
    const original = originalConsole[level];
    console[level] = (...payload: unknown[]) => {
      const message = payload.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
      parentPort?.postMessage({
        type: "log",
        level,
        message,
        timestamp: Date.now(),
        instanceName: INSTANCE_NAME,
      });
      original.apply(originalConsole, payload as never);
    };
  });
}

interface ForwardRule {
  name: string;
  target: string;
  enabled: boolean;
  description?: string | null;
  path?: string | null;
  methods?: string[];
  headers?: Record<string, string> | null;
  hooks?: HooksConfig | null;
}

let forwards: ForwardRule[] = [];
let instanceHeaders: Record<string, string> | null = null;
let instanceHooks: HooksConfig | null = null;
let hooksExecutor: HooksExecutor | null = null;

if (args.values.config) {
  try {
    const content = fs.readFileSync(args.values.config, "utf-8");
    // 读取 InstanceRuntimeConfig 格式（单一数据源）
    const instanceConfig = JSON.parse(content) as {
      name: string;
      headers?: Record<string, string> | null;
      hooks?: HooksConfig | null;
      forwards: ForwardRule[];
    };

    if (instanceConfig.name !== INSTANCE_NAME) {
      console.error(`[Config] Config file instance name "${instanceConfig.name}" does not match "${INSTANCE_NAME}"`);
      process.exit(1);
    }
    forwards = normalizeForwardGroups((instanceConfig.forwards ?? []).filter((f) => f && f.enabled));
    instanceHeaders = instanceConfig.headers ?? null;
    instanceHooks = instanceConfig.hooks ?? null;
    log.info(`[Config] Loaded ${forwards.length} forward rules for "${INSTANCE_NAME}"`);

    // 初始化 hooks 执行器
    if (instanceHooks || forwards.some((f) => f.hooks)) {
      hooksExecutor = new HooksExecutor(INSTANCE_NAME, instanceHooks);
      hooksExecutor.start().catch((err) => {
        console.error("[Hooks] Failed to start hooks executor:", err);
      });
    }
  } catch (error) {
    console.error("[Config] Failed to load config:", error);
    process.exit(1);
  }
}

/** 获取当前运行时配置 */
function getCurrentConfig(): InstanceRuntimeConfig {
  return {
    name: INSTANCE_NAME,
    headers: instanceHeaders,
    hooks: instanceHooks,
    forwards: forwards.map((f) => ({
      name: f.name,
      target: f.target,
      enabled: f.enabled,
      description: f.description,
      path: f.path,
      methods: f.methods,
      headers: f.headers,
      hooks: f.hooks,
    })),
  };
}

/** 热更新配置（不重启服务器） */
async function reloadConfig(newConfig: InstanceRuntimeConfig): Promise<void> {
  log.info(`[Reload] Applying new config for "${INSTANCE_NAME}"...`);

  // 停止旧的 hooks executor
  if (hooksExecutor) {
    await hooksExecutor.stop();
    hooksExecutor = null;
  }

  // 更新配置
  instanceHeaders = newConfig.headers;
  instanceHooks = newConfig.hooks;
  forwards = normalizeForwardGroups(newConfig.forwards.filter((f) => f && f.enabled));

  // 启动新的 hooks executor
  if (instanceHooks || forwards.some((f) => f.hooks)) {
    hooksExecutor = new HooksExecutor(INSTANCE_NAME, instanceHooks);
    await hooksExecutor.start();
  }

  log.info(
    `[Reload] Config updated: ${forwards.length} forward rules, headers: ${instanceHeaders ? Object.keys(instanceHeaders).length : 0}`,
  );
}

// Worker 消息处理
if (parentPort) {
  parentPort.on("message", async (message: WorkerMessage) => {
    try {
      switch (message.type) {
        case "reload": {
          await reloadConfig(message.config);
          const response: WorkerResponse = {
            type: "reload-result",
            success: true,
          };
          parentPort?.postMessage(response);
          break;
        }
        case "get-config": {
          const response: WorkerResponse = {
            type: "config",
            config: getCurrentConfig(),
          };
          parentPort?.postMessage(response);
          break;
        }
        case "ping": {
          const response: WorkerResponse = { type: "pong" };
          parentPort?.postMessage(response);
          break;
        }
      }
    } catch (error) {
      const response: WorkerResponse = {
        type: "reload-result",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      parentPort?.postMessage(response);
    }
  });
}

function matchMethod(ruleMethods: string[] | undefined, requestMethod: string): boolean {
  const method = (requestMethod || "GET").toUpperCase();
  if (!ruleMethods || ruleMethods.length === 0) return true;
  if (ruleMethods.includes("*")) return true;
  return ruleMethods.map((m) => m.toUpperCase()).includes(method);
}

function matchForwardRule(
  requestMethod: string,
  pathname: string,
): { rule: ForwardRule; index: number } | null {
  if (forwards.length === 0) return null;
  const normalizedPath = normalizePathname(pathname);
  const method = (requestMethod || "GET").toUpperCase();

  let fallback: { rule: ForwardRule; index: number } | null = null;
  for (let idx = 0; idx < forwards.length; idx++) {
    const rule = forwards[idx]!;
    if (!matchMethod(rule.methods, method)) continue;
    const rulePath = normalizePathname(rule.path || "");
    if (!rule.path || rule.path.trim() === "") {
      if (!fallback) fallback = { rule, index: idx };
      continue;
    }
    if (normalizedPath.startsWith(rulePath)) return { rule, index: idx };
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
      suffix === "/" ? targetBase.pathname || "/" : joinPaths(targetBase.pathname || "/", suffix);
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
    const isRegex = rawKey.startsWith("/") && rawKey.endsWith("/") && rawKey.length > 2;
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

  const matched = matchForwardRule(method, requestUrl.pathname);
  if (!matched) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "No forward rules configured" }));
    return;
  }

  const candidateIndexes: number[] = forwards
    .map((rule, idx) => ({ rule, idx }))
    .filter(({ rule }) => {
      if (rule.name !== matched.rule.name) return false;
      if (!matchMethod(rule.methods, method)) return false;
      const rulePath = normalizePathname(rule.path || "");
      const normalizedPath = normalizePathname(requestUrl.pathname);
      if (!rule.path || rule.path.trim() === "") return true;
      return normalizedPath.startsWith(rulePath);
    })
    .map(({ idx }) => idx);

  if (candidateIndexes.length === 0) {
    candidateIndexes.push(matched.index);
  }

  const requestBodyChunks: Buffer[] = [];
  for await (const chunk of req) {
    requestBodyChunks.push(chunk as Buffer);
  }
  const originalRequestBody = Buffer.concat(requestBodyChunks);
  const requestContentType = (req.headers["content-type"] as string) || null;
  const originalRequestBodyDataUrl =
    originalRequestBody.length > 0
      ? bufferToDataUrl(originalRequestBody, requestContentType)
      : null;

  const hopByHopKeys = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-length",
  ];

  const sanitizeResponseHeaders = (
    headers: http.IncomingHttpHeaders,
    bodyLength: number,
  ): http.OutgoingHttpHeaders => {
    const clean: http.OutgoingHttpHeaders = { ...headers };
    for (const key of hopByHopKeys) {
      delete (clean as Record<string, unknown>)[key as string];
    }
    clean["content-length"] = bodyLength;
    return clean;
  };

  let dbRecordId: number | null = null;
  let finalResult: {
    statusCode: number;
    statusMessage: string;
    headers: http.OutgoingHttpHeaders;
    bodyBuffer: Buffer;
    contentType: string | null;
    durationMs: number;
    errorMessage?: string;
    forwardRule: ForwardRule;
  } | null = null;

  for (let i = 0; i < candidateIndexes.length; i++) {
    const ruleIndex = candidateIndexes[i];
    const forwardRule = forwards[ruleIndex as number]!;

    if (hooksExecutor && (instanceHooks || forwardRule.hooks)) {
      try {
        await hooksExecutor.setForwardHooks(forwardRule.name, forwardRule.hooks ?? null);
      } catch (err) {
        console.error("[Hooks] Failed to set forward hooks:", err);
      }
    }

    let targetUrl = buildTargetUrl(forwardRule, requestUrl);
    const forwardHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    forwardHeaders.host = targetUrl.host;
    applyCustomHeaders(forwardHeaders, instanceHeaders);
    applyCustomHeaders(forwardHeaders, forwardRule.headers ?? null);

    let hookedMethod = method;
    let hookedTargetUrl = targetUrl;
    let hookedRequestBody = originalRequestBody;
    let hookedForwardHeaders: http.OutgoingHttpHeaders = { ...forwardHeaders };
    let hasRequestHookChanges = false;

    if (hooksExecutor?.hasRequestHooks) {
      try {
        const hookResult = await hooksExecutor.executeRequestHooks({
          method,
          url: targetUrl.href,
          headers: hookedForwardHeaders as Record<string, string | string[]>,
          body: hookedRequestBody,
        });

        if (hookResult.method && hookResult.method !== hookedMethod) {
          hookedMethod = hookResult.method;
          hasRequestHookChanges = true;
        }
        if (hookResult.url && hookResult.url !== hookedTargetUrl.href) {
          hookedTargetUrl = new URL(hookResult.url);
          hasRequestHookChanges = true;
          hookedForwardHeaders.host = hookedTargetUrl.host;
        }
        if (hookResult.headers) {
          hookedForwardHeaders = hookResult.headers as http.OutgoingHttpHeaders;
          hookedForwardHeaders.host = hookedTargetUrl.host;
          hasRequestHookChanges = true;
        }
        if (hookResult.body !== undefined) {
          const nextBody = Buffer.from(hookResult.body);
          if (!nextBody.equals(hookedRequestBody)) {
            hasRequestHookChanges = true;
          }
          hookedRequestBody = nextBody;
        }
      } catch (err) {
        console.error("[Hooks] Request hook error:", err);
      }
    }

    const hookedRequestBodyDataUrl =
      hookedRequestBody.length > 0 ? bufferToDataUrl(hookedRequestBody, requestContentType) : null;

    if (hookedForwardHeaders["content-length"] !== undefined) {
      if (hookedRequestBody.length > 0) {
        hookedForwardHeaders["content-length"] = hookedRequestBody.length;
      } else {
        delete hookedForwardHeaders["content-length"];
      }
    }

    if (dbRecordId === null) {
      dbRecordId = createProxyRequest({
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
          bodyDataUrl: originalRequestBodyDataUrl,
          bodySize: originalRequestBody.length,
        },
        hookedRequest: hasRequestHookChanges
          ? {
              method: hookedMethod,
              url: hookedTargetUrl.href,
              headers: hookedForwardHeaders as Record<string, string | string[]>,
              bodyDataUrl: hookedRequestBodyDataUrl,
              bodySize: hookedRequestBody.length,
            }
          : undefined,
        response: undefined,
      });
      debugNotifier("about to notify insert, dbRecordId: %d", dbRecordId);
      dbNotifier.notify("insert", "proxy_requests", dbRecordId);
      debugNotifier("notify insert completed");
    }

    const attemptStart = Date.now();
    const isHttps = hookedTargetUrl.protocol === "https:";
    const requestModule = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;

    const attemptResult = await new Promise<{
      statusCode: number;
      statusMessage: string;
      headers: http.OutgoingHttpHeaders;
      bodyBuffer: Buffer;
      contentType: string | null;
      errorMessage?: string;
      ttfbMs: number;
    }>((resolve) => {
      const proxyReq = requestModule.request(
        {
          hostname: hookedTargetUrl.hostname,
          port: hookedTargetUrl.port || defaultPort,
          path: hookedTargetUrl.pathname + hookedTargetUrl.search,
          method: hookedMethod,
          headers: hookedForwardHeaders,
        },
        async (proxyRes) => {
          // TTFB: 收到响应头的时间
          const ttfbMs = Date.now() - attemptStart;
          const responseChunks: Buffer[] = [];

          let responseHeaders = { ...proxyRes.headers };
          let statusCode = proxyRes.statusCode || 502;
          let statusMessage = proxyRes.statusMessage || "";

          proxyRes.on("data", (chunk: Buffer) => {
            responseChunks.push(Buffer.from(chunk));
          });

          proxyRes.on("end", async () => {
            let bodyBuffer = Buffer.concat(responseChunks);
            let contentType = (responseHeaders["content-type"] as string) ?? null;

            if (hooksExecutor?.hasResponseHooks) {
              try {
                const hookResult = await hooksExecutor.executeResponseHooks({
                  statusCode,
                  statusMessage,
                  headers: responseHeaders as Record<string, string | string[]>,
                  body: bodyBuffer,
                });
                if (hookResult.statusCode !== undefined) statusCode = hookResult.statusCode;
                if (hookResult.statusMessage !== undefined)
                  statusMessage = hookResult.statusMessage;
                if (hookResult.headers)
                  responseHeaders = hookResult.headers as http.IncomingHttpHeaders;
                if (hookResult.body !== undefined) bodyBuffer = Buffer.from(hookResult.body);
                contentType = (responseHeaders["content-type"] as string) ?? contentType;
              } catch (err) {
                console.error("[Hooks] Response hook error:", err);
              }
            }

            const cleanedHeaders = sanitizeResponseHeaders(responseHeaders, bodyBuffer.length);

            resolve({
              statusCode,
              statusMessage,
              headers: cleanedHeaders,
              bodyBuffer,
              contentType,
              ttfbMs,
            });
          });
        },
      );

      proxyReq.on("error", (error) => {
        const errorTtfb = Date.now() - attemptStart;
        const errorBody = Buffer.from(
          JSON.stringify({
            error: "代理请求失败",
            message: error.message,
          }),
        );
        resolve({
          statusCode: 502,
          statusMessage: "Bad Gateway",
          headers: {
            "content-type": "application/json",
            "content-length": errorBody.length,
          },
          bodyBuffer: errorBody,
          contentType: "application/json",
          errorMessage: error.message,
          ttfbMs: errorTtfb,
        });
      });

      if (hookedRequestBody.length > 0) proxyReq.write(hookedRequestBody);
      proxyReq.end();
    });

    const durationMs = Date.now() - attemptStart;

    // 上报统计数据
    const isFailureStatus = attemptResult.statusCode >= 400 && attemptResult.statusCode <= 599;
    const success = !attemptResult.errorMessage && !isFailureStatus;

    // 计算 endpointIndex: 在同名规则组中的位置
    const endpointIndex = candidateIndexes.indexOf(ruleIndex as number);
    forwardStatsManager.sendReport(
      INSTANCE_NAME,
      forwardRule.name,
      endpointIndex,
      hookedTargetUrl.href,
      durationMs,
      success,
    );

    finalResult = {
      ...attemptResult,
      durationMs,
      forwardRule,
    };

    if (!isFailureStatus) {
      break;
    }

    const hasMore = i < candidateIndexes.length - 1;
    if (!hasMore) break;
  }

  if (!finalResult || !finalResult.forwardRule || dbRecordId === null) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "No available forward result" }));
    return;
  }

  const totalDuration = Date.now() - startTime;
  const responseBodyDataUrl =
    finalResult.bodyBuffer.length > 0
      ? bufferToDataUrl(finalResult.bodyBuffer, finalResult.contentType ?? undefined)
      : null;

  updateProxyRequest(dbRecordId, {
    status: finalResult.errorMessage ? "error" : "completed",
    error_message: finalResult.errorMessage ?? null,
    forward_name: finalResult.forwardRule.name,
    response: {
      statusCode: finalResult.statusCode,
      statusMessage: finalResult.statusMessage,
      headers: finalResult.headers as Record<string, string | string[]>,
      bodyDataUrl: responseBodyDataUrl,
      bodySize: finalResult.bodyBuffer.length,
      durationMs: totalDuration,
      contentType: finalResult.contentType ?? null,
    },
  });
  dbNotifier.notify("update", "proxy_requests", dbRecordId);

  res.writeHead(finalResult.statusCode, finalResult.statusMessage, finalResult.headers);
  res.end(finalResult.bodyBuffer);
});

server.on("upgrade", (req, socket, head) => {
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const requestUrl = new URL(
    req.url || "/",
    `${protocol}://${req.headers.host || `localhost:${PROXY_PORT}`}`,
  );

  const matched = matchForwardRule("GET", requestUrl.pathname);
  if (!matched) {
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    socket.destroy();
    return;
  }

  const targetUrl = buildTargetUrl(matched.rule, requestUrl);

  handleWebSocketProxy(req, socket, head, targetUrl, INSTANCE_NAME, matched.rule.name);
});

server.on("error", (error) => {
  console.error("服务器错误:", error);
  const resp: WorkerResponse = {
    type: "server-error",
    error: String(error),
    code: (error as NodeJS.ErrnoException).code,
    stack: error instanceof Error ? error.stack : undefined,
    port: Number(PROXY_PORT),
  };
  parentPort?.postMessage(resp);
});

dbNotifier.init();
forwardStatsManager.init();

server.listen(PROXY_PORT, () => {
  console.log(`Proxy running on http://localhost:${PROXY_PORT} (instance: ${INSTANCE_NAME})`);
});

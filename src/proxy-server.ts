import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import createDebug from "debug";
import {
  createProxyRequest,
  updateProxyRequest,
  updateStreamingProgress,
  type AbortReason,
} from "./lib/db-requests";
import { dbNotifier } from "./lib/db-notifier";
import { setDataDir } from "./lib/runtime-paths";
import { initDatabase } from "./lib/db";
import { bufferToDataUrl } from "./lib/data-url";
import { handleWebSocketProxy } from "./lib/websocket-proxy";
import { HooksExecutor, stopAllHooks } from "./lib/hooks-executor";
import type { HooksConfig, HookLayer } from "./types/proxy";
import type {
  WorkerMessage,
  WorkerResponse,
  InstanceRuntimeConfig,
  ForwardRuleConfig,
} from "./types/worker-messages";
import { normalizeForwardGroups, normalizePathname } from "./lib/forward-utils";
import { createLogger, installGlobalErrorLogger } from "./lib/logger";
import { forwardStatsStore } from "./lib/forward-stats";

/** 私有 header 前缀，这些 headers 只记录到数据库，不转发到远程服务器 */
const PRIVATE_HEADER_PREFIX = "-x-jixo-proxy-";

/** 私有 header：原始 Proxy URL（用于插件发起回环请求，如心跳） */
const HEADER_PROXY_URL = "-x-jixo-proxy-url";

/** 过滤掉私有 headers */
function stripPrivateHeaders(headers: http.IncomingHttpHeaders): http.IncomingHttpHeaders {
  const result: http.IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!key.toLowerCase().startsWith(PRIVATE_HEADER_PREFIX)) {
      result[key] = value;
    }
  }
  return result;
}

const debugNotifier = createDebug("plugins:db-notifier");

declare var self: Worker;
const parentPort = typeof self.postMessage === "function" ? self : null;
declare global {
  var __proxyServer: http.Server;
}

parentPort
  ? new Promise<string[]>((resolve) => {
      parentPort.postMessage({ type: "env-ready" });
      const handler = (event: MessageEvent) => {
        const msg = event.data as WorkerMessage;
        if (msg.type === "pre-init") {
          resolve(msg.argv);
          parentPort.removeEventListener("message", handler);
        }
      };
      parentPort.addEventListener("message", handler);
    })
      .then(main)
      .then(() => {
        parentPort.postMessage({ type: "pre-init-done" });
      })
  : main(process.argv.slice(2));

async function main(argv: string[]) {
  const args = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p", default: "0" },
      config: { type: "string", short: "c" },
      instance: { type: "string", short: "i" },
    },
  });

  const PROXY_PORT = args.values.port;
  const INSTANCE_NAME = args.values.instance ?? "default";
  const log = createLogger(`proxy:server:${INSTANCE_NAME}`);
  installGlobalErrorLogger(`proxy-server:${INSTANCE_NAME}`);

  const CLIENT_DISCONNECT: AbortReason = "client_disconnect";
  const USER_ABORT: AbortReason = "user_abort";

  function isAbortReason(value: unknown): value is AbortReason {
    return value === CLIENT_DISCONNECT || value === USER_ABORT;
  }

  function getAbortReasonFromSignal(signal: AbortSignal): AbortReason {
    return isAbortReason(signal.reason) ? signal.reason : CLIENT_DISCONNECT;
  }

  class ProxyRequestAbortedError extends Error {
    readonly abortReason: AbortReason;

    constructor(abortReason: AbortReason) {
      super("Request aborted");
      this.name = "ProxyRequestAbortedError";
      this.abortReason = abortReason;
    }
  }
  // 在 worker 模式下，将日志透传给父线程以便 UI 实时展示
  if (parentPort) {
    const originalConsole = { ...console };
    (["log", "info", "warn", "error"] as const).forEach((level) => {
      const original = originalConsole[level];
      console[level] = (...payload: unknown[]) => {
        const message = payload
          .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
          .join(" ");
        parentPort.postMessage({
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
    id: string;
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
        console.error(
          `[Config] Config file instance name "${instanceConfig.name}" does not match "${INSTANCE_NAME}"`,
        );
        process.exit(1);
      }
      forwards = normalizeForwardGroups((instanceConfig.forwards ?? []).filter((f) => f));
      instanceHeaders = instanceConfig.headers ?? null;
      instanceHooks = instanceConfig.hooks ?? null;
      const enabledCount = forwards.filter((f) => f.enabled).length;
      log.info(
        `[Config] Loaded ${forwards.length} forward rules (${enabledCount} enabled) for "${INSTANCE_NAME}"`,
      );
      // 详细日志：显示每个 forward 的 enabled 状态
      forwards.forEach((f, idx) => {
        log.info(`[Config]   [${idx}] ${f.name}: enabled=${f.enabled}, path=${f.path || "(default)"}`);
      });

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
        id: f.id,
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
    forwards = normalizeForwardGroups(newConfig.forwards.filter((f) => f));

    // 启动新的 hooks executor
    if (instanceHooks || forwards.some((f) => f.hooks)) {
      hooksExecutor = new HooksExecutor(INSTANCE_NAME, instanceHooks);
      await hooksExecutor.start();
    }

    const enabledCount = forwards.filter((f) => f.enabled).length;
    log.info(
      `[Reload] Config updated: ${forwards.length} forward rules (${enabledCount} enabled), headers: ${instanceHeaders ? Object.keys(instanceHeaders).length : 0}`,
    );
    // 详细日志：显示每个 forward 的 enabled 状态
    forwards.forEach((f, idx) => {
      log.info(`[Reload]   [${idx}] ${f.name}: enabled=${f.enabled}, path=${f.path || "(default)"}`);
    });
  }

  // Worker 消息处理
  if (parentPort) {
    parentPort.addEventListener("message", async (event) => {
      const message: WorkerMessage = event.data;
      try {
        switch (message.type) {
          case "init": {
            // 初始化数据目录和数据库
            setDataDir(message.dataDir);
            initDatabase();

            const response: WorkerResponse = {
              type: "init-result",
              success: true,
            };
            parentPort.postMessage(response);
            log.info(`[Init] Database initialized with dataDir: ${message.dataDir}`);
            break;
          }
          case "reload": {
            await reloadConfig(message.config);
            const response: WorkerResponse = {
              type: "reload-result",
              success: true,
            };
            parentPort.postMessage(response);
            break;
          }
          case "get-config": {
            const response: WorkerResponse = {
              type: "config",
              config: getCurrentConfig(),
            };
            parentPort.postMessage(response);
            break;
          }
          case "ping": {
            const response: WorkerResponse = { type: "pong" };
            parentPort.postMessage(response);
            break;
          }
          case "abort-request": {
            const controller = activeRequests.get(message.dbRecordId);
            const success = !!controller;
            if (controller) {
              controller.abort(USER_ABORT);
              log.info(`[Abort] Request #${message.dbRecordId} aborted by user`);
            }
            const response: WorkerResponse = {
              type: "abort-result",
              success,
              dbRecordId: message.dbRecordId,
            };
            parentPort.postMessage(response);
            break;
          }
          case "shutdown": {
            log.info(`[Shutdown] Received shutdown message, closing server...`);
            // server 会在后面定义，这里用 globalThis 延迟访问
            const srv = globalThis.__proxyServer;
            if (srv) {
              srv.close(() => {
                log.info(`[Shutdown] Server closed`);
                process.exit(0);
              });
            } else {
              process.exit(0);
            }
            break;
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;

        switch (message.type) {
          case "init": {
            const response: WorkerResponse = {
              type: "init-result",
              success: false,
              error: errorMessage,
            };
            parentPort.postMessage(response);
            break;
          }
          case "reload": {
            const response: WorkerResponse = {
              type: "reload-result",
              success: false,
              error: errorMessage,
            };
            parentPort.postMessage(response);
            break;
          }
          case "abort-request": {
            const response: WorkerResponse = {
              type: "abort-result",
              success: false,
              dbRecordId: message.dbRecordId,
            };
            parentPort.postMessage(response);
            break;
          }
          default: {
            const response: WorkerResponse = {
              type: "server-error",
              error: errorMessage,
              stack,
              port: Number(PROXY_PORT),
            };
            parentPort.postMessage(response);
            break;
          }
        }
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
      // 跳过禁用的规则
      if (!rule.enabled) continue;
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

  // 存储活跃请求的 AbortController，用于支持请求中断
  const activeRequests = new Map<number, AbortController>();

  const server = http.createServer(async (req, res) => {
    const startTime = Date.now();
    const requestId = `${++requestCounter}`;
    const timestamp = new Date().toISOString();

    // 创建 AbortController 用于级联取消整个请求链路
    const abortController = new AbortController();
    const { signal: abortSignal } = abortController;
    let isClientDisconnected = false;
    let didStreamResponseToClient = false;

    // 监听上游客户端断开连接
    const handleClientClose = () => {
      if (!res.writableEnded && !isClientDisconnected) {
        // 如果是用户主动 abort 导致的下游关闭，不应被视为 client_disconnect
        if (abortSignal.aborted && getAbortReasonFromSignal(abortSignal) === USER_ABORT) {
          return;
        }
        isClientDisconnected = true;
        abortController.abort(CLIENT_DISCONNECT);
        log.info(`[Abort] Client disconnected for request #${requestId}`);
      }
    };
    req.on("aborted", handleClientClose);
    res.on("close", handleClientClose);

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
        // 跳过禁用的规则
        if (!rule.enabled) return false;
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
    ];

    const sanitizeResponseHeadersForStreaming = (
      headers: http.IncomingHttpHeaders,
    ): http.OutgoingHttpHeaders => {
      const clean: http.OutgoingHttpHeaders = { ...headers };
      for (const key of hopByHopKeys) {
        delete (clean as Record<string, unknown>)[key as string];
      }
      return clean;
    };

    const sanitizeResponseHeadersForBuffered = (
      headers: http.IncomingHttpHeaders,
      bodyLength: number,
    ): http.OutgoingHttpHeaders => {
      const clean = sanitizeResponseHeadersForStreaming(headers);
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
      ttfbMs: number;
      bodyMs: number;
      errorMessage?: string;
      abortReason?: AbortReason;
      forwardRule: ForwardRule;
      hasResponseHookChanges?: boolean;
      responseHookLayers?: HookLayer[];
      originalStatusCode?: number;
      originalStatusMessage?: string;
      originalHeaders?: http.IncomingHttpHeaders;
      originalBodyBuffer?: Buffer;
      originalContentType?: string | null;
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
      // 过滤掉私有 headers（x-proxy-* 前缀），这些只记录到数据库，不转发
      const forwardHeaders: http.OutgoingHttpHeaders = { ...stripPrivateHeaders(req.headers) };
      forwardHeaders.host = targetUrl.host;
      applyCustomHeaders(forwardHeaders, instanceHeaders);
      applyCustomHeaders(forwardHeaders, forwardRule.headers ?? null);

      let hookedMethod = method;
      let hookedTargetUrl = targetUrl;
      let hookedRequestBody = originalRequestBody;
      let hookedForwardHeaders: http.OutgoingHttpHeaders = { ...forwardHeaders };
      let hasRequestHookChanges = false;
      let requestHookLayers: HookLayer[] | undefined;

      if (hooksExecutor?.hasRequestHooks) {
        try {
          // 添加 proxy URL header，让插件知道如何发起回环请求（如心跳）
          const headersForHooks: Record<string, string | string[]> = {
            ...(hookedForwardHeaders as Record<string, string | string[]>),
            [HEADER_PROXY_URL]: requestUrl.href,
          };
          const hookExecResult = await hooksExecutor.executeRequestHooksWithLayers(
            {
              method,
              url: targetUrl.href,
              headers: headersForHooks,
              body: hookedRequestBody,
              signal: abortSignal,
            },
            (body) => body.length > 0 ? bufferToDataUrl(body, requestContentType) : null,
          );
          // 检查是否是 respondWith - 短路请求，直接返回响应
          if (hookExecResult.respondWith) {
            const { statusCode, headers, body } = hookExecResult.respondWith;
            res.writeHead(statusCode, headers as http.OutgoingHttpHeaders);
            if (body && body.length > 0) {
              res.end(body);
            } else {
              res.end();
            }
            return;
          }

          const hookResult = hookExecResult.params;
          hasRequestHookChanges = hookExecResult.hasChanges;
          requestHookLayers = hookExecResult.layers.length > 0 ? hookExecResult.layers : undefined;

          if (hasRequestHookChanges) {
            hookedMethod = hookResult.method;
            hookedTargetUrl = new URL(hookResult.url);
            hookedForwardHeaders = hookResult.headers as http.OutgoingHttpHeaders;
            hookedForwardHeaders.host = hookedTargetUrl.host;
            hookedRequestBody = Buffer.from(hookResult.body);
          }
        } catch (err) {
          console.error("[Hooks] Request hook error:", err);
        }
      }

      const hookedRequestBodyDataUrl =
        hookedRequestBody.length > 0
          ? bufferToDataUrl(hookedRequestBody, requestContentType)
          : null;

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
          forward_id: forwardRule.id,
          group_name: `${INSTANCE_NAME}/${forwardRule.name}`,
          status: "pending",
          abort_reason: null,
          is_websocket: false,
          websocket_direction: null,
          error_message: null,
          request: {
            method,
            url: requestUrl.href,
            headers: req.headers as Record<string, string | string[]>,
            forwardedHeaders: forwardHeaders as Record<string, string | string[]>,
            targetUrl: targetUrl.href,
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
          requestHookLayers,
          response: undefined,
        });
        // 注册到活跃请求 Map，支持外部中断
        activeRequests.set(dbRecordId, abortController);
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
        abortReason?: AbortReason;
        ttfbMs: number;
        bodyMs: number;
        hasResponseHookChanges?: boolean;
        responseHookLayers?: HookLayer[];
        originalStatusCode?: number;
        originalStatusMessage?: string;
        originalHeaders?: http.IncomingHttpHeaders;
        originalBodyBuffer?: Buffer;
        originalContentType?: string | null;
      }>((resolve, reject) => {
        // 检查是否已经被中断
        if (abortSignal.aborted) {
          reject(new ProxyRequestAbortedError(getAbortReasonFromSignal(abortSignal)));
          return;
        }

        let proxyResRef: http.IncomingMessage | null = null;
        const proxyReq = requestModule.request(
          {
            hostname: hookedTargetUrl.hostname,
            port: hookedTargetUrl.port || defaultPort,
            path: hookedTargetUrl.pathname + hookedTargetUrl.search,
            method: hookedMethod,
            headers: hookedForwardHeaders,
          },
          async (proxyRes) => {
            proxyResRef = proxyRes;
            // TTFB: 收到响应头的时间
            const responseStartTime = Date.now();
            const ttfbMs = responseStartTime - attemptStart;
            const responseChunks: Buffer[] = [];

            let responseHeaders = { ...proxyRes.headers };
            let statusCode = proxyRes.statusCode || 502;
            let statusMessage = proxyRes.statusMessage || "";

            // 如果存在 hooks，则必须缓存完整响应以支持修改，因此不允许直接流式写回客户端
            // 注意：直接检查配置而不是 hasResponseHooks，避免并发请求之间的 race condition
            const hasConfiguredHooks = !!(instanceHooks || forwardRule.hooks);
            const allowStreamingToClient = !hasConfiguredHooks;
            const isFailureStatus = statusCode >= 400 && statusCode <= 599;
            const hasMoreCandidates = i < candidateIndexes.length - 1;
            const shouldRetryOnFailure = isFailureStatus && hasMoreCandidates;
            const shouldStreamToClient = allowStreamingToClient && !shouldRetryOnFailure;

            // 流式进度更新（每秒最多更新一次）
            let totalReceivedBytes = 0;
            let lastProgressUpdate = 0;
            const PROGRESS_THROTTLE_MS = 1000;

            proxyRes.on("data", (chunk: Buffer) => {
              responseChunks.push(Buffer.from(chunk));
              totalReceivedBytes += chunk.length;

              const now = Date.now();
              if (dbRecordId !== null && now - lastProgressUpdate >= PROGRESS_THROTTLE_MS) {
                lastProgressUpdate = now;
                updateStreamingProgress(
                  dbRecordId,
                  totalReceivedBytes,
                  ttfbMs,
                  statusCode,
                  statusMessage,
                  responseHeaders as Record<string, string | string[]>,
                );
                dbNotifier.notify("update", "proxy_requests", dbRecordId);
              }
            });

            // 只在确定不会 failover，且不需要 response hooks 时，才把上游响应流式写回客户端
            if (shouldStreamToClient && !didStreamResponseToClient && !isClientDisconnected) {
              didStreamResponseToClient = true;
              const streamingHeaders = sanitizeResponseHeadersForStreaming(responseHeaders);
              res.writeHead(statusCode, statusMessage, streamingHeaders);
              proxyRes.pipe(res);
            }

            proxyRes.on("end", async () => {
              const bodyMs = Date.now() - responseStartTime;
              let bodyBuffer = Buffer.concat(responseChunks);
              let contentType = (responseHeaders["content-type"] as string) ?? null;

              // 保存原始响应数据（用于与 hooked 对比）
              const originalStatusCode = statusCode;
              const originalStatusMessage = statusMessage;
              const originalHeaders = { ...responseHeaders };
              const originalBodyBuffer = bodyBuffer;
              const originalContentType = contentType;
              let hasResponseHookChanges = false;
              let responseHookLayers: HookLayer[] | undefined;

              if (hooksExecutor?.hasResponseHooks) {
                try {
                  const hookExecResult = await hooksExecutor.executeResponseHooksWithLayers(
                    {
                      statusCode,
                      statusMessage,
                      headers: responseHeaders as Record<string, string | string[]>,
                      body: bodyBuffer,
                      signal: abortSignal,
                      // 传递请求元数据给响应 hooks
                      requestMeta: {
                        method: hookedMethod,
                        url: hookedTargetUrl.href,
                        headers: hookedForwardHeaders as Record<string, string | string[]>,
                      },
                    },
                    (body) => body.length > 0 ? bufferToDataUrl(body, contentType) : null,
                    (headers) => (headers["content-type"] as string) ?? null,
                  );
                  const hookResult = hookExecResult.params;
                  hasResponseHookChanges = hookExecResult.hasChanges;
                  responseHookLayers = hookExecResult.layers.length > 0 ? hookExecResult.layers : undefined;

                  if (hasResponseHookChanges) {
                    statusCode = hookResult.statusCode;
                    statusMessage = hookResult.statusMessage;
                    responseHeaders = hookResult.headers as http.IncomingHttpHeaders;
                    bodyBuffer = Buffer.from(hookResult.body);
                  }
                  contentType = (responseHeaders["content-type"] as string) ?? contentType;
                } catch (err) {
                  console.error("[Hooks] Response hook error:", err);
                }
              }

              const cleanedHeaders = sanitizeResponseHeadersForBuffered(responseHeaders, bodyBuffer.length);

              resolve({
                statusCode,
                statusMessage,
                headers: cleanedHeaders,
                bodyBuffer,
                contentType,
                ttfbMs,
                bodyMs,
                // 原始响应数据（如果有 hook 变更）
                hasResponseHookChanges,
                responseHookLayers,
                originalStatusCode: hasResponseHookChanges ? originalStatusCode : undefined,
                originalStatusMessage: hasResponseHookChanges ? originalStatusMessage : undefined,
                originalHeaders: hasResponseHookChanges ? originalHeaders : undefined,
                originalBodyBuffer: hasResponseHookChanges ? originalBodyBuffer : undefined,
                originalContentType: hasResponseHookChanges ? originalContentType : undefined,
              });
            });

            // 响应流传输过程中出错（如上游中途断开），error 和 end 互斥，必须处理
            proxyRes.on("error", (error) => {
              const errorTtfb = Date.now() - attemptStart;
              const errorBody = Buffer.from(
                JSON.stringify({
                  error: "上游响应流错误",
                  message: error.message,
                }),
              );
              // 如果已经开始流式写回，则无法再发送一个 502 body，只能直接断开下游连接
              if (didStreamResponseToClient && !res.writableEnded) {
                res.destroy(error);
              }
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
                bodyMs: 0,
              });
            });
          },
        );

        const cleanup = () => {
          abortSignal.removeEventListener("abort", handleAbort);
        };

        proxyReq.on("error", (error) => {
          cleanup();
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
            bodyMs: 0,
          });
        });

        // 监听 abort 信号，中断代理请求
        const handleAbort = () => {
          const abortReason = getAbortReasonFromSignal(abortSignal);
          proxyReq.destroy();
          proxyResRef?.destroy();
          // 如果已经开始写回给客户端，需要及时关闭下游连接，避免悬挂
          if (didStreamResponseToClient && !res.writableEnded) {
            res.destroy();
          }
          cleanup();
          reject(new ProxyRequestAbortedError(abortReason));
        };
        abortSignal.addEventListener("abort", handleAbort);

        // 如果在绑定 listener 之前就已触发 abort，确保立刻中断
        if (abortSignal.aborted) {
          handleAbort();
          return;
        }

        if (hookedRequestBody.length > 0) proxyReq.write(hookedRequestBody);
        proxyReq.end();
      }).catch((err) => {
        // 处理中断异常
        if (err instanceof ProxyRequestAbortedError) {
          const statusMessage =
            err.abortReason === USER_ABORT ? "User Aborted Request" : "Client Closed Request";
          const errorMessage =
            err.abortReason === USER_ABORT ? "Request aborted by user" : "Client disconnected";
          return {
            statusCode: 499,
            statusMessage,
            headers: {} as http.OutgoingHttpHeaders,
            bodyBuffer: Buffer.alloc(0),
            contentType: null,
            errorMessage,
            abortReason: err.abortReason,
            ttfbMs: Date.now() - attemptStart,
            bodyMs: 0,
          };
        }
        throw err;
      });

      const wasAborted = attemptResult.abortReason !== undefined;

      // 上报统计数据
      const isFailureStatus = attemptResult.statusCode >= 400 && attemptResult.statusCode <= 599;
      const success = !attemptResult.errorMessage && !isFailureStatus;

      if (!wasAborted) {
        forwardStatsStore.sendReport(forwardRule.id, startTime, attemptResult.ttfbMs, success);
      }

      finalResult = {
        ...attemptResult,
        forwardRule,
      };

      if (wasAborted) {
        break;
      }

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

    // 构建响应体 data URL
    const responseBodyDataUrl =
      finalResult.bodyBuffer.length > 0
        ? bufferToDataUrl(finalResult.bodyBuffer, finalResult.contentType ?? undefined)
        : null;

    // 如果有 response hook 变更，保存原始响应和 hooked 响应
    const originalResponseBodyDataUrl =
      finalResult.hasResponseHookChanges && finalResult.originalBodyBuffer
        ? finalResult.originalBodyBuffer.length > 0
          ? bufferToDataUrl(finalResult.originalBodyBuffer, finalResult.originalContentType ?? undefined)
          : null
        : null;

    const isRequestAborted = finalResult.abortReason !== undefined;
    updateProxyRequest(dbRecordId, {
      status: isRequestAborted ? "aborted" : finalResult.errorMessage ? "error" : "completed",
      abort_reason: isRequestAborted ? finalResult.abortReason! : null,
      error_message: finalResult.errorMessage ?? null,
      forward_name: finalResult.forwardRule.name,
      // 原始响应（如果有 hook 则是原始数据，否则就是最终数据）
      response: finalResult.hasResponseHookChanges
        ? {
            statusCode: finalResult.originalStatusCode!,
            statusMessage: finalResult.originalStatusMessage!,
            headers: finalResult.originalHeaders as Record<string, string | string[]>,
            bodyDataUrl: originalResponseBodyDataUrl,
            bodySize: finalResult.originalBodyBuffer?.length ?? 0,
            ttfbMs: finalResult.ttfbMs,
            bodyMs: finalResult.bodyMs,
            contentType: finalResult.originalContentType ?? null,
          }
        : {
            statusCode: finalResult.statusCode,
            statusMessage: finalResult.statusMessage,
            headers: finalResult.headers as Record<string, string | string[]>,
            bodyDataUrl: responseBodyDataUrl,
            bodySize: finalResult.bodyBuffer.length,
            ttfbMs: finalResult.ttfbMs,
            bodyMs: finalResult.bodyMs,
            contentType: finalResult.contentType ?? null,
          },
      // Hooked 响应（仅当有变更时）
      hookedResponse: finalResult.hasResponseHookChanges
        ? {
            statusCode: finalResult.statusCode,
            statusMessage: finalResult.statusMessage,
            headers: finalResult.headers as Record<string, string | string[]>,
            bodyDataUrl: responseBodyDataUrl,
            bodySize: finalResult.bodyBuffer.length,
            ttfbMs: finalResult.ttfbMs,
            bodyMs: finalResult.bodyMs,
            contentType: finalResult.contentType ?? null,
          }
        : undefined,
      responseHookLayers: finalResult.responseHookLayers,
    });
    dbNotifier.notify("update", "proxy_requests", dbRecordId);

    // 清理活跃请求 Map
    activeRequests.delete(dbRecordId);

    // 如果已经被中断，不再发送响应
    if (isClientDisconnected) {
      return;
    }

    // 如果上游响应已经在请求过程中被流式写回，则这里不再重复发送
    if (didStreamResponseToClient) {
      return;
    }

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

    handleWebSocketProxy(req, socket, head, targetUrl, INSTANCE_NAME, matched.rule.name, matched.rule.id);
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
  forwardStatsStore.init();

  // 注册 server 到 globalThis，以便 shutdown 消息处理可以访问
  globalThis.__proxyServer = server;

  server.listen(PROXY_PORT, () => {
    console.log(`Proxy running on http://localhost:${PROXY_PORT} (instance: ${INSTANCE_NAME})`);
  });

  // 优雅关闭：当 Worker 被 terminate 时，关闭 server 并释放端口
  process.on("SIGTERM", () => {
    log.info(`[Shutdown] Received SIGTERM, closing server...`);
    server.close(() => {
      log.info(`[Shutdown] Server closed`);
      process.exit(0);
    });
  });

  process.on("SIGINT", () => {
    log.info(`[Shutdown] Received SIGINT, closing server...`);
    server.close(() => {
      log.info(`[Shutdown] Server closed`);
      process.exit(0);
    });
  });
}

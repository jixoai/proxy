import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import * as fs from "node:fs";
import { URL } from "node:url";
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
import type { HooksConfig } from "./types/proxy";
import type {
  WorkerMessage,
  WorkerResponse,
  InstanceRuntimeConfig,
} from "./types/worker-messages";
import { normalizeForwardGroups, normalizePathname } from "./lib/forward-utils";
import { createLogger, installGlobalErrorLogger } from "./lib/logger";
import { forwardStatsStore } from "./lib/forward-stats";

const PRIVATE_HEADER_PREFIX = "-x-jixo-proxy-";

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
      forwards.forEach((f, idx) => {
        log.info(`[Config]   [${idx}] ${f.name}: enabled=${f.enabled}, path=${f.path || "(default)"}`);
      });

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

  async function reloadConfig(newConfig: InstanceRuntimeConfig): Promise<void> {
    log.info(`[Reload] Applying new config for "${INSTANCE_NAME}"...`);

    if (hooksExecutor) {
      await hooksExecutor.stop();
      hooksExecutor = null;
    }

    instanceHeaders = newConfig.headers;
    instanceHooks = newConfig.hooks;
    forwards = normalizeForwardGroups(newConfig.forwards.filter((f) => f));

    if (instanceHooks || forwards.some((f) => f.hooks)) {
      hooksExecutor = new HooksExecutor(INSTANCE_NAME, instanceHooks);
      await hooksExecutor.start();
    }

    const enabledCount = forwards.filter((f) => f.enabled).length;
    log.info(
      `[Reload] Config updated: ${forwards.length} forward rules (${enabledCount} enabled)`,
    );
  }

  if (parentPort) {
    parentPort.addEventListener("message", async (event) => {
      const message: WorkerMessage = event.data;
      try {
        switch (message.type) {
          case "init": {
            setDataDir(message.dataDir);
            await initDatabase();
            parentPort.postMessage({ type: "init-result", success: true });
            log.info(`[Init] Database initialized with dataDir: ${message.dataDir}`);
            break;
          }
          case "reload": {
            await reloadConfig(message.config);
            parentPort.postMessage({ type: "reload-result", success: true });
            break;
          }
          case "get-config": {
            parentPort.postMessage({ type: "config", config: getCurrentConfig() });
            break;
          }
          case "ping": {
            parentPort.postMessage({ type: "pong" });
            break;
          }
          case "abort-request": {
            const controller = activeRequests.get(message.dbRecordId);
            if (controller) {
              controller.abort(USER_ABORT);
              log.info(`[Abort] Request #${message.dbRecordId} aborted by user`);
            }
            parentPort.postMessage({
              type: "abort-result",
              success: !!controller,
              dbRecordId: message.dbRecordId,
            });
            break;
          }
          case "shutdown": {
            log.info(`[Shutdown] Received shutdown message, closing server...`);
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

        if (message.type === "init") {
          parentPort.postMessage({ type: "init-result", success: false, error: errorMessage });
        } else if (message.type === "reload") {
          parentPort.postMessage({ type: "reload-result", success: false, error: errorMessage });
        } else if (message.type === "abort-request") {
          parentPort.postMessage({ type: "abort-result", success: false, dbRecordId: message.dbRecordId });
        } else {
          parentPort.postMessage({ type: "server-error", error: errorMessage, stack, port: Number(PROXY_PORT) });
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

  function matchForwardRule(requestMethod: string, pathname: string): { rule: ForwardRule; index: number } | null {
    if (forwards.length === 0) return null;
    const normalizedPath = normalizePathname(pathname);
    const method = (requestMethod || "GET").toUpperCase();

    let fallback: { rule: ForwardRule; index: number } | null = null;
    for (let idx = 0; idx < forwards.length; idx++) {
      const rule = forwards[idx]!;
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
      finalPath = suffix === "/" ? targetBase.pathname || "/" : joinPaths(targetBase.pathname || "/", suffix);
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

  function applyCustomHeaders(headers: http.OutgoingHttpHeaders, additions: Record<string, string> | null | undefined): void {
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
  const activeRequests = new Map<number, AbortController>();

  const hopByHopHeaders = [
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
  ];

  function sanitizeHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
    const clean: http.OutgoingHttpHeaders = { ...headers };
    for (const key of hopByHopHeaders) {
      delete (clean as Record<string, unknown>)[key];
    }
    return clean;
  }

  async function forwardViaProxy(
    proxyUrl: string,
    method: string,
    targetUrl: URL,
    headers: http.OutgoingHttpHeaders,
    body: Buffer,
    signal: AbortSignal,
  ): Promise<http.IncomingMessage> {
    const proxy = new URL(proxyUrl);
    const isTargetHttps = targetUrl.protocol === "https:";

    const outHeaders: http.OutgoingHttpHeaders = { ...headers };
    outHeaders.host = targetUrl.host;
    if (body.length > 0) {
      outHeaders["content-length"] = body.length;
    }

    const proxyPort = proxy.port ? parseInt(proxy.port, 10) : 80;

    if (isTargetHttps) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(new ProxyRequestAbortedError(getAbortReasonFromSignal(signal)));
          return;
        }

        const connectReq = http.request({
          hostname: proxy.hostname,
          port: proxyPort,
          method: "CONNECT",
          path: `${targetUrl.hostname}:${targetUrl.port || 443}`,
        });

        const handleAbort = () => {
          connectReq.destroy();
          reject(new ProxyRequestAbortedError(getAbortReasonFromSignal(signal)));
        };
        signal.addEventListener("abort", handleAbort, { once: true });

        connectReq.on("connect", (res, socket) => {
          signal.removeEventListener("abort", handleAbort);
          if (res.statusCode !== 200) {
            reject(new Error(`CONNECT failed: ${res.statusCode}`));
            return;
          }

          const targetPort = targetUrl.port ? parseInt(targetUrl.port, 10) : 443;
          const tlsSocket = tls.connect({
            host: targetUrl.hostname,
            port: targetPort,
            socket,
            servername: targetUrl.hostname,
          }, () => {
            // Manually write HTTP request over TLS socket
            const requestLine = `${method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n`;
            const headerLines: string[] = [];
            for (const [key, value] of Object.entries(outHeaders)) {
              if (Array.isArray(value)) {
                for (const v of value) {
                  headerLines.push(`${key}: ${v}`);
                }
              } else if (value !== undefined) {
                headerLines.push(`${key}: ${value}`);
              }
            }
            const httpRequest = requestLine + headerLines.join("\r\n") + "\r\n\r\n";
            
            const handleAbort2 = () => {
              tlsSocket.destroy();
              reject(new ProxyRequestAbortedError(getAbortReasonFromSignal(signal)));
            };
            signal.addEventListener("abort", handleAbort2, { once: true });

            tlsSocket.write(httpRequest);
            if (body.length > 0) {
              tlsSocket.write(body);
            }

            // Parse HTTP response from TLS socket
            let responseData = Buffer.alloc(0);
            let headersParsed = false;
            let incomingMessage: http.IncomingMessage | null = null;

            tlsSocket.on("data", (chunk: Buffer) => {
              responseData = Buffer.concat([responseData, chunk]);
              
              if (!headersParsed) {
                const headerEnd = responseData.indexOf("\r\n\r\n");
                if (headerEnd !== -1) {
                  headersParsed = true;
                  signal.removeEventListener("abort", handleAbort2);
                  const headerPart = responseData.subarray(0, headerEnd).toString();
                  const bodyPart = responseData.subarray(headerEnd + 4);
                  
                  const lines = headerPart.split("\r\n");
                  const statusLine = lines[0] || "";
                  const statusMatch = statusLine.match(/HTTP\/\d\.\d (\d+) (.*)/);
                  const statusCode = statusMatch ? parseInt(statusMatch[1]!, 10) : 502;
                  const statusMessage = statusMatch ? statusMatch[2]! : "";
                  
                  const responseHeaders: http.IncomingHttpHeaders = {};
                  for (let i = 1; i < lines.length; i++) {
                    const colonIdx = lines[i]!.indexOf(":");
                    if (colonIdx > 0) {
                      const key = lines[i]!.substring(0, colonIdx).toLowerCase();
                      const value = lines[i]!.substring(colonIdx + 1).trim();
                      responseHeaders[key] = value;
                    }
                  }

                  const { Readable } = require("stream") as typeof import("stream");
                  const bodyStream = new Readable({ read() {} });
                  
                  incomingMessage = Object.assign(bodyStream, {
                    statusCode,
                    statusMessage,
                    headers: responseHeaders,
                    headersDistinct: {},
                    httpVersion: "1.1",
                    httpVersionMajor: 1,
                    httpVersionMinor: 1,
                    complete: false,
                    rawHeaders: [],
                    trailers: {},
                    trailersDistinct: {},
                    rawTrailers: [],
                    socket: tlsSocket,
                    connection: tlsSocket,
                    aborted: false,
                    url: "",
                    method: null,
                    setTimeout: () => bodyStream,
                  }) as unknown as http.IncomingMessage;

                  if (bodyPart.length > 0) {
                    bodyStream.push(bodyPart);
                  }
                  
                  resolve(incomingMessage);
                }
              } else if (incomingMessage) {
                (incomingMessage as any).push(chunk);
              }
            });

            tlsSocket.on("end", () => {
              if (incomingMessage) {
                (incomingMessage as any).push(null);
              }
            });

            tlsSocket.on("error", (err) => {
              signal.removeEventListener("abort", handleAbort2);
              reject(err);
            });
          });

          tlsSocket.on("error", reject);
        });

        connectReq.on("error", reject);
        connectReq.end();
      });
    } else {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(new ProxyRequestAbortedError(getAbortReasonFromSignal(signal)));
          return;
        }

        const req = http.request({
          hostname: proxy.hostname,
          port: proxyPort,
          path: targetUrl.href,
          method,
          headers: outHeaders,
        }, resolve);

        const handleAbort = () => {
          req.destroy();
          reject(new ProxyRequestAbortedError(getAbortReasonFromSignal(signal)));
        };
        signal.addEventListener("abort", handleAbort, { once: true });
        req.on("error", (err) => {
          signal.removeEventListener("abort", handleAbort);
          reject(err);
        });
        if (body.length > 0) req.write(body);
        req.end();
      });
    }
  }

  async function forwardDirect(
    method: string,
    targetUrl: URL,
    headers: http.OutgoingHttpHeaders,
    body: Buffer,
    signal: AbortSignal,
  ): Promise<http.IncomingMessage> {
    const isHttps = targetUrl.protocol === "https:";
    const requestModule = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;

    const outHeaders: http.OutgoingHttpHeaders = { ...headers };
    outHeaders.host = targetUrl.host;
    if (body.length > 0) {
      outHeaders["content-length"] = body.length;
    }

    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new ProxyRequestAbortedError(getAbortReasonFromSignal(signal)));
        return;
      }

      const req = requestModule.request({
        hostname: targetUrl.hostname,
        port: targetUrl.port || defaultPort,
        path: targetUrl.pathname + targetUrl.search,
        method,
        headers: outHeaders,
      }, resolve);

      const handleAbort = () => {
        req.destroy();
        reject(new ProxyRequestAbortedError(getAbortReasonFromSignal(signal)));
      };
      signal.addEventListener("abort", handleAbort, { once: true });
      req.on("error", (err) => {
        signal.removeEventListener("abort", handleAbort);
        reject(err);
      });
      if (body.length > 0) req.write(body);
      req.end();
    });
  }

  const server = http.createServer(async (req, res) => {
    const startTime = Date.now();
    const requestId = `${++requestCounter}`;
    const timestamp = new Date().toISOString();

    const abortController = new AbortController();
    const { signal: abortSignal } = abortController;
    let isClientDisconnected = false;

    const handleClientClose = () => {
      if (!res.writableEnded && !isClientDisconnected) {
        if (abortSignal.aborted && getAbortReasonFromSignal(abortSignal) === USER_ABORT) return;
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

    const forwardRule = matched.rule;

    // 设置 forward hooks（重建 hop 链）
    if (hooksExecutor && (instanceHooks || forwardRule.hooks)) {
      try {
        await hooksExecutor.setForwardHooks(forwardRule.name, forwardRule.hooks ?? null);
      } catch (err) {
        console.error("[Hooks] Failed to set forward hooks:", err);
      }
    }

    const targetUrl = buildTargetUrl(forwardRule, requestUrl);
    const forwardHeaders: http.OutgoingHttpHeaders = { ...stripPrivateHeaders(req.headers) };
    forwardHeaders.host = targetUrl.host;
    applyCustomHeaders(forwardHeaders, instanceHeaders);
    applyCustomHeaders(forwardHeaders, forwardRule.headers ?? null);

    const requestBodyChunks: Buffer[] = [];
    for await (const chunk of req) {
      requestBodyChunks.push(chunk as Buffer);
    }
    const requestBody = Buffer.concat(requestBodyChunks);
    const requestContentType = (req.headers["content-type"] as string) || null;
    const requestBodyDataUrl = requestBody.length > 0
      ? bufferToDataUrl(requestBody, requestContentType)
      : null;

    const dbRecordId = createProxyRequest({
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
        bodyDataUrl: requestBodyDataUrl,
        bodySize: requestBody.length,
      },
      response: undefined,
    });

    activeRequests.set(dbRecordId, abortController);
    debugNotifier("about to notify insert, dbRecordId: %d", dbRecordId);
    dbNotifier.notify("insert", "requests", dbRecordId);

    const attemptStart = Date.now();
    let proxyResponse: http.IncomingMessage;

    try {
      const pluginProxyUrl = hooksExecutor?.getFirstPluginUrl();

      if (pluginProxyUrl) {
        // 通过插件链转发
        proxyResponse = await forwardViaProxy(
          pluginProxyUrl,
          method,
          targetUrl,
          forwardHeaders,
          requestBody,
          abortSignal,
        );
      } else {
        // 直连
        proxyResponse = await forwardDirect(
          method,
          targetUrl,
          forwardHeaders,
          requestBody,
          abortSignal,
        );
      }
    } catch (error) {
      const ttfbMs = Date.now() - attemptStart;
      let statusCode = 502;
      let errorMessage = error instanceof Error ? error.message : String(error);
      let abortReason: AbortReason | undefined;

      if (error instanceof ProxyRequestAbortedError) {
        statusCode = 499;
        abortReason = error.abortReason;
        errorMessage = abortReason === USER_ABORT ? "Request aborted by user" : "Client disconnected";
      }

      updateProxyRequest(dbRecordId, {
        status: abortReason ? "aborted" : "error",
        abort_reason: abortReason ?? null,
        error_message: errorMessage,
        response: {
          statusCode,
          statusMessage: abortReason ? "Aborted" : "Bad Gateway",
          headers: {},
          bodyDataUrl: null,
          bodySize: 0,
          ttfbMs,
          bodyMs: 0,
          contentType: null,
        },
      });
      dbNotifier.notify("update", "requests", dbRecordId);
      activeRequests.delete(dbRecordId);

      if (!isClientDisconnected && !res.headersSent) {
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errorMessage }));
      }
      return;
    }

    const ttfbMs = Date.now() - attemptStart;
    const statusCode = proxyResponse.statusCode || 502;
    const statusMessage = proxyResponse.statusMessage || "";
    const responseHeaders = sanitizeHeaders(proxyResponse.headers);
    const contentType = (proxyResponse.headers["content-type"] as string) ?? null;

    res.writeHead(statusCode, statusMessage, responseHeaders);

    const responseChunks: Buffer[] = [];
    let totalReceivedBytes = 0;
    let lastProgressUpdate = 0;
    const PROGRESS_THROTTLE_MS = 1000;

    proxyResponse.on("data", (chunk: Buffer) => {
      responseChunks.push(chunk);
      totalReceivedBytes += chunk.length;
      res.write(chunk);

      const now = Date.now();
      if (now - lastProgressUpdate >= PROGRESS_THROTTLE_MS) {
        lastProgressUpdate = now;
        updateStreamingProgress(
          dbRecordId,
          totalReceivedBytes,
          ttfbMs,
          statusCode,
          statusMessage,
          proxyResponse.headers as Record<string, string | string[]>,
        );
        dbNotifier.notify("update", "requests", dbRecordId);
      }
    });

    proxyResponse.on("end", () => {
      res.end();
      const bodyMs = Date.now() - attemptStart - ttfbMs;
      const responseBody = Buffer.concat(responseChunks);
      const responseBodyDataUrl = responseBody.length > 0
        ? bufferToDataUrl(responseBody, contentType)
        : null;

      updateProxyRequest(dbRecordId, {
        status: "completed",
        abort_reason: null,
        error_message: null,
        response: {
          statusCode,
          statusMessage,
          headers: proxyResponse.headers as Record<string, string | string[]>,
          bodyDataUrl: responseBodyDataUrl,
          bodySize: responseBody.length,
          ttfbMs,
          bodyMs,
          contentType,
        },
      });
      dbNotifier.notify("update", "requests", dbRecordId);
      activeRequests.delete(dbRecordId);

      const isFailure = statusCode >= 400;
      forwardStatsStore.sendReport(forwardRule.id, startTime, ttfbMs, !isFailure);
    });

    proxyResponse.on("error", (error) => {
      const bodyMs = Date.now() - attemptStart - ttfbMs;
      if (!res.writableEnded) {
        res.destroy(error);
      }
      updateProxyRequest(dbRecordId, {
        status: "error",
        abort_reason: null,
        error_message: error.message,
        response: {
          statusCode: 502,
          statusMessage: "Bad Gateway",
          headers: {},
          bodyDataUrl: null,
          bodySize: 0,
          ttfbMs,
          bodyMs,
          contentType: null,
        },
      });
      dbNotifier.notify("update", "requests", dbRecordId);
      activeRequests.delete(dbRecordId);
    });
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
  globalThis.__proxyServer = server;

  server.listen(PROXY_PORT, () => {
    console.log(`Proxy running on http://localhost:${PROXY_PORT} (instance: ${INSTANCE_NAME})`);
  });

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

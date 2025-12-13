import { serve, type ServerWebSocket } from "bun";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import createDebug from "debug";
import viewerHtml from "./viewer.html";
import { codeToHtml } from "shiki";
import type { HighlightRequest, HighlightResponse } from "./services/highlight.protocol";
import { formatCode, type FormatRequest, type FormatResponse } from "./lib/biome-formatter";
import { decompressData, type DecompressRequest, type DecompressResponse } from "./lib/decompress";
import type { ProxyLogMessage } from "./lib/proxy-manager";
import type { ProxyInstancesManager } from "./proxy-instances-manager";
import { db } from "./lib/db";
import type { ProxyForwardConfig } from "./types/proxy";
import {
  getAllInstances,
  getInstanceByName,
  getConfigFilePath,
  loadConfig,
  saveConfig,
} from "./lib/config-store";
import {
  getAllRequests as dbGetAllRequests,
  getProxyRequestById,
  getRequestsAfterId,
  clearAllRequests as dbClearAllRequests,
  deleteProxyRequest as dbDeleteProxyRequest,
  requestEvents,
  type LoggedRequest,
} from "./lib/db-requests";
import { dbListener } from "./lib/db-notifier";
import { bufferToDataUrl, dataUrlToBuffer, isDataUrl } from "./lib/data-url";
import { extractContentTypeFromHeaders, isTextLikeMime } from "./lib/http-utils";
import { createLogger, installGlobalErrorLogger } from "./lib/logger";
import { forwardStatsManager } from "./lib/forward-stats-manager";
import { reorderForwardsByIndexes as reorderForwardsByIndexesDirect } from "./lib/config-store";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROXY_DIR = path.join(__dirname, ".tmp", "proxy");
const log = createLogger("proxy:viewer");
const debugAutoSort = createDebug("plugins:auto-sort");
installGlobalErrorLogger("proxy-viewer");

interface RequestData {
  id: string;
  folderName: string;
  metadata: any;
  requestContent?: string;
  responseContent?: string;
  requestBody?: string;
  responseBody?: string;
  hookedRequestContent?: string;
  hookedRequestBody?: string;
}

function coerceBodyDataUrl(
  body: string | Buffer | Uint8Array | null,
  mime?: string | null,
): string | null {
  if (!body) return null;
  if (typeof body === "string") {
    return isDataUrl(body) ? body : bufferToDataUrl(Buffer.from(body, "utf-8"), mime);
  }
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return bufferToDataUrl(buffer, mime);
}

function formatProxyRequest(req: LoggedRequest): RequestData {
  const hasHookedRequest = !!req.hookedRequest;

  return {
    id: (req.id ?? req.request_id).toString(),
    folderName: `${req.request_id}_${new Date(req.timestamp).toISOString().replace(/[:.]/g, "-")}`,
    metadata: {
      timestamp: req.timestamp,
      duration: req.response ? `${req.response.durationMs}ms` : "0ms",
      instanceName: req.instance_name,
      forwardName: req.forward_name,
      status: req.status,
      isWebSocket: req.is_websocket,
      websocketDirection: req.websocket_direction,
      errorMessage: req.error_message,
      targetUrl: hasHookedRequest ? req.hookedRequest!.url : req.request.url,
      originUrl: req.request.url,
      forwardedHeaders: req.request.forwardedHeaders,
      request: {
        method: req.request.method,
        url: req.request.url,
        headersCount: Object.keys(req.request.headers ?? {}).length,
        bodySize: req.request.bodySize,
      },
      response: req.response
        ? {
            statusCode: req.response.statusCode,
            statusMessage: req.response.statusMessage,
            headersCount: Object.keys(req.response.headers ?? {}).length,
            bodySize: req.response.bodySize,
          }
        : null,
      hasHookedRequest,
      hookedRequest: hasHookedRequest
        ? {
            method: req.hookedRequest!.method,
            url: req.hookedRequest!.url,
            headersCount: Object.keys(req.hookedRequest!.headers ?? {}).length,
            bodySize: req.hookedRequest!.bodySize,
          }
        : undefined,
    },
  };
}

function getAllRequests(): RequestData[] {
  const requests = dbGetAllRequests();
  return requests.map(formatProxyRequest);
}

function getAllRequestsFiltered(filters?: {
  forward_name?: string | null;
  method?: string;
  status_code?: number;
  url_pattern?: string;
}): RequestData[] {
  const requests = dbGetAllRequests(filters);
  return requests.map(formatProxyRequest);
}

/**
 * 启动 Viewer Server
 * @param manager ProxyInstancesManager 实例
 * @param port 监听端口
 * @returns Bun Server 实例
 */
export function startViewerServer(manager: ProxyInstancesManager, port: number) {
  const wsClients = new Set<ServerWebSocket<unknown>>();
  const logClients = new Set<ServerWebSocket<unknown>>();
  const statsClients = new Set<ServerWebSocket<unknown>>();
  let configWatcher: fs.FSWatcher | null = null;
  let watchDebounce: NodeJS.Timeout | null = null;
  let watchEnabled = false;

  forwardStatsManager.init();

  const broadcastStats = () => {
    if (statsClients.size === 0) return;
    const stats = forwardStatsManager.getAllStats();
    const message = JSON.stringify({ type: "stats-update", stats });
    for (const client of statsClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error("Failed to send stats to client:", error);
        statsClients.delete(client);
      }
    }
  };

  forwardStatsManager.on("stats-updated", () => {
    broadcastStats();
  });

  forwardStatsManager.on(
    "auto-sort-needed",
    async ({ instanceName, forwardName }: { instanceName: string; forwardName: string }) => {
      log.info(`[AutoSort] Auto-sort triggered for ${instanceName}/${forwardName}`);

      const instance = getInstanceByName(instanceName);
      if (!instance) {
        log.warn(`[AutoSort] Instance not found: ${instanceName}`);
        return;
      }

      const currentIndexes: number[] = [];
      instance.forwards.forEach((f, idx) => {
        if (f.name === forwardName) {
          currentIndexes.push(idx);
        }
      });

      if (currentIndexes.length < 2) {
        log.info(`[AutoSort] Only ${currentIndexes.length} endpoints for ${forwardName}, skipping`);
        return;
      }

      const newOrder = forwardStatsManager.computeOptimalOrder(
        instanceName,
        forwardName,
        currentIndexes,
      );

      if (!newOrder) {
        log.info(`[AutoSort] No reordering needed for ${instanceName}/${forwardName}`);
        return;
      }

      log.info(
        `[AutoSort] Reordering ${instanceName}/${forwardName}: [${currentIndexes.join(",")}] -> [${newOrder.join(",")}]`,
      );

      const fullNewOrder = instance.forwards.map((_, idx) => {
        const groupIdx = currentIndexes.indexOf(idx);
        if (groupIdx >= 0) {
          return newOrder[groupIdx]!;
        }
        return idx;
      });

      try {
        reorderForwardsByIndexesDirect(instanceName, fullNewOrder as number[]);
      } catch (error) {
        debugAutoSort("Failed to reorder: %s", error);
        return;
      }

      try {
        await manager.reloadInstance(instanceName);
        log.info(`[AutoSort] Instance ${instanceName} reloaded successfully`);
      } catch (error) {
        debugAutoSort("Failed to reload instance: %s", error);
        return;
      }

      const message = JSON.stringify({ type: "config-changed" });
      for (const client of wsClients) {
        try {
          client.send(message);
        } catch (error) {
          wsClients.delete(client);
        }
      }
    },
  );

  manager.onLog((logMsg: ProxyLogMessage) => {
    const message = JSON.stringify(logMsg);
    for (const client of logClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error("Failed to send log to client:", error);
        logClients.delete(client);
      }
    }
  });

  const OLD_PROXY_DIR = path.join(__dirname, ".tmp", "proxy");
  if (fs.existsSync(OLD_PROXY_DIR)) {
    try {
      fs.rmSync(OLD_PROXY_DIR, { recursive: true, force: true });
      log.info("[Cleanup] Removed old filesystem request records");
    } catch (error) {
      console.error("[Cleanup] Failed to remove old records:", error);
    }
  }

  const reloadInstancesFromConfig = async () => {
    const result = {
      reloaded: [] as string[],
      failed: [] as Array<{ name: string; error: string }>,
    };
    loadConfig();
    const running = manager.getRunningInstanceNames();
    for (const name of running) {
      try {
        await manager.reloadInstance(name);
        result.reloaded.push(name);
      } catch (error) {
        result.failed.push({ name, error: String(error) });
      }
    }

    const message = JSON.stringify({ type: "config-changed" });
    for (const client of wsClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error("Failed to send config-changed to client:", error);
        wsClients.delete(client);
      }
    }

    return result;
  };

  const enableConfigWatch = () => {
    if (configWatcher) return;
    const configFile = getConfigFilePath();
    configWatcher = fs.watch(configFile, () => {
      if (watchDebounce) {
        clearTimeout(watchDebounce);
      }
      watchDebounce = setTimeout(async () => {
        log.info("[Reload] Detected config change, applying reload...");
        try {
          await reloadInstancesFromConfig();
        } catch (error) {
          console.error("[Reload] Failed to apply config reload:", error);
        }
      }, 300);
    });
    watchEnabled = true;
    log.info(`[Reload] Watching config file: ${configFile}`);
  };

  const disableConfigWatch = () => {
    if (configWatcher) {
      configWatcher.close();
      configWatcher = null;
    }
    if (watchDebounce) {
      clearTimeout(watchDebounce);
      watchDebounce = null;
    }
    watchEnabled = false;
    log.info("[Reload] Stopped watching config file");
  };

  const initialConfig = loadConfig();
  if (initialConfig.settings?.autoWatchConfig) {
    enableConfigWatch();
  }
  for (const instance of initialConfig.instances) {
    if (instance.settings?.autoSortSameNameForwards) {
      forwardStatsManager.setAutoSortSameNameForwardsEnabled(instance.name, true);
    }
  }

  function getRequestDetail(id: number): RequestData | null {
    const req = getProxyRequestById(id);
    if (!req) return null;

    const formatted = formatProxyRequest(req);

    const requestHeaders = req.request.headers ?? {};
    formatted.requestContent =
      `# 请求信息\n\n` +
      `- **时间**: ${req.timestamp}\n` +
      `- **方法**: ${req.request.method}\n` +
      `- **URL**: ${req.request.url}\n\n` +
      `## 请求头\n\n\`\`\`\n${Object.entries(requestHeaders)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")}\n\`\`\`\n\n`;

    const requestContentType = extractContentTypeFromHeaders(requestHeaders);
    const requestBodyDataUrl = coerceBodyDataUrl(req.request.bodyDataUrl, requestContentType);

    if (requestBodyDataUrl) {
      const { mime, buffer } = dataUrlToBuffer(requestBodyDataUrl);
      const isText = isTextLikeMime(mime);
      formatted.requestContent += `## 请求体\n\n大小: ${req.request.bodySize} bytes\n\n`;
      if (isText) {
        formatted.requestContent += `\`\`\`\n${buffer.toString("utf-8")}\n\`\`\`\n`;
      } else {
        formatted.requestContent += `二进制数据 (${buffer.length} bytes)\n`;
      }
      formatted.requestBody = requestBodyDataUrl;
    }

    if (req.hookedRequest) {
      const hookedHeaders = req.hookedRequest.headers ?? {};
      formatted.hookedRequestContent =
        `# Hooked 请求信息\n\n` +
        `- **方法**: ${req.hookedRequest.method}\n` +
        `- **URL**: ${req.hookedRequest.url}\n\n` +
        `## 请求头\n\n\`\`\`\n${Object.entries(hookedHeaders)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")}\n\`\`\`\n\n`;

      const hookedContentType = extractContentTypeFromHeaders(hookedHeaders);
      const hookedBodyDataUrl = coerceBodyDataUrl(req.hookedRequest.bodyDataUrl, hookedContentType);

      if (hookedBodyDataUrl) {
        const { mime, buffer } = dataUrlToBuffer(hookedBodyDataUrl);
        const isText = isTextLikeMime(mime);
        formatted.hookedRequestContent += `## 请求体\n\n大小: ${req.hookedRequest.bodySize} bytes\n\n`;
        if (isText) {
          formatted.hookedRequestContent += `\`\`\`\n${buffer.toString("utf-8")}\n\`\`\`\n`;
        } else {
          formatted.hookedRequestContent += `二进制数据 (${buffer.length} bytes)\n`;
        }
        formatted.hookedRequestBody = hookedBodyDataUrl;
      }
    }

    if (req.response) {
      const responseHeaders = req.response.headers ?? {};
      formatted.responseContent =
        `# 响应信息\n\n` +
        `- **状态码**: ${req.response.statusCode ?? ""} ${req.response.statusMessage || ""}\n` +
        `- **耗时**: ${req.response.durationMs}ms\n\n` +
        `## 响应头\n\n\`\`\`\n${Object.entries(responseHeaders)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")}\n\`\`\`\n\n`;

      const responseBodyDataUrl = coerceBodyDataUrl(
        req.response.bodyDataUrl,
        req.response.contentType ?? null,
      );
      if (responseBodyDataUrl) {
        const { mime, buffer } = dataUrlToBuffer(responseBodyDataUrl);
        const isText = isTextLikeMime(mime);
        if (isText) {
          formatted.responseContent += `\n## 响应体 (文本)\n\n\`\`\`\n${buffer.toString("utf-8")}\n\`\`\`\n`;
        } else {
          formatted.responseContent += `\n## 响应体\n\n二进制数据 (${buffer.length} bytes)\n`;
        }
        formatted.responseBody = responseBodyDataUrl;
      }
    } else {
      formatted.responseContent = `# 响应信息\n\n- **状态**: ${req.status}\n`;
    }

    return formatted;
  }

  const server = serve({
    port,

    routes: {
      // ========== 配置文件 API（单一数据源）==========
      "/api/config": {
        async GET() {
          try {
            const config = loadConfig();
            return Response.json(config);
          } catch (error) {
            return Response.json({ error: String(error) }, { status: 500 });
          }
        },
        async PUT(req) {
          try {
            const body = await req.json();
            saveConfig(body);
            
            // 同步 autoSortSameNameForwards 状态到 forwardStatsManager
            const config = loadConfig();
            for (const instance of config.instances) {
              forwardStatsManager.setAutoSortSameNameForwardsEnabled(
                instance.name,
                instance.settings?.autoSortSameNameForwards ?? false,
              );
            }
            
            const message = JSON.stringify({ type: "config-changed" });
            for (const client of wsClients) {
              try {
                client.send(message);
              } catch (error) {
                wsClients.delete(client);
              }
            }
            return Response.json({ success: true });
          } catch (error) {
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
      },

      // ========== 配置热更新 ==========
      "/api/reload": {
        async POST() {
          try {
            const result = await reloadInstancesFromConfig();
            return Response.json({ success: true, ...result });
          } catch (error) {
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
      },
      "/api/reload/status": {
        async GET() {
          return Response.json({ watching: watchEnabled });
        },
      },
      "/api/reload/watch": {
        async POST(req) {
          try {
            const body = await req.json();
            const enabled = Boolean(body?.enabled);
            if (enabled) {
              enableConfigWatch();
            } else {
              disableConfigWatch();
            }
            const config = loadConfig();
            if (!config.settings) {
              config.settings = { autoWatchConfig: enabled };
            } else {
              config.settings.autoWatchConfig = enabled;
            }
            saveConfig(config);
            return Response.json({ success: true, watching: watchEnabled });
          } catch (error) {
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
      },

      // ========== 实例运行控制（用 name 标识）==========
      "/api/runtime/instances/:name/start": {
        async POST(req) {
          try {
            const name = decodeURIComponent(req.params.name);
            await manager.startInstance(name);
            return Response.json({
              success: true,
              status: manager.getInstanceStatus(name),
            });
          } catch (error) {
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
      },
      "/api/runtime/instances/:name/stop": {
        async POST(req) {
          try {
            const name = decodeURIComponent(req.params.name);
            await manager.stopInstance(name);
            return Response.json({
              success: true,
              status: manager.getInstanceStatus(name),
            });
          } catch (error) {
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
      },
      "/api/runtime/instances/:name/status": {
        async GET(req) {
          try {
            const name = decodeURIComponent(req.params.name);
            return Response.json(manager.getInstanceStatus(name));
          } catch (error) {
            return Response.json({ error: String(error) }, { status: 400 });
          }
        },
      },
      "/api/runtime/instances/:name/push-config": {
        async POST(req) {
          try {
            const name = decodeURIComponent(req.params.name);
            const status = manager.getInstanceStatus(name);
            if (!status.running) {
              return Response.json(
                { success: false, error: "Instance not running" },
                { status: 400 },
              );
            }
            await manager.reloadInstance(name);
            return Response.json({ success: true });
          } catch (error) {
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
      },
      "/api/runtime/instances/:name/config-sync": {
        async GET(req) {
          try {
            const name = decodeURIComponent(req.params.name);
            const result = await manager.checkInstanceConfigSyncDetailed(name);
            return Response.json(result);
          } catch (error) {
            return Response.json({ error: String(error) }, { status: 400 });
          }
        },
      },
      "/api/runtime/statuses": {
        async GET() {
          const instances = getAllInstances();
          const result: Record<string, any> = {};
          for (const instance of instances) {
            result[instance.name] = manager.getInstanceStatus(instance.name);
          }
          return Response.json(result);
        },
      },

      // ========== 统计数据 API ==========
      "/api/stats": {
        async GET() {
          const stats = forwardStatsManager.getAllStats();
          return Response.json(stats);
        },
      },

      // ========== 请求日志 API ==========
      "/api/requests": {
        async GET(req) {
          const url = new URL(req.url);
          const forwardNameParam = url.searchParams.get("forward_name");
          const method = url.searchParams.get("method");
          const statusCodeParam = url.searchParams.get("status_code");
          const urlPattern = url.searchParams.get("url_pattern");

          const filters: {
            forward_name?: string | null;
            method?: string;
            status_code?: number;
            url_pattern?: string;
          } = {};

          if (forwardNameParam !== null) {
            filters.forward_name = forwardNameParam === "null" ? null : forwardNameParam;
          }
          if (method) {
            filters.method = method;
          }
          if (statusCodeParam) {
            const statusCode = parseInt(statusCodeParam);
            if (!isNaN(statusCode)) {
              filters.status_code = statusCode;
            }
          }
          if (urlPattern) {
            filters.url_pattern = urlPattern;
          }

          const requests =
            Object.keys(filters).length > 0 ? getAllRequestsFiltered(filters) : getAllRequests();
          return Response.json(requests);
        },
      },
      "/api/requests/:id": {
        async GET(req) {
          const id = parseInt(req.params.id);
          if (isNaN(id)) {
            return Response.json({ error: "Invalid request ID" }, { status: 400 });
          }
          const detail = getRequestDetail(id);
          if (!detail) {
            return Response.json({ error: "Request not found" }, { status: 404 });
          }
          return Response.json(detail);
        },
        async DELETE(req) {
          try {
            const id = parseInt(req.params.id);
            if (isNaN(id)) {
              return Response.json({ success: false, error: "Invalid request ID" }, { status: 400 });
            }
            const success = dbDeleteProxyRequest(id);
            if (success) {
              return Response.json({ success: true, message: "Request deleted" });
            } else {
              return Response.json({ success: false, error: "Request not found" }, { status: 404 });
            }
          } catch (error) {
            console.error("Failed to delete request:", error);
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
      },
      "/api/clear": {
        async POST() {
          try {
            dbClearAllRequests();
            return Response.json({ success: true, message: "All requests cleared" });
          } catch (error) {
            console.error("Failed to clear requests:", error);
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
      },

      // ========== 工具接口 ==========
      "/standalone/:name": {
        async GET(req) {
          try {
            const workerName = req.params.name;
            const standaloneBaseDir = path.join(__dirname, "standalone");
            const workerPath = path.join(standaloneBaseDir, workerName);
            if (!workerPath.startsWith(standaloneBaseDir)) {
              return Response.json({ error: `Invalid worker name:${workerName}` }, { status: 400 });
            }

            const sourceFile = Bun.file(workerPath);
            if (!(await sourceFile.exists())) {
              return Response.json({ error: `Worker not found: ${workerName}` }, { status: 404 });
            }

            const outdir = path.join(__dirname, ".standalone");
            const outFileName = `${workerName}.js`;

            const res = await Bun.build({
              entrypoints: [workerPath],
              outdir,
              naming: outFileName,
              target: "browser",
              minify: process.env.NODE_ENV === "production",
            });
            if (!res.success) {
              throw Response.json({ logs: res.logs }, { status: 502 });
            }

            const workerFile = Bun.file(path.join(outdir, outFileName));
            if (!(await workerFile.exists())) {
              return Response.json({ error: "Worker build failed" }, { status: 500 });
            }

            return new Response(await workerFile.arrayBuffer(), {
              headers: {
                "Content-Type": "application/javascript",
                "Cache-Control": "public, max-age=3600",
              },
            });
          } catch (error) {
            console.error("Worker build error:", error);
            return Response.json({ error: String(error) }, { status: 500 });
          }
        },
      },
      "/api/highlight": {
        async POST(req) {
          try {
            const body = (await req.json()) as HighlightRequest;
            const { code, lang, theme } = body;

            if (!code || !lang || !theme) {
              return Response.json(
                { success: false, error: "Missing required parameters" },
                { status: 400 },
              );
            }

            const html = await codeToHtml(code, { lang, theme });
            const response: HighlightResponse = { success: true, requestId: 0, html };
            return Response.json(response);
          } catch (error) {
            const response: HighlightResponse = {
              success: false,
              requestId: 0,
              error: error instanceof Error ? error.message : String(error),
            };
            return Response.json(response);
          }
        },
      },
      "/api/format": {
        async POST(req) {
          try {
            const body = (await req.json()) as FormatRequest;
            const { code, filename } = body;

            if (!code || !filename) {
              return Response.json(
                { success: false, error: "Missing required parameters" },
                { status: 400 },
              );
            }

            const result = await formatCode({ code, filename });
            return Response.json(result);
          } catch (error) {
            const response: FormatResponse = {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            };
            return Response.json(response);
          }
        },
      },
      "/api/decompress": {
        async POST(req) {
          try {
            const body = (await req.json()) as DecompressRequest;
            const { data, encoding } = body;

            if (!data || !encoding) {
              return Response.json(
                { success: false, error: "Missing required parameters: data, encoding" },
                { status: 400 },
              );
            }

            const result = await decompressData({ data, encoding });
            return Response.json(result);
          } catch (error) {
            const response: DecompressResponse = {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            };
            return Response.json(response);
          }
        },
      },

      "/*": viewerHtml,
    },

    async fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        const upgraded = (
          server.upgrade as unknown as (
            req: Request,
            options: { data: { type: string } },
          ) => boolean
        )(req, { data: { type: "requests" } });
        if (upgraded) return;
      }

      if (url.pathname === "/logs") {
        const upgraded = (
          server.upgrade as unknown as (
            req: Request,
            options: { data: { type: string } },
          ) => boolean
        )(req, { data: { type: "logs" } });
        if (upgraded) return;
      }

      if (url.pathname === "/stats") {
        const upgraded = (
          server.upgrade as unknown as (
            req: Request,
            options: { data: { type: string } },
          ) => boolean
        )(req, { data: { type: "stats" } });
        if (upgraded) return;
      }
    },

    websocket: {
      open(ws) {
        const type = (ws.data as unknown as { type?: string })?.type;

        if (type === "logs") {
          logClients.add(ws);
          log.info(`Log client connected (total: ${logClients.size})`);
        } else if (type === "stats") {
          statsClients.add(ws);
          log.info(`Stats client connected (total: ${statsClients.size})`);
          const stats = forwardStatsManager.getAllStats();
          ws.send(JSON.stringify({ type: "stats-update", stats }));
        } else {
          wsClients.add(ws);
          log.info(`Request client connected (total: ${wsClients.size})`);
        }
      },
      message(ws, message) {
        if (message === "ping") {
          ws.send("pong");
        }
      },
      close(ws) {
        const type = (ws.data as unknown as { type?: string })?.type;

        if (type === "logs") {
          logClients.delete(ws);
          log.info(`Log client disconnected (total: ${logClients.size})`);
        } else if (type === "stats") {
          statsClients.delete(ws);
          log.info(`Stats client disconnected (total: ${statsClients.size})`);
        } else {
          wsClients.delete(ws);
          log.info(`Request client disconnected (total: ${wsClients.size})`);
        }
      },
    },

    development: process.env.NODE_ENV !== "production" && {
      hmr: true,
      console: true,
    },
  });

  requestEvents.on("created", (request: LoggedRequest) => {
    log.debug(`[Event] Received 'created' event for request: ${request.id}`);
    const formatted = formatProxyRequest(request);
    const message = JSON.stringify({
      type: "new-request",
      data: formatted,
    });

    for (const client of wsClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error("Failed to send new request to client:", error);
        wsClients.delete(client);
      }
    }
  });

  let lastRequestId = 0;

  const initListener = () => {
    const query = db.query("SELECT MAX(id) as maxId FROM proxy_requests");
    const result = query.get() as { maxId: number | null };
    lastRequestId = result.maxId || 0;

    log.info(`[DbListener] Initialized lastRequestId: ${lastRequestId}`);

    dbListener.start();

    dbListener.on("proxy_requests:insert", (notification) => {
      debugAutoSort("dbListener event 'proxy_requests:insert' triggered, id: %d", notification.id);
      log.debug(`[DbListener] Received insert notification for request #${notification.id}`);

      const newRequests = getRequestsAfterId(lastRequestId);

      if (newRequests.length > 0) {
        log.debug(`[DbListener] Broadcasting ${newRequests.length} new requests`);
        broadcastNewRequests(newRequests);
      }
    });

    dbListener.on("proxy_requests:update", (notification) => {
      log.debug(`[DbListener] Received update notification for request #${notification.id}`);

      const updatedRequest =
        typeof notification.id === "number" ? getProxyRequestById(notification.id) : null;

      if (updatedRequest) {
        log.debug(
          `[DbListener] Broadcasting update for request #${updatedRequest.id}, status: ${updatedRequest.status}`,
        );
        broadcastUpdatedRequest(updatedRequest);
      }
    });
  };

  const broadcastNewRequests = (newRequests: LoggedRequest[]) => {
    for (const request of newRequests) {
      const formatted = formatProxyRequest(request);
      const message = JSON.stringify({
        type: "new-request",
        data: formatted,
      });

      for (const client of wsClients) {
        try {
          client.send(message);
        } catch (error) {
          console.error("Failed to send new request to client:", error);
          wsClients.delete(client);
        }
      }

      lastRequestId = request.id!;
    }
  };

  const broadcastUpdatedRequest = (request: LoggedRequest) => {
    const formatted = formatProxyRequest(request);
    const message = JSON.stringify({
      type: "update-request",
      id: request.id,
      data: formatted,
    });

    for (const client of wsClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error("Failed to send updated request to client:", error);
        wsClients.delete(client);
      }
    }
  };

  initListener();

  requestEvents.on("clear-all", () => {
    const message = JSON.stringify({ type: "clear-all" });
    for (const client of wsClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error("Failed to send clear-all to client:", error);
        wsClients.delete(client);
      }
    }
  });

  console.log(`\n🚀 Proxy Viewer 已启动`);
  console.log(`📊 查看地址: ${server.url}`);
  console.log(`📁 数据目录: ${PROXY_DIR}\n`);

  return server;
}

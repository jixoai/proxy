import { serve, type ServerWebSocket } from "bun";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import createDebug from "debug";
import { codeToHtml } from "shiki";
import type { HighlightRequest, HighlightResponse } from "./services/highlight.protocol";
import { formatCode, type FormatRequest, type FormatResponse } from "./lib/biome-formatter";
import { decompressData, type DecompressRequest, type DecompressResponse } from "./lib/decompress";
import type { ProxyLogMessage } from "./proxy-manager";
import type { ProxyStatus } from "./proxy-manager";
import type { ProxyInstancesManager, InstanceStatusEvent } from "./proxy-instances-manager";
import { db } from "./lib/db";
import type { ProxyConfigFile, ProxyForwardConfig } from "./types/proxy";
import viewerHtml from "./viewer.html";
import {
  getAllInstances,
  getInstanceByName,
  getConfigFilePath,
  loadConfig,
  saveConfig,
  enableConfigWatch as storeEnableConfigWatch,
  getProxyConfigStore,
} from "./lib/config-store";
import {
  getAllRequests as dbGetAllRequests,
  getProxyRequestById,
  getRequestsAfterId,
  getRequestsCount,
  clearAllRequests as dbClearAllRequests,
  deleteProxyRequest as dbDeleteProxyRequest,
  updateProxyRequest,
  requestEvents,
  type LoggedRequest,
} from "./lib/db-requests";
import { dbListener, dbNotifier } from "./lib/db-notifier";
import { bufferToDataUrl, dataUrlToBuffer, isDataUrl } from "./lib/data-url";
import { extractContentTypeFromHeaders, isTextLikeMime } from "./lib/http-utils";
import { createLogger, installGlobalErrorLogger } from "./lib/logger";
import {
  forwardStatsStore,
  evaluateForwards,
  type ForwardMatcher,
} from "./lib/forward-stats";
import { reorderForwardsByIndexes as reorderForwardsByIndexesDirect } from "./lib/config-store";
import {
  getProxyStaticDir,
  getStandalonePaths,
  isStandaloneBinary,
  getDataDir,
} from "./lib/runtime-paths";
import type { StoreChangeEvent } from "./lib/store/base-store";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const log = createLogger("proxy:viewer");
const debugAutoSortSameNameForwards = createDebug("plugins:auto-sort-same-name-forwards");
const debugAutoPushConfig = createDebug("plugins:auto-push-config");
const debugDbListener = createDebug("plugins:db-listener");
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
      ttfbMs: req.response?.ttfbMs,
      bodyMs: req.response?.bodyMs,
      instanceName: req.instance_name,
      forwardName: req.forward_name,
      status: req.status,
      abortReason: req.abort_reason,
      isWebSocket: req.is_websocket,
      websocketDirection: req.websocket_direction,
      errorMessage: req.error_message,
      targetUrl: hasHookedRequest
        ? req.hookedRequest!.url
        : (req.request.targetUrl ?? req.request.url),
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

function getAllRequestsFiltered(
  filters?: {
    forward_name?: string | null;
    method?: string;
    status_code?: number;
    url_pattern?: string;
  },
  pagination?: { page: number; limit: number },
): RequestData[] {
  const requests = dbGetAllRequests(filters, pagination);
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

  forwardStatsStore.startListening();

  const broadcastConfigChanged = () => {
    const message = JSON.stringify({ type: "config-changed" });
    for (const client of wsClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error("Failed to send config-changed to client:", error);
        wsClients.delete(client);
      }
    }
  };

  const broadcastStats = () => {
    if (statsClients.size === 0) return;
    const stats = forwardStatsStore.getDisplayStats();
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

  forwardStatsStore.on("samples-changed", () => {
    broadcastStats();
  });

  // 自动排序：统计变更时评估并应用
  const performAutoSortSameNameForwards = async (changedForwardIds: string[]) => {
    const samplesMap = forwardStatsStore.getSamplesMap();
    const changedIdSet = new Set(changedForwardIds);

    // 遍历所有实例，检查是否有开启自动排序的
    for (const instance of getAllInstances()) {
      if (!instance.settings?.autoSortSameNameForwards) continue;

      // 只评估“包含变更 forwardId”的同名组（但评估时需要带上组内所有 forwards）
      const changedForwardNames = new Set<string>();
      for (const forward of instance.forwards) {
        if (forward.id && changedIdSet.has(forward.id)) {
          changedForwardNames.add(forward.name);
        }
      }
      if (changedForwardNames.size === 0) continue;

      let hasReorder = false;
      const nextOrder = instance.forwards.map((_, idx) => idx);

      for (const forwardName of changedForwardNames) {
        const forwards: ForwardMatcher[] = [];
        instance.forwards.forEach((f, idx) => {
          if (f.name !== forwardName) return;
          if (!f.id) return;
          forwards.push({ id: f.id, index: idx });
        });
        if (forwards.length < 2) continue;

        const result = evaluateForwards(forwards, samplesMap);
        debugAutoSortSameNameForwards(
          "[%s/%s] Evaluation: %s",
          instance.name,
          forwardName,
          result.reason,
        );

        if (!result.suggestedOrder) continue;
        const suggestedOrder = result.suggestedOrder;

        log.info(
          `[AutoSortSameNameForwards] ${instance.name}/${forwardName}: ${result.reason}`,
        );

        const currentIndexes = forwards.map((f) => f.index);
        currentIndexes.forEach((position, i) => {
          nextOrder[position] = suggestedOrder[i]!;
        });
        hasReorder = true;
      }

      if (!hasReorder) continue;

      try {
        reorderForwardsByIndexesDirect(instance.name, nextOrder);
      } catch (error) {
        debugAutoSortSameNameForwards("Failed to reorder: %s", error);
      }
    }
  };

  forwardStatsStore.on("evaluation-needed", ({ forwardIds }: { forwardIds: string[] }) => {
    performAutoSortSameNameForwards(forwardIds).catch((error) => {
      console.error("[AutoSortSameNameForwards] Error:", error);
    });
  });

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

  // 监听实例状态变更事件，推送给 WebSocket 客户端
  manager.on("instance-state-changed", (event: InstanceStatusEvent) => {
    const message = JSON.stringify({
      type: "instance-state-changed",
      instanceName: event.instanceName,
      status: event.status,
    });
    for (const client of wsClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error("Failed to send instance status to client:", error);
        wsClients.delete(client);
      }
    }
  });

  // 监听所有实例状态广播
  manager.on("all-statuses", (statuses: Record<string, ProxyStatus>) => {
    const message = JSON.stringify({
      type: "all-instance-states",
      statuses,
    });
    for (const client of wsClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error("Failed to send all statuses to client:", error);
        wsClients.delete(client);
      }
    }
  });

  // 监听实例配置同步状态变更
  manager.on("instance-config-change", (event: { instanceName: string; synced: boolean }) => {
    const message = JSON.stringify({
      type: "instance-config-change",
      instanceName: event.instanceName,
      synced: event.synced,
    });
    for (const client of wsClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error("Failed to send config change to client:", error);
        wsClients.delete(client);
      }
    }
  });

  // 清理旧的文件系统记录（开发模式下）
  const proxyDir = getProxyStaticDir();
  if (!isStandaloneBinary() && fs.existsSync(proxyDir)) {
    try {
      fs.rmSync(proxyDir, { recursive: true, force: true });
      log.info("[Cleanup] Removed old filesystem request records");
    } catch (error) {
      console.error("[Cleanup] Failed to remove old records:", error);
    }
  }

  const reloadInstancesFromConfig = async () => {
    const result = {
      reloaded: [] as string[],
      skipped: [] as string[],
      failed: [] as Array<{ name: string; error: string }>,
    };
    loadConfig();
    const running = manager.getRunningInstanceNames();
    for (const name of running) {
      // 检查实例的 autoPushConfig 设置，默认为 true
      const instance = getInstanceByName(name);
      const autoPushConfig = instance?.settings?.autoPushConfig ?? true;
      if (!autoPushConfig) {
        result.skipped.push(name);
        // 广播配置不同步状态
        manager.emit("instance-config-change", { instanceName: name, synced: false });
        continue;
      }
      try {
        await manager.reloadInstance(name);
        result.reloaded.push(name);
      } catch (error) {
        result.failed.push({ name, error: String(error) });
      }
    }

    return result;
  };

  storeEnableConfigWatch();
  log.info(`[ConfigWatch] Watching config file: ${getConfigFilePath()}`);

  let configChangeDebounceTimer: NodeJS.Timeout | null = null;
  let configChangeReloadInProgress = false;
  let configChangeReloadPending = false;
  let lastConfigChangeEventType: string | null = null;

  const scheduleReloadOnConfigChange = (eventType: string) => {
    lastConfigChangeEventType = eventType;
    if (configChangeDebounceTimer) {
      clearTimeout(configChangeDebounceTimer);
    }
    configChangeDebounceTimer = setTimeout(() => {
      configChangeDebounceTimer = null;
      void applyReloadOnConfigChange();
    }, 50);
  };

  const applyReloadOnConfigChange = async () => {
    if (configChangeReloadInProgress) {
      configChangeReloadPending = true;
      return;
    }

    configChangeReloadInProgress = true;
    const eventType = lastConfigChangeEventType ?? "unknown";
    lastConfigChangeEventType = null;

    try {
      debugAutoPushConfig("Detected config change (%s), applying autoPushConfig", eventType);
      await reloadInstancesFromConfig();
    } catch (error) {
      console.error("[AutoPushConfig] Failed to apply config change:", error);
    } finally {
      configChangeReloadInProgress = false;

      if (configChangeReloadPending) {
        configChangeReloadPending = false;
        scheduleReloadOnConfigChange("pending");
      }
    }
  };

  // 监听 Store 的 change 事件（包含 update/create/delete/reload）
  getProxyConfigStore().on("change", (event: StoreChangeEvent<ProxyConfigFile>) => {
    // 任意变更都通知前端；是否触发 autoPushConfig 由“实例配置是否变化”决定
    broadcastConfigChanged();

    const prevInstances = event.previousData?.instances;
    const nextInstances = event.data.instances;
    if (prevInstances && JSON.stringify(prevInstances) === JSON.stringify(nextInstances)) {
      return;
    }

    scheduleReloadOnConfigChange(event.type);
  });

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
      const ttfbMs = req.response.ttfbMs ?? 0;
      const bodyMs = req.response.bodyMs;
      const durationStr = bodyMs !== undefined ? `${ttfbMs}ms + ${bodyMs}ms` : `${ttfbMs}ms + ?`;
      formatted.responseContent =
        `# 响应信息\n\n` +
        `- **状态码**: ${req.response.statusCode ?? ""} ${req.response.statusMessage || ""}\n` +
        `- **耗时**: ${durationStr}\n\n` +
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
          const stats = forwardStatsStore.getDisplayStats();
          return Response.json(stats);
        },
      },

      // ========== 数据目录 API ==========
      "/api/settings/db-path": {
        async GET() {
          try {
            const config = loadConfig();
            const { DEFAULT_DB_PATH_TEMPLATE, resolveDbPathTemplate } = await import("./lib/runtime-paths");
            const templatePath = config.settings?.dbPath ?? DEFAULT_DB_PATH_TEMPLATE;
            const resolvedPath = resolveDbPathTemplate(templatePath);
            return Response.json({
              dbPath: templatePath,
              resolvedPath,
              currentDataDir: getDataDir(),
            });
          } catch (error) {
            return Response.json({ error: String(error) }, { status: 500 });
          }
        },
        async PUT(req) {
          try {
            const body = await req.json();
            // 允许清空，configStore 会自动补全默认值
            const newDbPath = typeof body.dbPath === "string" && body.dbPath.trim().length > 0
              ? body.dbPath.trim()
              : undefined;

            const config = loadConfig();
            if (!config.settings) {
              config.settings = { frontendAutoPullConfig: true, dbPath: newDbPath };
            } else {
              config.settings.dbPath = newDbPath;
            }
            saveConfig(config);

            // 重新加载以获取 configStore 补全后的值
            const savedConfig = loadConfig();
            return Response.json({
              success: true,
              message: "dbPath updated. Restart required to take effect.",
              dbPath: savedConfig.settings?.dbPath,
            });
          } catch (error) {
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
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
          const pageParam = url.searchParams.get("page");
          const limitParam = url.searchParams.get("limit");

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

          // 支持分页参数
          const page = pageParam ? parseInt(pageParam) : undefined;
          const limit = limitParam ? parseInt(limitParam) : undefined;

          if (page !== undefined && limit !== undefined && page > 0 && limit > 0) {
            // 分页模式：返回 { items, total, page, limit }
            const pagination = { page, limit };
            const hasFilters = Object.keys(filters).length > 0;
            const requests = hasFilters
              ? getAllRequestsFiltered(filters, pagination)
              : getAllRequestsFiltered({}, pagination);
            const total = getRequestsCount(hasFilters ? filters : undefined);

            return Response.json({
              items: requests,
              total,
              page,
              limit,
              totalPages: Math.ceil(total / limit),
            });
          }

          // 兼容模式：返回全部数据（数组）
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
              return Response.json(
                { success: false, error: "Invalid request ID" },
                { status: 400 },
              );
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
      "/api/requests/:id/abort": {
        async POST(req) {
          try {
            const id = parseInt(req.params.id);
            if (isNaN(id)) {
              return Response.json(
                { success: false, error: "Invalid request ID" },
                { status: 400 },
              );
            }

            // 获取请求信息以确定所属实例
            const request = getProxyRequestById(id);
            if (!request) {
              return Response.json({ success: false, error: "Request not found" }, { status: 404 });
            }

            // 检查请求是否可以中断（只有 pending 和 streaming 状态可以中断）
            if (request.status !== "pending" && request.status !== "streaming") {
              return Response.json(
                {
                  success: false,
                  error: "Request cannot be aborted (already completed or errored)",
                },
                { status: 400 },
              );
            }

            const instanceName = request.instance_name;
            if (!instanceName) {
              return Response.json(
                { success: false, error: "Request has no associated instance" },
                { status: 400 },
              );
            }

            // 调用 manager 中断请求
            const success = await manager.abortRequest(instanceName, id);

            if (success) {
              // 更新数据库状态
              updateProxyRequest(id, {
                status: "aborted",
                abort_reason: "user_abort",
                error_message: "Request aborted by user",
              });
              dbNotifier.notify("update", "proxy_requests", id);
              return Response.json({ success: true, message: "Request aborted" });
            } else {
              return Response.json(
                { success: false, error: "Failed to abort request (may have already completed)" },
                { status: 400 },
              );
            }
          } catch (error) {
            console.error("Failed to abort request:", error);
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
            // 单文件打包模式下不支持 standalone 构建
            if (isStandaloneBinary()) {
              return Response.json(
                { error: "Standalone build is not supported in compiled binary" },
                { status: 501 },
              );
            }

            const workerName = req.params.name;
            const { baseDir: standaloneBaseDir, outDir: outdir } = getStandalonePaths();
            const workerPath = path.join(standaloneBaseDir, workerName);
            if (!workerPath.startsWith(standaloneBaseDir)) {
              return Response.json({ error: `Invalid worker name:${workerName}` }, { status: 400 });
            }

            const sourceFile = Bun.file(workerPath);
            if (!(await sourceFile.exists())) {
              return Response.json({ error: `Worker not found: ${workerName}` }, { status: 404 });
            }

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

      // ========== HTML 页面路由 ==========
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
          const stats = forwardStatsStore.getDisplayStats();
          ws.send(JSON.stringify({ type: "stats-update", stats }));
        } else {
          wsClients.add(ws);
          log.info(`Request client connected (total: ${wsClients.size})`);
          // 发送当前所有实例状态
          const instances = getAllInstances();
          const statuses: Record<string, any> = {};
          for (const instance of instances) {
            statuses[instance.name] = manager.getInstanceStatus(instance.name);
          }
          ws.send(JSON.stringify({ type: "all-instance-states", statuses }));
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
      debugDbListener(
        "dbListener event 'proxy_requests:insert' triggered, id: %d",
        notification.id,
      );
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
  console.log(`📁 数据目录: ${getDataDir()}\n`);

  return server;
}

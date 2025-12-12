import { serve, type ServerWebSocket } from "bun";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import viewerHtml from "./viewer.html";
import { codeToHtml } from "shiki";
import type { HighlightRequest, HighlightResponse } from "./services/highlight.protocol";
import { formatCode, type FormatRequest, type FormatResponse } from "./lib/biome-formatter";
import { decompressData, type DecompressRequest, type DecompressResponse } from "./lib/decompress";
import type { ProxyLogMessage } from "./lib/proxy-manager";
import type { ProxyInstancesManager } from "./proxy-instances-manager";
import { db } from "./lib/db";
import type { ProxyForwardConfig, ProxyInstanceConfig } from "./types/proxy";
import {
  getAllInstances,
  getInstanceByName,
  upsertInstance,
  deleteInstance,
  getForwardsByInstanceName,
  upsertForward,
  addForward,
  deleteForwardByIndex,
  updateForwardByIndex,
  reorderForwardsByIndexes,
  getConfigFilePath,
  loadConfig,
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
import { forwardStatsManager, type ForwardEndpointStats } from "./lib/forward-stats-manager";
import { reorderForwardsByIndexes as reorderForwardsByIndexesDirect } from "./lib/config-store";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROXY_DIR = path.join(__dirname, ".tmp", "proxy");
const log = createLogger("proxy:viewer");
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

interface ForwardKey {
  instanceName: string;
  forwardIndex: number;
  forwardName: string;
}

interface ConfigCache {
  instanceNameToId: Map<string, number>;
  instanceIdToName: Map<number, string>;
  forwardIdToKey: Map<number, ForwardKey>;
  forwardIndexToId: Map<string, number>;
  forwardIndexToConfig: Map<string, ProxyForwardConfig>;
  forwardNameFirstId: Map<string, number>;
}

function buildConfigCache(): ConfigCache {
  const instances = getAllInstances();
  const instanceNameToId = new Map<string, number>();
  const instanceIdToName = new Map<number, string>();
  const forwardIdToKey = new Map<number, ForwardKey>();
  const forwardIndexToId = new Map<string, number>();
  const forwardIndexToConfig = new Map<string, ProxyForwardConfig>();
  const forwardNameFirstId = new Map<string, number>();

  let forwardCounter = 1;

  instances.forEach((instance, index) => {
    const instanceId = index + 1;
    instanceNameToId.set(instance.name, instanceId);
    instanceIdToName.set(instanceId, instance.name);

    instance.forwards.forEach((forward, forwardIndex) => {
      const forwardId = forwardCounter++;
      const keyWithIndex = `${instance.name}:${forwardIndex}`;

      forwardIdToKey.set(forwardId, {
        instanceName: instance.name,
        forwardIndex,
        forwardName: forward.name,
      });
      forwardIndexToId.set(keyWithIndex, forwardId);
      forwardIndexToConfig.set(keyWithIndex, forward);

      const nameKey = `${instance.name}:${forward.name}`;
      if (!forwardNameFirstId.has(nameKey)) {
        forwardNameFirstId.set(nameKey, forwardId);
      }
    });
  });

  return {
    instanceNameToId,
    instanceIdToName,
    forwardIdToKey,
    forwardIndexToId,
    forwardIndexToConfig,
    forwardNameFirstId,
  };
}

let configCache = buildConfigCache();

function refreshConfigCache(): void {
  configCache = buildConfigCache();
}

function getInstanceIdByName(name: string | null | undefined): number | null {
  if (!name) return null;
  return configCache.instanceNameToId.get(name) ?? null;
}

function getInstanceNameById(id: number): string | null {
  return configCache.instanceIdToName.get(id) ?? null;
}

function getForwardIdByNames(
  instanceName: string | null | undefined,
  forwardName: string | null | undefined,
): number | null {
  if (!instanceName || !forwardName) return null;
  const key = `${instanceName}:${forwardName}`;
  return configCache.forwardNameFirstId.get(key) ?? null;
}

function getForwardKeyById(id: number): ForwardKey | null {
  return configCache.forwardIdToKey.get(id) ?? null;
}

function getForwardIdByIndex(instanceName: string, forwardIndex: number): number | null {
  return configCache.forwardIndexToId.get(`${instanceName}:${forwardIndex}`) ?? null;
}

function getForwardConfig(
  instanceName: string | null | undefined,
  forwardName: string | null | undefined,
): ProxyForwardConfig | null {
  if (!instanceName || !forwardName) return null;
  const firstId = getForwardIdByNames(instanceName, forwardName);
  if (!firstId) return null;
  const key = getForwardKeyById(firstId);
  if (!key) return null;
  return configCache.forwardIndexToConfig.get(`${key.instanceName}:${key.forwardIndex}`) ?? null;
}

function parseHeadersValue(value: unknown): Record<string, string> | null {
  if (value == null || value === "") return null;
  try {
    const parsed =
      typeof value === "string" ? JSON.parse(value) : (value as Record<string, unknown>);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Invalid headers format");
    }
    const entries = Object.entries(parsed).filter(([, v]) => typeof v === "string") as Array<
      [string, string]
    >;
    if (entries.length === 0) {
      return null;
    }
    return Object.fromEntries(entries);
  } catch (error) {
    throw new Error("Invalid headers JSON");
  }
}

function normalizeMethods(input: unknown): string[] {
  if (typeof input !== "string") return ["*"];
  const trimmed = input.trim();
  if (!trimmed || trimmed === "*") return ["*"];
  return trimmed
    .split(",")
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean);
}

function parseInstanceIdParam(param: string | undefined): {
  id: number;
  name: string;
} {
  if (!param) {
    throw new Error("Instance id is required");
  }
  const id = Number(param);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Invalid instance id");
  }
  const name = getInstanceNameById(id);
  if (!name) {
    throw new Error("Instance not found");
  }
  return { id, name };
}

function parseForwardIdParam(param: string | undefined): {
  id: number;
  instanceName: string;
  forwardName: string;
  forwardIndex: number;
} {
  if (!param) {
    throw new Error("Forward id is required");
  }
  const id = Number(param);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Invalid forward id");
  }
  const key = getForwardKeyById(id);
  if (!key) {
    throw new Error("Forward not found");
  }
  return {
    id,
    instanceName: key.instanceName,
    forwardName: key.forwardName,
    forwardIndex: key.forwardIndex,
  };
}

function serializeInstance(instance: ProxyInstanceConfig, instanceId: number) {
  return {
    id: instanceId,
    name: instance.name,
    port: instance.port,
    enabled: instance.enabled,
    description: instance.description ?? null,
    instance_headers: instance.headers ? JSON.stringify(instance.headers) : null,
  };
}

function serializeForward(instanceId: number, forward: ProxyForwardConfig, forwardId: number) {
  return {
    id: forwardId,
    instance_id: instanceId,
    name: forward.name,
    target_url: forward.target,
    enabled: forward.enabled,
    description: forward.description ?? null,
    method: !forward.methods || forward.methods.length === 0 ? "*" : forward.methods.join(","),
    path: forward.path ?? null,
    custom_headers: forward.headers ? JSON.stringify(forward.headers) : null,
  };
}

// 将 ProxyRequest 转换为 RequestData 格式
function formatProxyRequest(req: LoggedRequest): RequestData {
  const instanceId = getInstanceIdByName(req.instance_name) ?? -1;
  const forwardId = getForwardIdByNames(req.instance_name, req.forward_name);
  const forwardConfig = getForwardConfig(req.instance_name, req.forward_name);

  const forwardRule =
    forwardId && req.forward_name
      ? {
          id: forwardId,
          name: req.forward_name,
          target_url: forwardConfig?.target ?? "",
        }
      : undefined;

  const hasHookedRequest = !!req.hookedRequest;

  return {
    id: (req.id ?? req.request_id).toString(),
    folderName: `${req.request_id}_${new Date(req.timestamp).toISOString().replace(/[:.]/g, "-")}`,
    metadata: {
      timestamp: req.timestamp,
      duration: req.response ? `${req.response.durationMs}ms` : "0ms",
      instanceId,
      forwardRule,
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

// 读取所有请求（从数据库）
function getAllRequests(): RequestData[] {
  const requests = dbGetAllRequests();
  return requests.map(formatProxyRequest);
}

// 读取所有请求（从数据库，支持过滤）
function getAllRequestsFiltered(filters?: {
  forward_id?: number | null;
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
  // WebSocket 客户端管理
  const wsClients = new Set<ServerWebSocket<unknown>>();
  const logClients = new Set<ServerWebSocket<unknown>>();
  const statsClients = new Set<ServerWebSocket<unknown>>();
  let configWatcher: fs.FSWatcher | null = null;
  let watchDebounce: NodeJS.Timeout | null = null;
  let watchEnabled = false;

  // 初始化统计管理器
  forwardStatsManager.init();

  // 广播统计数据到所有订阅的客户端
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

  // 监听统计更新事件
  forwardStatsManager.on("stats-updated", () => {
    broadcastStats();
  });

  // 监听自动排序事件
  forwardStatsManager.on("auto-sort-needed", async (instanceName: string) => {
    log.info(`[AutoSort] Auto-sort triggered for instance: ${instanceName}`);

    const instance = getInstanceByName(instanceName);
    if (!instance) return;

    // 按 forwardName 分组
    const groups = new Map<string, number[]>();
    instance.forwards.forEach((f, idx) => {
      const list = groups.get(f.name) ?? [];
      list.push(idx);
      groups.set(f.name, list);
    });

    let anyChanged = false;

    for (const [forwardName, currentIndexes] of groups) {
      if (currentIndexes.length < 2) continue;

      const newOrder = forwardStatsManager.computeOptimalOrder(
        instanceName,
        forwardName,
        currentIndexes,
      );

      if (newOrder) {
        log.info(
          `[AutoSort] Reordering ${instanceName}/${forwardName}: ${currentIndexes.join(",")} -> ${newOrder.join(",")}`,
        );

        // 重新计算完整的新顺序
        const fullNewOrder = instance.forwards.map((_, idx) => {
          const groupIdx = currentIndexes.indexOf(idx);
          if (groupIdx >= 0) {
            return newOrder[groupIdx]!;
          }
          return idx;
        });

        try {
          reorderForwardsByIndexesDirect(instanceName, fullNewOrder as number[]);
          refreshConfigCache();
          anyChanged = true;
        } catch (error) {
          console.error(`[AutoSort] Failed to reorder: ${error}`);
        }
      }
    }

    if (anyChanged) {
      // 热更新到 worker
      try {
        await manager.reloadInstance(instanceName);
      } catch (error) {
        console.error(`[AutoSort] Failed to reload instance: ${error}`);
      }

      // 通知前端配置已更新
      const message = JSON.stringify({ type: "config-reloaded" });
      for (const client of wsClients) {
        try {
          client.send(message);
        } catch (error) {
          wsClients.delete(client);
        }
      }
    }
  });

  // 订阅 ProxyInstancesManager 的日志并广播给客户端
  manager.onLog((log: ProxyLogMessage) => {
    const message = JSON.stringify(log);
    for (const client of logClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error("Failed to send log to client:", error);
        logClients.delete(client);
      }
    }
  });

  // Note: 文件系统监听已移除，现在使用数据库事件系统

  // 清理旧的文件系统记录
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
    refreshConfigCache();
    const running = manager.getRunningInstanceNames();
    for (const name of running) {
      try {
        await manager.reloadInstance(name);
        result.reloaded.push(name);
      } catch (error) {
        result.failed.push({ name, error: String(error) });
      }
    }

    // 通知前端配置已更新
    const message = JSON.stringify({ type: "config-reloaded" });
    for (const client of wsClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error("Failed to send config-reloaded to client:", error);
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

  // 读取单个请求的详细信息（从数据库）
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

    // 如果有 hooked 请求，添加 hooked 数据
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
      "/api/requests": {
        async GET(req) {
          const url = new URL(req.url);
          const forwardNameParam = url.searchParams.get("forward_name");
          const method = url.searchParams.get("method");
          const statusCodeParam = url.searchParams.get("status_code");
          const urlPattern = url.searchParams.get("url_pattern");

          // 构建过滤器
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
            const url = new URL(req.url);
            const id = parseInt(req.params.id);

            if (isNaN(id)) {
              return Response.json(
                { success: false, error: "Invalid request ID" },
                { status: 400 },
              );
            }

            const success = dbDeleteProxyRequest(id);

            if (success) {
              return Response.json({
                success: true,
                message: "Request deleted",
              });
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
            // 从数据库清除所有请求
            dbClearAllRequests();
            // Note: requestEvents.emit("clear-all") is called inside dbClearAllRequests()

            return Response.json({
              success: true,
              message: "All requests cleared",
            });
          } catch (error) {
            console.error("Failed to clear requests:", error);
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
      },
      "/api/forwards": {
        async GET() {
          try {
            const instances = getAllInstances();
            const list: Array<{
              id: number;
              name: string;
              instance_id: number;
            }> = [];

            instances.forEach((instance, index) => {
              const instanceId = index + 1;
              instance.forwards.forEach((forward, forwardIndex) => {
                const forwardId = getForwardIdByIndex(instance.name, forwardIndex);
                if (forwardId && forward.enabled) {
                  list.push({
                    id: forwardId,
                    name: `${instance.name}/${forward.name}`,
                    instance_id: instanceId,
                  });
                }
              });
            });

            return Response.json(list);
          } catch (error) {
            console.error("Failed to get forwards:", error);
            return Response.json({ error: String(error) }, { status: 500 });
          }
        },
        async POST(req) {
          try {
            const body = await req.json();
            const instanceId = Number(body.instance_id);
            if (!Number.isInteger(instanceId)) {
              return Response.json(
                { success: false, error: "Invalid instance id" },
                { status: 400 },
              );
            }
            const instanceName = getInstanceNameById(instanceId);
            if (!instanceName) {
              return Response.json(
                { success: false, error: "Instance not found" },
                { status: 404 },
              );
            }
            const forward: ProxyForwardConfig = {
              name: String(body.name),
              enabled: body.enabled !== false,
              target: String(body.target_url),
              description: body.description ?? null,
              path: body.path ?? null,
              methods: normalizeMethods(body.method),
              headers: parseHeadersValue(body.custom_headers),
            };
            addForward(instanceName, forward);
            refreshConfigCache();
            const instance = getInstanceByName(instanceName);
            const forwardIndex =
              instance && instance.forwards.length > 0 ? instance.forwards.length - 1 : null;
            const createdId =
              forwardIndex != null ? getForwardIdByIndex(instanceName, forwardIndex) : null;
            return Response.json({ id: createdId, success: true });
          } catch (error) {
            console.error("Failed to create forward:", error);
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
      },
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
            return Response.json({ success: true, watching: watchEnabled });
          } catch (error) {
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
      },
      // ========== 统计数据 API ==========
      "/api/stats": {
        async GET() {
          const stats = forwardStatsManager.getAllStats();
          return Response.json(stats);
        },
      },
      "/api/stats/instance/:name": {
        async GET(req) {
          const instanceName = req.params.name;
          const stats = forwardStatsManager.getInstanceStats(instanceName);
          return Response.json(stats);
        },
      },
      "/api/auto-sort/status": {
        async GET() {
          return Response.json({ enabled: forwardStatsManager.isAutoSortEnabled() });
        },
      },
      "/api/auto-sort/toggle": {
        async POST(req) {
          try {
            const body = await req.json();
            const enabled = Boolean(body?.enabled);
            forwardStatsManager.setAutoSortEnabled(enabled);
            return Response.json({ success: true, enabled });
          } catch (error) {
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
      },
      // 配置同步检查
      "/api/instances/:id/config-sync": {
        async GET(req) {
          try {
            const { name } = parseInstanceIdParam(req.params.id);
            const synced = await manager.checkInstanceConfigSync(name);
            return Response.json({ synced });
          } catch (error) {
            return Response.json({ error: String(error) }, { status: 400 });
          }
        },
      },
      // 获取实例的 worker 当前配置
      "/api/instances/:id/worker-config": {
        async GET(req) {
          try {
            const { name } = parseInstanceIdParam(req.params.id);
            const config = await manager.getInstanceWorkerConfig(name);
            if (!config) {
              return Response.json({ error: "Instance not running" }, { status: 404 });
            }
            return Response.json(config);
          } catch (error) {
            return Response.json({ error: String(error) }, { status: 400 });
          }
        },
      },
      // 推送配置到 worker（热更新）
      "/api/instances/:id/push-config": {
        async POST(req) {
          try {
            const { name } = parseInstanceIdParam(req.params.id);
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
      // ========== WebWorker 通用构建接口 ==========
      "/standalone/:name": {
        async GET(req) {
          try {
            const workerName = req.params.name;
            const standaloneBaseDir = path.join(__dirname, "standalone");
            const workerPath = path.join(standaloneBaseDir, workerName);
            // 路径安全检查
            if (!workerPath.startsWith(standaloneBaseDir)) {
              return Response.json({ error: `Invalid worker name:${workerName}` }, { status: 400 });
            }

            // 检查文件是否存在
            const sourceFile = Bun.file(workerPath);
            if (!(await sourceFile.exists())) {
              return Response.json({ error: `Worker not found: ${workerName}` }, { status: 404 });
            }

            const outdir = path.join(__dirname, ".standalone");
            const outFileName = `${workerName}.js`;

            // 构建 worker
            const res = await Bun.build({
              entrypoints: [workerPath],
              outdir,
              naming: outFileName,
              target: "browser",
              minify: process.env.NODE_ENV === "production",
            });
            if (!res.success) {
              throw Response.json(
                {
                  logs: res.logs,
                },
                { status: 502 },
              );
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
      // ========== 代码高亮接口（服务端备用方案）==========
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
            const response: HighlightResponse = {
              success: true,
              requestId: 0,
              html,
            };

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
      // ========== 代码格式化接口（使用 Biome Native）==========
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
      // ========== 响应体解压接口 ==========
      "/api/decompress": {
        async POST(req) {
          try {
            const body = (await req.json()) as DecompressRequest;
            const { data, encoding } = body;

            if (!data || !encoding) {
              return Response.json(
                {
                  success: false,
                  error: "Missing required parameters: data, encoding",
                },
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
      // ========== 实例运行控制 API ==========
      "/api/instances/:id/start": {
        async POST(req) {
          try {
            const { id, name } = parseInstanceIdParam(req.params.id);
            await manager.startInstance(name);
            return Response.json({
              success: true,
              status: manager.getInstanceStatus(name),
              instanceId: id,
            });
          } catch (error) {
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
      },
      "/api/instances/:id/stop": {
        async POST(req) {
          try {
            const { id, name } = parseInstanceIdParam(req.params.id);
            await manager.stopInstance(name);
            return Response.json({
              success: true,
              status: manager.getInstanceStatus(name),
              instanceId: id,
            });
          } catch (error) {
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
      },
      "/api/instances/:id/status": {
        async GET(req) {
          try {
            const { id, name } = parseInstanceIdParam(req.params.id);
            return Response.json({
              instanceId: id,
              ...manager.getInstanceStatus(name),
            });
          } catch (error) {
            return Response.json({ error: String(error) }, { status: 400 });
          }
        },
      },
      "/api/instances/statuses": {
        async GET() {
          const result: Array<{
            instanceId: number;
            running: boolean;
            pid?: number;
            port: number;
            listeningPort?: number;
            uptime?: number;
          }> = [];

          for (const [id, name] of configCache.instanceIdToName.entries()) {
            const status = manager.getInstanceStatus(name);
            result.push({
              instanceId: id,
              running: status.running,
              pid: status.pid,
              port: status.port,
              listeningPort: status.listeningPort,
              uptime: status.uptime,
            });
          }

          return Response.json(result);
        },
      },
      // ========== 实例管理 API ==========
      "/api/instances": {
        async GET() {
          const instances = getAllInstances();
          return Response.json(
            instances.map((instance, index) => serializeInstance(instance, index + 1)),
          );
        },
        async POST(req) {
          try {
            const body = await req.json();
            const headers = parseHeadersValue(body.instance_headers);
            const instance: ProxyInstanceConfig = {
              name: String(body.name),
              port: Number(body.port),
              enabled: body.enabled !== false,
              description: body.description ?? null,
              headers: headers ?? null,
              forwards: [],
            };

            if (!instance.name || !Number.isInteger(instance.port)) {
              return Response.json(
                { success: false, error: "Invalid instance payload" },
                { status: 400 },
              );
            }

            const existing = getInstanceByName(instance.name);
            if (existing) {
              return Response.json(
                { success: false, error: "Instance already exists" },
                { status: 400 },
              );
            }

            upsertInstance(instance);
            refreshConfigCache();
            const newId = getInstanceIdByName(instance.name);
            return Response.json({ id: newId, success: true });
          } catch (error) {
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
      },
      "/api/instances/:id": {
        async GET(req) {
          try {
            const { id, name } = parseInstanceIdParam(req.params.id);
            const instance = getInstanceByName(name);
            if (!instance) {
              return Response.json({ error: "Instance not found" }, { status: 404 });
            }
            return Response.json(serializeInstance(instance, id));
          } catch (error) {
            return Response.json({ error: String(error) }, { status: 400 });
          }
        },
        async PUT(req) {
          try {
            const { name } = parseInstanceIdParam(req.params.id);
            const body = await req.json();
            const headers = parseHeadersValue(body.instance_headers);
            const existing = getInstanceByName(name);
            if (!existing) {
              return Response.json({ error: "Instance not found" }, { status: 404 });
            }

            upsertInstance({
              ...existing,
              name,
              port: body.port !== undefined ? Number(body.port) : existing.port,
              enabled: body.enabled !== undefined ? Boolean(body.enabled) : existing.enabled,
              description:
                body.description !== undefined ? body.description : (existing.description ?? null),
              headers: headers ?? existing.headers ?? null,
            });

            refreshConfigCache();
            return Response.json({ success: true });
          } catch (error) {
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
        async DELETE(req) {
          try {
            const { name } = parseInstanceIdParam(req.params.id);
            const status = manager.getInstanceStatus(name);
            if (status.running) {
              await manager.stopInstance(name);
            }
            const success = deleteInstance(name);
            if (!success) {
              return Response.json({ error: "Instance not found" }, { status: 404 });
            }
            refreshConfigCache();
            return Response.json({ success: true });
          } catch (error) {
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
      },
      // ========== 转发规则 API ==========
      "/api/instances/:id/forwards": {
        async GET(req) {
          try {
            const { id, name } = parseInstanceIdParam(req.params.id);
            const instance = getInstanceByName(name);
            if (!instance) {
              return Response.json({ error: "Instance not found" }, { status: 404 });
            }
            const forwards = instance.forwards.map((forward) => {
              const forwardIndex = instance.forwards.indexOf(forward);
              const forwardId = getForwardIdByIndex(name, forwardIndex);
              return serializeForward(id, forward, forwardId ?? 0);
            });
            return Response.json(forwards);
          } catch (error) {
            return Response.json({ error: String(error) }, { status: 400 });
          }
        },
      },
      "/api/instances/:id/forwards/reorder": {
        async POST(req) {
          try {
            const { name } = parseInstanceIdParam(req.params.id);
            const body = await req.json();
            const orderedIds = Array.isArray(body.order) ? (body.order as number[]) : [];

            if (orderedIds.length === 0) {
              return Response.json({ error: "Order array is empty" }, { status: 400 });
            }

            const indexes: number[] = [];
            const seen = new Set<number>();
            for (const id of orderedIds) {
              const key = getForwardKeyById(Number(id));
              if (!key || key.instanceName !== name) {
                return Response.json(
                  { error: "Order contains invalid forward id" },
                  { status: 400 },
                );
              }
              if (seen.has(key.forwardIndex)) {
                return Response.json(
                  { error: "Order contains duplicate entries" },
                  { status: 400 },
                );
              }
              seen.add(key.forwardIndex);
              indexes.push(key.forwardIndex);
            }

            const instance = getInstanceByName(name);
            if (!instance || instance.forwards.length !== indexes.length) {
              return Response.json(
                { error: "Order must include all forwards of the instance" },
                { status: 400 },
              );
            }

            reorderForwardsByIndexes(name, indexes);
            refreshConfigCache();
            return Response.json({ success: true });
          } catch (error) {
            return Response.json({ success: false, error: String(error) }, { status: 400 });
          }
        },
      },
      "/api/forwards/:id": {
        async PUT(req) {
          try {
            const { instanceName, forwardIndex } = parseForwardIdParam(req.params.id);
            const body = await req.json();
            const instance = getInstanceByName(instanceName);
            const existingForward = instance && instance.forwards[forwardIndex];
            if (!existingForward || !instance) {
              return Response.json({ error: "Forward not found" }, { status: 404 });
            }

            updateForwardByIndex(instanceName, forwardIndex, {
              ...existingForward,
              name: existingForward.name,
              target: body.target_url ?? existingForward.target,
              enabled: body.enabled !== undefined ? Boolean(body.enabled) : existingForward.enabled,
              description:
                body.description !== undefined
                  ? body.description
                  : (existingForward.description ?? null),
              path: body.path !== undefined ? body.path : (existingForward.path ?? null),
              methods:
                body.method !== undefined ? normalizeMethods(body.method) : existingForward.methods,
              headers:
                body.custom_headers !== undefined
                  ? parseHeadersValue(body.custom_headers)
                  : (existingForward.headers ?? null),
            });

            refreshConfigCache();
            return Response.json({ success: true });
          } catch (error) {
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
        async DELETE(req) {
          try {
            const { instanceName, forwardIndex } = parseForwardIdParam(req.params.id);
            const success = deleteForwardByIndex(instanceName, forwardIndex);
            if (!success) {
              return Response.json({ error: "Forward not found" }, { status: 404 });
            }
            refreshConfigCache();
            return Response.json({ success: true });
          } catch (error) {
            return Response.json({ success: false, error: String(error) }, { status: 500 });
          }
        },
      },
      "/*": viewerHtml,
    },

    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket 升级 - 处理请求更新
      if (url.pathname === "/ws") {
        /**
         * 注意：Bun 的类型定义不支持 data 参数，但运行时确实支持
         * 这里使用类型断言绕过类型检查（先转为 unknown 再转为目标类型）
         * 参考：https://bun.sh/docs/api/websockets
         */
        const upgraded = (
          server.upgrade as unknown as (
            req: Request,
            options: { data: { type: string } },
          ) => boolean
        )(req, {
          data: { type: "requests" },
        });
        if (upgraded) {
          return; // 升级成功
        }
      }

      // WebSocket 升级 - 处理日志流
      if (url.pathname === "/logs") {
        const upgraded = (
          server.upgrade as unknown as (
            req: Request,
            options: { data: { type: string } },
          ) => boolean
        )(req, {
          data: { type: "logs" },
        });
        if (upgraded) {
          return; // 升级成功
        }
      }

      // WebSocket 升级 - 处理统计数据流
      if (url.pathname === "/stats") {
        const upgraded = (
          server.upgrade as unknown as (
            req: Request,
            options: { data: { type: string } },
          ) => boolean
        )(req, {
          data: { type: "stats" },
        });
        if (upgraded) {
          return; // 升级成功
        }
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
          // 立即发送当前统计数据
          const stats = forwardStatsManager.getAllStats();
          ws.send(JSON.stringify({ type: "stats-update", stats }));
        } else {
          wsClients.add(ws);
          log.info(`Request client connected (total: ${wsClients.size})`);
        }
      },
      message(ws, message) {
        // Echo back for ping/pong
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
      // Enable browser hot reloading in development
      hmr: true,

      // Echo console logs from the browser to the server
      console: true,
    },
  });

  // 绑定数据库事件到 WebSocket，实现实时更新
  // 注意：由于 proxy-server 和 viewer-server 在不同进程，EventEmitter 不共享
  // 因此这个事件监听器只能捕获 viewer-server 自己创建的请求（实际上不会有）
  requestEvents.on("created", (request: LoggedRequest) => {
    log.debug(`[Event] Received 'created' event for request: ${request.id}`);
    const formatted = formatProxyRequest(request);
    const message = JSON.stringify({
      type: "new-request",
      instanceId: formatted.metadata.instanceId,
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

  // 使用 BroadcastChannel 监听数据库变更（跨 worker 线程）
  let lastRequestId = 0;

  // 初始化 lastRequestId
  const initListener = () => {
    const query = db.query("SELECT MAX(id) as maxId FROM proxy_requests");
    const result = query.get() as { maxId: number | null };
    lastRequestId = result.maxId || 0;

    log.info(`[DbListener] Initialized lastRequestId: ${lastRequestId}`);

    // 启动 BroadcastChannel 监听器
    dbListener.start();

    // 监听 proxy_requests 表的 insert 事件
    dbListener.on("proxy_requests:insert", (notification) => {
      log.debug(`[DbListener] Received insert notification for request #${notification.id}`);

      // 查询新请求
      const newRequests = getRequestsAfterId(lastRequestId);

      if (newRequests.length > 0) {
        log.debug(`[DbListener] Broadcasting ${newRequests.length} new requests`);
        broadcastNewRequests(newRequests);
      }
    });

    // 监听 proxy_requests 表的 update 事件
    dbListener.on("proxy_requests:update", (notification) => {
      log.debug(`[DbListener] Received update notification for request #${notification.id}`);

      // 查询更新后的请求
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

  // 广播新请求到所有 WebSocket 客户端
  const broadcastNewRequests = (newRequests: LoggedRequest[]) => {
    for (const request of newRequests) {
      const formatted = formatProxyRequest(request);
      const message = JSON.stringify({
        type: "new-request",
        instanceId: formatted.metadata.instanceId,
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

  // 广播更新的请求到所有 WebSocket 客户端
  const broadcastUpdatedRequest = (request: LoggedRequest) => {
    const formatted = formatProxyRequest(request);
    const message = JSON.stringify({
      type: "update-request",
      instanceId: formatted.metadata.instanceId,
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

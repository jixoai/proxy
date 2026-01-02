import { EventEmitter } from "events";
import { Buffer } from "node:buffer";
import { db } from "./db";
import { dbNotifier } from "./db-notifier";
import { bufferToDataUrl, dataUrlToBuffer, ensureDataUrl, isDataUrl } from "./data-url";
import type { HookLayer } from "../types/proxy";
import { parsePrivateHeaders } from "@jixo/proxy-plugin";
import { parsePluginUiFromHeaders } from "./plugin-ui";

export type AbortReason = "client_disconnect" | "user_abort";
export type RequestStatus = "pending" | "streaming" | "completed" | "error" | "aborted";
export type WebSocketDirection = "send" | "receive" | null;

export interface RequestData {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  forwardedHeaders?: Record<string, string | string[]>;
  /** Forward Rule 计算出的真正转发目标URL（无hook时的目标） */
  targetUrl?: string;
  bodyDataUrl: string | null;
  bodySize: number;
}

export interface ResponseData {
  statusCode: number | null;
  statusMessage: string | null;
  headers: Record<string, string | string[]>;
  bodyDataUrl: string | null;
  bodySize: number;
  /** 从请求发出到收到响应头的时间 (TTFB, ms) */
  ttfbMs?: number;
  /** 从收到响应头到响应体接收完成的时间 (ms)，streaming 时为 undefined */
  bodyMs?: number;
  contentType?: string | null;
}

export interface LoggedRequest {
  id?: number;
  request_id: string;
  timestamp: string;
  instance_name: string | null;
  forward_name: string | null;
  /** forward 的唯一 id，用于精确匹配同名 forward */
  forward_id: string | null;
  group_name: string | null;
  status: RequestStatus;
  abort_reason: AbortReason | null;
  is_websocket: boolean;
  websocket_direction: WebSocketDirection;
  error_message: string | null;
  request: RequestData;
  /** hooks 处理后的请求（如果有 request hook） - 最终结果 */
  hookedRequest?: RequestData;
  /** 每层 request hook 的执行结果 */
  requestHookLayers?: HookLayer[];
  response?: ResponseData;
  /** hooks 处理后的响应（如果有 response hook） - 最终结果 */
  hookedResponse?: ResponseData;
  /** 每层 response hook 的执行结果 */
  responseHookLayers?: HookLayer[];
}

export interface ProxyRequestFilters {
  instance_name?: string | null;
  forward_name?: string | null;
  method?: string;
  status_code?: number;
  url_pattern?: string;
}

export interface ProxyRequestPagination {
  page: number;
  limit: number;
  /** 排序方向：asc=旧的在前（ID升序），desc=新的在前（ID降序） */
  order?: "asc" | "desc";
}

/** 列表页展示需要的摘要数据（轻量化） */
export interface ListSummary {
  id: string;
  timestamp: string;
  ttfbMs?: number;
  bodyMs?: number;
  instanceName: string | null;
  forwardName: string | null;
  forwardId: string | null;
  status: RequestStatus;
  abortReason: AbortReason | null;
  isWebSocket: boolean;
  targetUrl?: string;
  request: {
    method: string;
    url: string;
    bodySize: number;
  };
  response: {
    statusCode: number | null;
    bodySize: number;
  } | null;
  pluginInfo?: {
    pluginOrigin?: string;
    pluginsProcessed?: string[];
    requestType?: string;
    sessionId?: string;
    pingCount?: number;
  };
  pluginUi?: {
    records: Array<{
      name: string;
      payload?: {
        name: string;
        tray: Array<{ icon: string; description?: string }>;
        remark?: string;
      };
      streamUrl?: string;
      source: "request" | "response";
    }>;
    order: string[];
    version: number;
  };
}

export const requestEvents = new EventEmitter();

function serializeRequest(req: LoggedRequest): string {
  return JSON.stringify(req);
}

/** 从 LoggedRequest 计算列表摘要 JSON */
function computeListSummary(req: LoggedRequest): string {
  const hasHookedRequest = !!req.hookedRequest;

  // 合并 headers 用于解析插件信息
  const mergedRequestHeaders = {
    ...req.request.headers,
    ...req.hookedRequest?.headers,
  };
  const mergedResponseHeaders = {
    ...req.response?.headers,
    ...req.hookedResponse?.headers,
  };

  // 解析 pluginInfo
  const pluginInfo = parsePrivateHeaders({
    ...mergedRequestHeaders,
    ...mergedResponseHeaders,
  });

  // 解析 pluginUi
  const processed = parsePrivateHeaders(mergedRequestHeaders).pluginsProcessed;
  const pluginUiResult = parsePluginUiFromHeaders(mergedRequestHeaders, mergedResponseHeaders, processed);

  const summary: ListSummary = {
    id: (req.id ?? req.request_id).toString(),
    timestamp: req.timestamp,
    ttfbMs: req.response?.ttfbMs,
    bodyMs: req.response?.bodyMs,
    instanceName: req.instance_name,
    forwardName: req.forward_name,
    forwardId: req.forward_id,
    status: req.status,
    abortReason: req.abort_reason,
    isWebSocket: req.is_websocket,
    targetUrl: hasHookedRequest
      ? req.hookedRequest!.url
      : (req.request.targetUrl ?? req.request.url),
    request: {
      method: req.request.method,
      url: req.request.url,
      bodySize: req.request.bodySize,
    },
    response: req.response
      ? {
          statusCode: req.response.statusCode,
          bodySize: req.response.bodySize,
        }
      : null,
    pluginInfo: pluginInfo.pluginOrigin || pluginInfo.pluginsProcessed?.length
      ? {
          pluginOrigin: pluginInfo.pluginOrigin ?? undefined,
          pluginsProcessed: pluginInfo.pluginsProcessed,
          requestType: pluginInfo.requestType ?? undefined,
          sessionId: pluginInfo.sessionId ?? undefined,
          pingCount: pluginInfo.pingCount ?? undefined,
        }
      : undefined,
    pluginUi: pluginUiResult
      ? { ...pluginUiResult, version: Date.now() }
      : undefined,
  };

  return JSON.stringify(summary);
}

function computeUrlColumns(url: string | null | undefined): {
  request_url_lc: string | null;
  request_path_lc: string | null;
} {
  if (!url || typeof url !== "string") {
    return { request_url_lc: null, request_path_lc: null };
  }
  const request_url_lc = url.toLowerCase();
  try {
    return { request_url_lc, request_path_lc: new URL(url).pathname.toLowerCase() };
  } catch {
    return { request_url_lc, request_path_lc: null };
  }
}

function upsertRequestFtsRow(id: number, urlLc: string | null, pathLc: string | null) {
  db
    .query("INSERT OR REPLACE INTO proxy_requests_fts(rowid, url, path) VALUES (?, ?, ?)")
    .run(id, urlLc ?? "", pathLc ?? "");
}

function deleteRequestFtsRow(id: number) {
  db.query("DELETE FROM proxy_requests_fts WHERE rowid = ?").run(id);
}

function clearAllRequestFtsRows() {
  db.query("DELETE FROM proxy_requests_fts").run();
}

function buildFtsMatchQuery(needle: string): string | null {
  const raw = needle.trim().toLowerCase();
  if (raw.length === 0) return null;

  const looksLikeUrlSearch =
    raw === "http" ||
    raw === "https" ||
    raw.startsWith("http://") ||
    raw.startsWith("https://") ||
    raw.startsWith("http:") ||
    raw.startsWith("https:") ||
    (!raw.startsWith("/") && /[.:]/.test(raw));

  const column = looksLikeUrlSearch ? "url" : "path";
  const tokens = raw.match(/[a-z0-9]+/g) ?? [];
  if (tokens.length === 0) return null;

  const parts = tokens.map((token) => {
    const t = token.length >= 3 ? `${token}*` : token;
    return `${column}:${t}`;
  });
  return parts.join(" ");
}

function deserializeRequest(row: { id: number; data: string }): LoggedRequest {
  const parsed = JSON.parse(row.data) as LoggedRequest;
  parsed.id = row.id;
  parsed.abort_reason ??= null;
  parsed.forward_id ??= null;
  return parsed;
}

function coerceGroupName(instance: string | null, forward: string | null): string | null {
  if (instance && forward) return `${instance}/${forward}`;
  if (instance) return instance;
  return null;
}

export function createProxyRequest(request: Omit<LoggedRequest, "id">): number {
  const urlCols = computeUrlColumns(request.request?.url);
  const reqWithGroup = {
    ...request,
    group_name: request.group_name ?? coerceGroupName(request.instance_name, request.forward_name),
  };
  const data = serializeRequest(reqWithGroup);

  const stmt = db.query(
    "INSERT INTO proxy_requests (timestamp, instance_name, forward_name, group_name, status, response_body_size, request_url_lc, request_path_lc, list_summary, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const result = stmt.run(
    request.timestamp,
    request.instance_name,
    request.forward_name,
    reqWithGroup.group_name,
    request.status,
    request.response?.bodySize ?? 0,
    urlCols.request_url_lc,
    urlCols.request_path_lc,
    null,
    data,
  );
  const id = Number(result.lastInsertRowid);

  const listSummary = computeListSummary({ ...(reqWithGroup as LoggedRequest), id });
  db.query("UPDATE proxy_requests SET list_summary = ? WHERE id = ?").run(listSummary, id);

  upsertRequestFtsRow(id, urlCols.request_url_lc, urlCols.request_path_lc);

  const created = getProxyRequestById(id);
  if (created) {
    requestEvents.emit("created", created);
  }
  dbNotifier.notify("insert", "proxy_requests", id);
  return id;
}

function getOrComputeListSummary(row: { id: number; list_summary: string | null }): ListSummary {
  if (row.list_summary) {
    try {
      return JSON.parse(row.list_summary) as ListSummary;
    } catch {
      // fall through
    }
  }

  const dataRow = db.query("SELECT data FROM proxy_requests WHERE id = ?").get(row.id) as
    | { data: string }
    | null;
  if (!dataRow) {
    return {
      id: row.id.toString(),
      timestamp: "",
      instanceName: null,
      forwardName: null,
      forwardId: null,
      status: "completed" as RequestStatus,
      abortReason: null,
      isWebSocket: false,
      request: { method: "?", url: "", bodySize: 0 },
      response: null,
    };
  }

  const req = deserializeRequest({ id: row.id, data: dataRow.data });
  const summaryJson = computeListSummary(req);
  db.query("UPDATE proxy_requests SET list_summary = ? WHERE id = ?").run(summaryJson, row.id);
  return JSON.parse(summaryJson) as ListSummary;
}

export function getProxyRequestById(id: number): LoggedRequest | null {
  const row = db.query("SELECT id, data FROM proxy_requests WHERE id = ?").get(id) as {
    id: number;
    data: string;
  } | null;
  if (!row) return null;
  return deserializeRequest(row);
}

export function getRequestsAfterId(lastId: number): LoggedRequest[] {
  const rows = db
    .query("SELECT id, data FROM proxy_requests WHERE id > ? ORDER BY id ASC")
    .all(lastId) as Array<{ id: number; data: string }>;
  return rows.map(deserializeRequest);
}

/** 获取指定 ID 范围内的请求（包含边界） */
export function getRequestsByIdRange(startId: number, endId: number): LoggedRequest[] {
  const rows = db
    .query("SELECT id, data FROM proxy_requests WHERE id >= ? AND id <= ? ORDER BY id DESC")
    .all(startId, endId) as Array<{ id: number; data: string }>;
  return rows.map(deserializeRequest);
}

export function getAllRequests(
  filters?: ProxyRequestFilters,
  pagination?: ProxyRequestPagination,
): LoggedRequest[] {
  const where: string[] = [];
  const params: any[] = [];

  if (filters?.instance_name !== undefined) {
    if (filters.instance_name === null) {
      where.push("instance_name IS NULL");
    } else {
      where.push("instance_name = ?");
      params.push(filters.instance_name);
    }
  }
  if (filters?.forward_name !== undefined) {
    if (filters.forward_name === null) {
      where.push("forward_name IS NULL");
    } else {
      where.push("forward_name = ?");
      params.push(filters.forward_name);
    }
  }
  if (filters?.method) {
    where.push("method = ?");
    params.push(filters.method);
  }
  if (filters?.status_code) {
    where.push("status_code = ?");
    params.push(filters.status_code);
  }
  if (filters?.url_pattern) {
    const raw = filters.url_pattern.trim().toLowerCase();
    if (raw.length > 0) {
      const looksLikeUrlPrefix =
        raw === "http" ||
        raw === "https" ||
        raw.startsWith("http://") ||
        raw.startsWith("https://") ||
        raw.startsWith("http:") ||
        raw.startsWith("https:");

      if (looksLikeUrlPrefix) {
        where.push("request_url_lc >= ? AND request_url_lc < ?");
        params.push(raw, `${raw}\uffff`);
      } else {
        const prefix = raw.startsWith("/") ? raw : `/${raw}`;
        where.push("request_path_lc >= ? AND request_path_lc < ?");
        params.push(prefix, `${prefix}\uffff`);
      }
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderDirection = pagination?.order === "asc" ? "ASC" : "DESC";
  // 用 id 排序（主键索引），比 timestamp 更快
  const order = `ORDER BY id ${orderDirection}`;

  // IMPORTANT(perf): avoid OFFSET scanning large `data` blobs.
  // When pagination is used, first fetch only IDs (cheap even with large rows), then fetch `data` for those IDs.
  if (pagination != null) {
    const limitSql = `LIMIT ${pagination.limit} OFFSET ${(pagination.page - 1) * pagination.limit}`;
    const idRows = db
      .query(`SELECT id FROM proxy_requests ${whereSql} ${order} ${limitSql}`)
      .all(...params) as Array<{ id: number }>;
    const ids = idRows.map((row) => row.id);
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .query(`SELECT id, data FROM proxy_requests WHERE id IN (${placeholders}) ${order}`)
      .all(...ids) as Array<{ id: number; data: string }>;
    return rows.map(deserializeRequest);
  }

  const rows = db
    .query(`SELECT id, data FROM proxy_requests ${whereSql} ${order}`)
    .all(...params) as Array<{ id: number; data: string }>;
  return rows.map(deserializeRequest);
}

/** 获取请求列表摘要（轻量化，不读取完整 data）*/
export function getAllRequestsSummary(
  filters?: ProxyRequestFilters,
  pagination?: ProxyRequestPagination,
): ListSummary[] {
  const where: string[] = [];
  const params: any[] = [];

  if (filters?.instance_name !== undefined) {
    if (filters.instance_name === null) {
      where.push("instance_name IS NULL");
    } else {
      where.push("instance_name = ?");
      params.push(filters.instance_name);
    }
  }
  if (filters?.forward_name !== undefined) {
    if (filters.forward_name === null) {
      where.push("forward_name IS NULL");
    } else {
      where.push("forward_name = ?");
      params.push(filters.forward_name);
    }
  }
  if (filters?.method) {
    where.push("method = ?");
    params.push(filters.method);
  }
  if (filters?.status_code) {
    where.push("status_code = ?");
    params.push(filters.status_code);
  }
  if (filters?.url_pattern) {
    const raw = filters.url_pattern.trim().toLowerCase();
    if (raw.length > 0) {
      const looksLikeUrlPrefix =
        raw === "http" ||
        raw === "https" ||
        raw.startsWith("http://") ||
        raw.startsWith("https://") ||
        raw.startsWith("http:") ||
        raw.startsWith("https:");

      if (looksLikeUrlPrefix) {
        where.push("request_url_lc >= ? AND request_url_lc < ?");
        params.push(raw, `${raw}\uffff`);
      } else {
        const prefix = raw.startsWith("/") ? raw : `/${raw}`;
        where.push("request_path_lc >= ? AND request_path_lc < ?");
        params.push(prefix, `${prefix}\uffff`);
      }
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderDirection = pagination?.order === "asc" ? "ASC" : "DESC";
  const order = `ORDER BY id ${orderDirection}`;

  if (pagination != null) {
    const limitSql = `LIMIT ${pagination.limit} OFFSET ${(pagination.page - 1) * pagination.limit}`;
    // 只读取 id 和 list_summary，不读 data
    const rows = db
      .query(`SELECT id, list_summary FROM proxy_requests ${whereSql} ${order} ${limitSql}`)
      .all(...params) as Array<{ id: number; list_summary: string | null }>;

    return rows.map(getOrComputeListSummary);
  }

  const rows = db
    .query(`SELECT id, list_summary FROM proxy_requests ${whereSql} ${order}`)
    .all(...params) as Array<{ id: number; list_summary: string | null }>;

  return rows.map(getOrComputeListSummary);
}

/** 模糊搜索（轻量化版本，返回 ListSummary） */
export function getAllRequestsSummaryFuzzy(
  filters: Omit<ProxyRequestFilters, "url_pattern"> | undefined,
  needle: string,
  options: {
    page: number;
    limit: number;
    order?: "asc" | "desc";
    signal?: AbortSignal;
  },
): ListSummary[] {
  const where: string[] = [];
  const params: any[] = [];

  if (filters?.instance_name !== undefined) {
    if (filters.instance_name === null) {
      where.push("instance_name IS NULL");
    } else {
      where.push("instance_name = ?");
      params.push(filters.instance_name);
    }
  }
  if (filters?.forward_name !== undefined) {
    if (filters.forward_name === null) {
      where.push("forward_name IS NULL");
    } else {
      where.push("forward_name = ?");
      params.push(filters.forward_name);
    }
  }
  if (filters?.method) {
    where.push("method = ?");
    params.push(filters.method);
  }
  if (filters?.status_code) {
    where.push("status_code = ?");
    params.push(filters.status_code);
  }
  const match = buildFtsMatchQuery(needle);
  if (!match) return [];
  if (options.signal?.aborted) return [];

  const orderDirection = options.order === "asc" ? "ASC" : "DESC";
  const limitSql = `LIMIT ${options.limit} OFFSET ${(options.page - 1) * options.limit}`;
  const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";

  const rows = db
    .query(
      `SELECT pr.id as id, pr.list_summary as list_summary
       FROM proxy_requests pr
       JOIN proxy_requests_fts fts ON fts.rowid = pr.id
       WHERE proxy_requests_fts MATCH ? ${whereSql}
       ORDER BY pr.id ${orderDirection}
       ${limitSql}`,
    )
    .all(match, ...params) as Array<{ id: number; list_summary: string | null }>;

  return rows.map(getOrComputeListSummary);
}

export function getRequestsCountFuzzy(
  filters: Omit<ProxyRequestFilters, "url_pattern"> | undefined,
  needle: string,
): number {
  const where: string[] = [];
  const params: any[] = [];

  if (filters?.instance_name !== undefined) {
    if (filters.instance_name === null) {
      where.push("pr.instance_name IS NULL");
    } else {
      where.push("pr.instance_name = ?");
      params.push(filters.instance_name);
    }
  }
  if (filters?.forward_name !== undefined) {
    if (filters.forward_name === null) {
      where.push("pr.forward_name IS NULL");
    } else {
      where.push("pr.forward_name = ?");
      params.push(filters.forward_name);
    }
  }
  if (filters?.method) {
    where.push("pr.method = ?");
    params.push(filters.method);
  }
  if (filters?.status_code) {
    where.push("pr.status_code = ?");
    params.push(filters.status_code);
  }

  const match = buildFtsMatchQuery(needle);
  if (!match) return 0;

  const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";
  const row = db
    .query(
      `SELECT COUNT(*) as count
       FROM proxy_requests pr
       JOIN proxy_requests_fts fts ON fts.rowid = pr.id
       WHERE proxy_requests_fts MATCH ? ${whereSql}`,
    )
    .get(match, ...params) as { count: number };
  return row.count;
}

export function getAllRequestsFuzzyLimited(
  filters: Omit<ProxyRequestFilters, "url_pattern"> | undefined,
  needle: string,
  options: {
    limit: number;
    order?: "asc" | "desc";
    signal?: AbortSignal;
  },
): LoggedRequest[] {
  const where: string[] = [];
  const params: any[] = [];

  if (filters?.instance_name !== undefined) {
    if (filters.instance_name === null) {
      where.push("instance_name IS NULL");
    } else {
      where.push("instance_name = ?");
      params.push(filters.instance_name);
    }
  }
  if (filters?.forward_name !== undefined) {
    if (filters.forward_name === null) {
      where.push("forward_name IS NULL");
    } else {
      where.push("forward_name = ?");
      params.push(filters.forward_name);
    }
  }
  if (filters?.method) {
    where.push("method = ?");
    params.push(filters.method);
  }
  if (filters?.status_code) {
    where.push("status_code = ?");
    params.push(filters.status_code);
  }
  const needleLc = needle.trim().toLowerCase();
  if (needleLc.length === 0) return [];

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderDirection = options.order === "asc" ? "ASC" : "DESC";
  const stmt = db.query(
    `SELECT id, data, request_url_lc, request_url FROM proxy_requests ${whereSql} ORDER BY id ${orderDirection}`,
  );

  const items: LoggedRequest[] = [];
  for (const row of stmt.iterate(...params) as IterableIterator<{ id: number; data: string; request_url_lc: string | null; request_url: string | null }>) {
    if (options.signal?.aborted) break;
    const hay = (row.request_url_lc ?? row.request_url ?? "").toLowerCase();
    if (!hay.includes(needleLc)) continue;
    items.push(deserializeRequest({ id: row.id, data: row.data }));
    if (items.length >= options.limit) break;
  }

  return items;
}

export function deleteProxyRequest(id: number): boolean {
  const result = db.query("DELETE FROM proxy_requests WHERE id = ?").run(id);
  if (result.changes > 0) {
    deleteRequestFtsRow(id);
    dbNotifier.notify("delete", "proxy_requests", id);
    requestEvents.emit("delete-request", id);
    return true;
  }
  return false;
}

export function clearAllRequests(): boolean {
  const res = db.query("DELETE FROM proxy_requests").run();
  clearAllRequestFtsRows();
  requestEvents.emit("clear-all");
  return res.changes > 0;
}

export function updateProxyRequest(id: number, updates: Partial<LoggedRequest>): boolean {
  const existing = getProxyRequestById(id);
  if (!existing) return false;

  const merged: LoggedRequest = {
    ...existing,
    ...updates,
    request: { ...existing.request, ...(updates as LoggedRequest).request },
    response: updates.response ? { ...existing.response, ...updates.response } : existing.response,
    hookedResponse: updates.hookedResponse !== undefined ? updates.hookedResponse : existing.hookedResponse,
    group_name:
      updates.group_name ??
      coerceGroupName(
        updates.instance_name ?? existing.instance_name,
        updates.forward_name ?? existing.forward_name,
      ),
  };

  const data = serializeRequest(merged);
  const urlCols = computeUrlColumns(merged.request?.url);
  const listSummary = computeListSummary(merged);
  const result = db
    .query(
      "UPDATE proxy_requests SET timestamp = ?, instance_name = ?, forward_name = ?, group_name = ?, status = ?, response_body_size = ?, request_url_lc = ?, request_path_lc = ?, list_summary = ?, data = ? WHERE id = ?",
    )
    .run(
      merged.timestamp,
      merged.instance_name,
      merged.forward_name,
      merged.group_name,
      merged.status,
      merged.response?.bodySize ?? 0,
      urlCols.request_url_lc,
      urlCols.request_path_lc,
      listSummary,
      data,
      id,
    );

    upsertRequestFtsRow(id, urlCols.request_url_lc, urlCols.request_path_lc);
  if (result.changes > 0) {
    const updated = getProxyRequestById(id);
    if (updated) {
      requestEvents.emit("updated", updated);
    }
    dbNotifier.notify("update", "proxy_requests", id);
    return true;
  }
  return false;
}

export function appendResponseBody(
  id: number,
  chunk: Buffer,
  contentType?: string | null,
): boolean {
  const existing = getProxyRequestById(id);
  if (!existing) return false;
  const prev = existing.response?.bodyDataUrl
    ? dataUrlToBuffer(existing.response.bodyDataUrl).buffer
    : Buffer.alloc(0);
  const nextBuffer = Buffer.concat([prev, chunk]);
  const nextDataUrl = bufferToDataUrl(
    nextBuffer,
    contentType ?? existing.response?.contentType ?? undefined,
  );
  const response = existing.response ?? {
    statusCode: null,
    statusMessage: null,
    headers: {},
    bodyDataUrl: null,
    bodySize: 0,
  };

  return updateProxyRequest(id, {
    response: {
      ...response,
      bodyDataUrl: nextDataUrl,
      bodySize: nextBuffer.length,
      contentType: contentType ?? response.contentType ?? null,
    },
  });
}

/**
 * 初始化 streaming 响应：首次收到响应头时调用，更新完整 JSON
 */
export function initStreamingResponse(
  id: number,
  ttfbMs: number,
  statusCode: number,
  statusMessage: string,
  headers: Record<string, string | string[]>,
): boolean {
  const existing = getProxyRequestById(id);
  if (!existing) return false;

  return updateProxyRequest(id, {
    status: "streaming",
    response: {
      statusCode,
      statusMessage,
      headers,
      bodyDataUrl: null,
      bodySize: 0,
      ttfbMs,
    },
  });
}

/**
 * 轻量更新：只更新 response_body_size 列（用于流式进度显示）
 * 不读取/修改 JSON，性能极高
 */
export function updateStreamingBodySize(id: number, bodySize: number): boolean {
  const result = db
    .query("UPDATE proxy_requests SET response_body_size = ? WHERE id = ?")
    .run(bodySize, id);

  if (result.changes > 0) {
    // 发送轻量更新通知（只包含 bodySize 变化）
    requestEvents.emit("body-size-updated", { id, bodySize });
    return true;
  }
  return false;
}

/**
 * 兼容旧接口：updateStreamingProgress
 * @deprecated 请使用 initStreamingResponse + updateStreamingBodySize
 */
export function updateStreamingProgress(
  id: number,
  bodySize: number,
  ttfbMs: number,
  statusCode?: number,
  statusMessage?: string,
  headers?: Record<string, string | string[]>,
): boolean {
  const existing = getProxyRequestById(id);
  if (!existing) return false;

  const response = existing.response ?? {
    statusCode: null,
    statusMessage: null,
    headers: {},
    bodyDataUrl: null,
    bodySize: 0,
  };

  return updateProxyRequest(id, {
    status: "streaming",
    response: {
      ...response,
      statusCode: statusCode ?? response.statusCode,
      statusMessage: statusMessage ?? response.statusMessage,
      headers: headers ?? response.headers,
      bodySize,
      ttfbMs: response.ttfbMs ?? ttfbMs,
    },
  });
}

export function createWebSocketMessage(params: {
  instance_name: string | null;
  forward_name: string | null;
  forward_id: string | null;
  connection_id: string;
  message_index: number;
  direction: "send" | "receive";
  url: string;
  message: Buffer | string;
  timestamp?: string;
}): number {
  const messageBuffer =
    typeof params.message === "string" ? Buffer.from(params.message, "utf-8") : params.message;
  const messageDataUrl = bufferToDataUrl(
    messageBuffer,
    typeof params.message === "string" ? "text/plain;charset=utf-8" : "application/octet-stream",
  );

  return createProxyRequest({
    request_id: `ws-${params.connection_id}-${params.message_index}`,
    timestamp: params.timestamp || new Date().toISOString(),
    instance_name: params.instance_name,
    forward_name: params.forward_name,
    forward_id: params.forward_id,
    group_name: coerceGroupName(params.instance_name, params.forward_name),
    status: "completed",
    abort_reason: null,
    is_websocket: true,
    websocket_direction: params.direction,
    error_message: null,
    request: {
      method: "WEBSOCKET",
      url: params.url,
      headers: {},
      bodyDataUrl: params.direction === "send" ? messageDataUrl : null,
      bodySize: params.direction === "send" ? messageBuffer.length : 0,
    },
    response:
      params.direction === "receive"
        ? {
            statusCode: null,
            statusMessage: null,
            headers: {},
            bodyDataUrl: messageDataUrl,
            bodySize: messageBuffer.length,
          }
        : undefined,
  });
}

/**
 * 清理孤儿 streaming/pending 记录
 * 程序重启后，之前的 streaming/pending 请求已无法继续，应标记为 aborted
 */
export function cleanupOrphanStreamingRequests(): number {
  const result = db.query(`
    UPDATE proxy_requests
    SET status = 'aborted',
        data = JSON_SET(data, '$.status', 'aborted', '$.abort_reason', 'server_restart')
    WHERE status IN ('streaming', 'pending')
  `).run();

  if (result.changes > 0) {
    console.log(`[Database] Cleaned up ${result.changes} orphan streaming/pending requests`);
  }

  return result.changes;
}

/**
 * 获取请求总数（用于分页）
 */
export function getRequestsCount(filters?: ProxyRequestFilters): number {
  const where: string[] = [];
  const params: any[] = [];

  if (filters?.instance_name !== undefined) {
    if (filters.instance_name === null) {
      where.push("instance_name IS NULL");
    } else {
      where.push("instance_name = ?");
      params.push(filters.instance_name);
    }
  }
  if (filters?.forward_name !== undefined) {
    if (filters.forward_name === null) {
      where.push("forward_name IS NULL");
    } else {
      where.push("forward_name = ?");
      params.push(filters.forward_name);
    }
  }
  if (filters?.method) {
    where.push("method = ?");
    params.push(filters.method);
  }
  if (filters?.status_code) {
    where.push("status_code = ?");
    params.push(filters.status_code);
  }
  if (filters?.url_pattern) {
    const raw = filters.url_pattern.trim().toLowerCase();
    if (raw.length > 0) {
      const looksLikeUrlPrefix =
        raw === "http" ||
        raw === "https" ||
        raw.startsWith("http://") ||
        raw.startsWith("https://") ||
        raw.startsWith("http:") ||
        raw.startsWith("https:");

      if (looksLikeUrlPrefix) {
        where.push("request_url_lc >= ? AND request_url_lc < ?");
        params.push(raw, `${raw}\uffff`);
      } else {
        const prefix = raw.startsWith("/") ? raw : `/${raw}`;
        where.push("request_path_lc >= ? AND request_path_lc < ?");
        params.push(prefix, `${prefix}\uffff`);
      }
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const row = db.query(`SELECT COUNT(*) as count FROM proxy_requests ${whereSql}`).get(...params) as { count: number };
  return row.count;
}

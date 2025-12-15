import { EventEmitter } from "events";
import { Buffer } from "node:buffer";
import { db } from "./db";
import { dbNotifier } from "./db-notifier";
import { bufferToDataUrl, dataUrlToBuffer, ensureDataUrl, isDataUrl } from "./data-url";

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
  group_name: string | null;
  status: RequestStatus;
  abort_reason: AbortReason | null;
  is_websocket: boolean;
  websocket_direction: WebSocketDirection;
  error_message: string | null;
  request: RequestData;
  /** hooks 处理后的请求（如果有 request hook） */
  hookedRequest?: RequestData;
  response?: ResponseData;
  /** hooks 处理后的响应（如果有 response hook） */
  hookedResponse?: ResponseData;
}

export interface ProxyRequestFilters {
  forward_name?: string | null;
  method?: string;
  status_code?: number;
  url_pattern?: string;
}

export interface ProxyRequestPagination {
  page: number;
  limit: number;
}

export const requestEvents = new EventEmitter();

function serializeRequest(req: LoggedRequest): string {
  return JSON.stringify(req);
}

function deserializeRequest(row: { id: number; data: string }): LoggedRequest {
  const parsed = JSON.parse(row.data) as LoggedRequest;
  parsed.id = row.id;
  parsed.abort_reason ??= null;
  return parsed;
}

function coerceGroupName(instance: string | null, forward: string | null): string | null {
  if (instance && forward) return `${instance}/${forward}`;
  if (instance) return instance;
  return null;
}

export function createProxyRequest(request: Omit<LoggedRequest, "id">): number {
  const data = serializeRequest({
    ...request,
    group_name: request.group_name ?? coerceGroupName(request.instance_name, request.forward_name),
  });
  const stmt = db.query(
    "INSERT INTO proxy_requests (timestamp, instance_name, forward_name, group_name, data) VALUES (?, ?, ?, ?, ?)",
  );
  const result = stmt.run(
    request.timestamp,
    request.instance_name,
    request.forward_name,
    request.group_name ?? coerceGroupName(request.instance_name, request.forward_name),
    data,
  );
  const id = Number(result.lastInsertRowid);

  const created = getProxyRequestById(id);
  if (created) {
    requestEvents.emit("created", created);
  }
  dbNotifier.notify("insert", "proxy_requests", id);
  return id;
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

export function getAllRequests(
  filters?: ProxyRequestFilters,
  pagination?: ProxyRequestPagination,
): LoggedRequest[] {
  const where: string[] = [];
  const params: any[] = [];

  if (filters?.forward_name !== undefined) {
    if (filters.forward_name === null) {
      where.push("forward_name IS NULL");
    } else {
      where.push("forward_name = ?");
      params.push(filters.forward_name);
    }
  }
  if (filters?.method) {
    where.push("JSON_EXTRACT(data, '$.request.method') = ?");
    params.push(filters.method);
  }
  if (filters?.status_code) {
    where.push("JSON_EXTRACT(data, '$.response.statusCode') = ?");
    params.push(filters.status_code);
  }
  if (filters?.url_pattern) {
    where.push("JSON_EXTRACT(data, '$.request.url') LIKE ?");
    params.push(`%${filters.url_pattern}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const order = "ORDER BY timestamp DESC";
  const limitSql =
    pagination != null
      ? `LIMIT ${pagination.limit} OFFSET ${(pagination.page - 1) * pagination.limit}`
      : "";

  const rows = db
    .query(`SELECT id, data FROM proxy_requests ${whereSql} ${order} ${limitSql}`)
    .all(...params) as Array<{ id: number; data: string }>;

  return rows.map(deserializeRequest);
}

export function deleteProxyRequest(id: number): boolean {
  const result = db.query("DELETE FROM proxy_requests WHERE id = ?").run(id);
  if (result.changes > 0) {
    dbNotifier.notify("delete", "proxy_requests", id);
    requestEvents.emit("delete-request", id);
    return true;
  }
  return false;
}

export function clearAllRequests(): boolean {
  const res = db.query("DELETE FROM proxy_requests").run();
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
    group_name:
      updates.group_name ??
      coerceGroupName(
        updates.instance_name ?? existing.instance_name,
        updates.forward_name ?? existing.forward_name,
      ),
  };

  const data = serializeRequest(merged);
  const result = db
    .query(
      "UPDATE proxy_requests SET timestamp = ?, instance_name = ?, forward_name = ?, group_name = ?, data = ? WHERE id = ?",
    )
    .run(merged.timestamp, merged.instance_name, merged.forward_name, merged.group_name, data, id);

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
 * 轻量更新：只更新响应的 bodySize 和 status（用于流式进度显示）
 * 不存储实际 body 内容，避免频繁写入大量数据
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

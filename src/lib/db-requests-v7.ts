/**
 * Database Requests API v7 - 分表架构
 * 
 * 核心改进：
 * 1. 主表 requests 只存元数据，列表查询极快
 * 2. Bodies 表独立存储，支持流式增量写入
 * 3. Hook Layers 有独立的 body 记录
 * 4. 所有 body 存储为 BLOB，不用 base64 编码
 */

import { EventEmitter } from "events";
import { Buffer } from "node:buffer";
import { db } from "./db";
import { dbNotifier } from "./db-notifier";
import type { BodyStage } from "./db-schema-v7";
import { parsePrivateHeaders } from "@jixo/proxy-plugin";

// ============================================================================
// Types
// ============================================================================

export type AbortReason = "client_disconnect" | "user_abort" | "server_restart";
export type RequestStatus = "pending" | "streaming" | "completed" | "error" | "aborted";
export type WebSocketDirection = "send" | "receive" | null;

// 插件信息类型
export interface PluginInfo {
  pluginOrigin?: string;
  pluginsProcessed?: string[];
  requestType?: string;
  sessionId?: string;
  pingCount?: number;
}

// 内部类型，用于 v7 原生查询结果
type InternalListSummary = {
  id: number;
  request_id: string;
  timestamp: string;
  instance_name: string | null;
  forward_name: string | null;
  forward_id: string | null;
  method: string;
  url: string;
  status: RequestStatus;
  error_message: string | null;
  abort_reason: AbortReason | null;
  status_code: number | null;
  content_type: string | null;
  ttfb_ms: number | null;
  body_ms: number | null;
  request_body_size: number;
  response_body_size: number;
  has_request_hook_changes: boolean;
  has_response_hook_changes: boolean;
  is_websocket: boolean;
  plugin_info: string | null;
};

/** 主表记录 */
export interface RequestRecord {
  id: number;
  request_id: string;
  timestamp: string;
  instance_name: string | null;
  forward_name: string | null;
  forward_id: string | null;
  method: string;
  url: string;
  status: RequestStatus;
  error_message: string | null;
  abort_reason: AbortReason | null;
  status_code: number | null;
  status_message: string | null;
  content_type: string | null;
  ttfb_ms: number | null;
  body_ms: number | null;
  request_body_size: number;
  response_body_size: number;
  has_request_hook_changes: boolean;
  has_response_hook_changes: boolean;
  is_websocket: boolean;
  websocket_direction: WebSocketDirection;
}

/** Headers 记录 */
export interface HeadersRecord {
  request_id: number;
  stage: string;
  headers: Record<string, string | string[]>;
}

/** Body 记录 */
export interface BodyRecord {
  request_id: number;
  stage: BodyStage;
  content_type: string | null;
  body: Buffer | null;
  body_size: number;
}

/** Hook Layer 记录 */
export interface HookLayerRecord {
  request_id: number;
  direction: "request" | "response";
  layer_index: number;
  plugin_name: string;
  modified: boolean;
  status_code?: number | null;
  status_message?: string | null;
}

/** 创建请求的输入参数 */
export interface CreateRequestInput {
  request_id: string;
  timestamp: string;
  instance_name: string | null;
  forward_name: string | null;
  forward_id: string | null;
  method: string;
  url: string;
  request_headers: Record<string, string | string[]>;
  request_body?: Buffer | null;
  request_content_type?: string | null;
  forwarded_headers?: Record<string, string | string[]>;
  target_url?: string;
  is_websocket?: boolean;
  websocket_direction?: WebSocketDirection;
  plugin_info?: PluginInfo;
}

/** 更新请求 hook 结果的输入 */
export interface UpdateRequestHookInput {
  hooked_method?: string;
  hooked_url?: string;
  hooked_headers?: Record<string, string | string[]>;
  hooked_body?: Buffer | null;
  hooked_content_type?: string | null;
  layers?: Array<{
    plugin_name: string;
    modified: boolean;
    headers?: Record<string, string | string[]>;
    body?: Buffer | null;
    content_type?: string | null;
  }>;
}

/** 更新响应的输入 */
export interface UpdateResponseInput {
  status_code: number;
  status_message: string;
  headers: Record<string, string | string[]>;
  content_type?: string | null;
  ttfb_ms?: number;
}

/** 完成响应的输入 */
export interface FinalizeResponseInput {
  body: Buffer;
  body_ms?: number;
  // 如果有 hook 变更
  has_hook_changes?: boolean;
  original_status_code?: number;
  original_status_message?: string;
  original_headers?: Record<string, string | string[]>;
  original_body?: Buffer;
  original_content_type?: string | null;
  // Hook layers
  layers?: Array<{
    plugin_name: string;
    modified: boolean;
    status_code?: number;
    status_message?: string;
    headers?: Record<string, string | string[]>;
    body?: Buffer | null;
    content_type?: string | null;
  }>;
  // 插件信息（响应完成时可能需要更新）
  plugin_info?: PluginInfo;
}

// 注意：ListSummary 在文件后面定义为兼容旧格式的接口
// InternalListSummary 用于 v7 原生查询结果

/** 完整请求详情（用于详情页） */
export interface RequestDetail {
  // 基础信息
  id: number;
  request_id: string;
  timestamp: string;
  instance_name: string | null;
  forward_name: string | null;
  forward_id: string | null;
  method: string;
  url: string;
  status: RequestStatus;
  error_message: string | null;
  abort_reason: AbortReason | null;
  
  // 响应信息
  status_code: number | null;
  status_message: string | null;
  content_type: string | null;
  ttfb_ms: number | null;
  body_ms: number | null;
  
  // Headers
  request_headers: Record<string, string | string[]>;
  forwarded_headers?: Record<string, string | string[]>;
  response_headers?: Record<string, string | string[]>;
  hooked_request_headers?: Record<string, string | string[]>;
  hooked_response_headers?: Record<string, string | string[]>;
  
  // Bodies
  request_body: Buffer | null;
  request_body_size: number;
  response_body: Buffer | null;
  response_body_size: number;
  hooked_request_body?: Buffer | null;
  hooked_response_body?: Buffer | null;
  
  // Hook 状态
  has_request_hook_changes: boolean;
  has_response_hook_changes: boolean;
  
  // Hook Layers
  request_hook_layers?: HookLayerDetail[];
  response_hook_layers?: HookLayerDetail[];
  
  // WebSocket
  is_websocket: boolean;
  websocket_direction: WebSocketDirection;
}

export interface HookLayerDetail {
  plugin_name: string;
  modified: boolean;
  status_code?: number | null;
  status_message?: string | null;
  headers?: Record<string, string | string[]>;
  body?: Buffer | null;
  body_size?: number;
  content_type?: string | null;
}

// ============================================================================
// Event Emitter
// ============================================================================

export const requestEvents = new EventEmitter();

// ============================================================================
// Helper Functions
// ============================================================================

function computeUrlColumns(url: string): { url_lc: string; path_lc: string | null } {
  const url_lc = url.toLowerCase();
  try {
    const path_lc = new URL(url).pathname.toLowerCase();
    return { url_lc, path_lc };
  } catch {
    return { url_lc, path_lc: null };
  }
}

function parseHeaders(json: string | null): Record<string, string | string[]> {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * 创建新请求记录
 */
export function createRequest(input: CreateRequestInput): number {
  const { url_lc, path_lc } = computeUrlColumns(input.url);
  
  const stmt = db.query(`
    INSERT INTO requests (
      request_id, timestamp, instance_name, forward_name, forward_id,
      method, url, url_lc, path_lc,
      status, request_body_size, is_websocket, websocket_direction, plugin_info
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `);
  
  const result = stmt.run(
    input.request_id,
    input.timestamp,
    input.instance_name,
    input.forward_name,
    input.forward_id,
    input.method,
    input.url,
    url_lc,
    path_lc,
    input.request_body?.length ?? 0,
    input.is_websocket ? 1 : 0,
    input.websocket_direction ?? null,
    input.plugin_info ? JSON.stringify(input.plugin_info) : null,
  );
  
  const id = Number(result.lastInsertRowid);
  
  // 存储请求 headers
  db.query(`
    INSERT INTO request_headers (request_id, stage, headers)
    VALUES (?, 'request_origin', ?)
  `).run(id, JSON.stringify(input.request_headers));
  
  // 存储 forwarded headers（如果有）
  if (input.forwarded_headers) {
    db.query(`
      INSERT INTO request_headers (request_id, stage, headers)
      VALUES (?, 'request_forwarded', ?)
    `).run(id, JSON.stringify(input.forwarded_headers));
  }
  
  // 存储请求 body（如果有）
  if (input.request_body && input.request_body.length > 0) {
    db.query(`
      INSERT INTO request_bodies (request_id, stage, content_type, body, body_size)
      VALUES (?, 'request_origin', ?, ?, ?)
    `).run(id, input.request_content_type ?? null, input.request_body, input.request_body.length);
  }
  
  requestEvents.emit("created", id);
  dbNotifier.notify("insert", "requests", id);
  
  return id;
}

/**
 * 更新请求 hook 结果
 */
export function updateRequestHook(id: number, input: UpdateRequestHookInput): boolean {
  // 更新主表标记
  db.query(`
    UPDATE requests SET has_request_hook_changes = 1 WHERE id = ?
  `).run(id);
  
  // 存储 hooked headers
  if (input.hooked_headers) {
    db.query(`
      INSERT OR REPLACE INTO request_headers (request_id, stage, headers)
      VALUES (?, 'request_hooked', ?)
    `).run(id, JSON.stringify(input.hooked_headers));
  }
  
  // 存储 hooked body
  if (input.hooked_body && input.hooked_body.length > 0) {
    db.query(`
      INSERT OR REPLACE INTO request_bodies (request_id, stage, content_type, body, body_size)
      VALUES (?, 'request_hooked', ?, ?, ?)
    `).run(id, input.hooked_content_type ?? null, input.hooked_body, input.hooked_body.length);
  }
  
  // 存储 layers
  if (input.layers) {
    for (let i = 0; i < input.layers.length; i++) {
      const layer = input.layers[i]!;
      db.query(`
        INSERT OR REPLACE INTO hook_layers (request_id, direction, layer_index, plugin_name, modified)
        VALUES (?, 'request', ?, ?, ?)
      `).run(id, i, layer.plugin_name, layer.modified ? 1 : 0);
      
      if (layer.headers) {
        db.query(`
          INSERT OR REPLACE INTO request_headers (request_id, stage, headers)
          VALUES (?, ?, ?)
        `).run(id, `request_layer_${i}`, JSON.stringify(layer.headers));
      }
      
      if (layer.body && layer.body.length > 0) {
        db.query(`
          INSERT OR REPLACE INTO request_bodies (request_id, stage, content_type, body, body_size)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, `request_layer_${i}`, layer.content_type ?? null, layer.body, layer.body.length);
      }
    }
  }
  
  dbNotifier.notify("update", "requests", id);
  return true;
}

/**
 * 初始化响应（收到响应头时调用）
 */
export function initResponse(id: number, input: UpdateResponseInput): boolean {
  db.query(`
    UPDATE requests SET
      status = 'streaming',
      status_code = ?,
      status_message = ?,
      content_type = ?,
      ttfb_ms = ?
    WHERE id = ?
  `).run(input.status_code, input.status_message ?? null, input.content_type ?? null, input.ttfb_ms ?? null, id);
  
  // 存储响应 headers
  db.query(`
    INSERT OR REPLACE INTO request_headers (request_id, stage, headers)
    VALUES (?, 'response_origin', ?)
  `).run(id, JSON.stringify(input.headers));
  
  dbNotifier.notify("update", "requests", id);
  return true;
}

/**
 * 更新流式进度（兼容旧接口，支持 6 参数签名）
 */
export function updateStreamingProgress(
  id: number,
  bodySize: number,
  ttfbMs?: number,
  statusCode?: number,
  statusMessage?: string,
  headers?: Record<string, string | string[]>,
): boolean {
  // 如果提供了额外参数，同时更新状态
  if (ttfbMs !== undefined || statusCode !== undefined) {
    db.query(`
      UPDATE requests SET 
        response_body_size = ?,
        status = 'streaming',
        ttfb_ms = COALESCE(?, ttfb_ms),
        status_code = COALESCE(?, status_code),
        status_message = COALESCE(?, status_message)
      WHERE id = ?
    `).run(bodySize, ttfbMs ?? null, statusCode ?? null, statusMessage ?? null, id);
    
    // 存储响应 headers（如果提供）
    if (headers) {
      db.query(`
        INSERT OR REPLACE INTO request_headers (request_id, stage, headers)
        VALUES (?, 'response_origin', ?)
      `).run(id, JSON.stringify(headers));
    }
  } else {
    db.query(`
      UPDATE requests SET response_body_size = ? WHERE id = ?
    `).run(bodySize, id);
  }
  
  requestEvents.emit("body-size-updated", { id, bodySize });
  return true;
}

/**
 * 完成响应（流式结束时调用）
 */
export function finalizeResponse(id: number, input: FinalizeResponseInput): boolean {
  // 更新主表
  db.query(`
    UPDATE requests SET
      status = 'completed',
      response_body_size = ?,
      body_ms = ?,
      has_response_hook_changes = ?,
      plugin_info = COALESCE(?, plugin_info)
    WHERE id = ?
  `).run(
    input.body.length,
    input.body_ms ?? null,
    input.has_hook_changes ? 1 : 0,
    input.plugin_info ? JSON.stringify(input.plugin_info) : null,
    id,
  );
  
  // 根据是否有 hook 变更决定存储策略
  if (input.has_hook_changes && input.original_body) {
    // 有变更：存储原始响应和 hooked 响应
    
    // 原始响应 body
    db.query(`
      INSERT OR REPLACE INTO request_bodies (request_id, stage, content_type, body, body_size)
      VALUES (?, 'response_origin', ?, ?, ?)
    `).run(id, input.original_content_type ?? null, input.original_body, input.original_body.length);
    
    // 原始响应 headers（如果有）
    if (input.original_headers) {
      db.query(`
        INSERT OR REPLACE INTO request_headers (request_id, stage, headers)
        VALUES (?, 'response_origin', ?)
      `).run(id, JSON.stringify(input.original_headers));
    }
    
    // Hooked 响应 body
    db.query(`
      INSERT OR REPLACE INTO request_bodies (request_id, stage, content_type, body, body_size)
      VALUES (?, 'response_hooked', ?, ?, ?)
    `).run(id, null, input.body, input.body.length);
    
  } else {
    // 无变更：只存储最终响应
    db.query(`
      INSERT OR REPLACE INTO request_bodies (request_id, stage, content_type, body, body_size)
      VALUES (?, 'response_origin', ?, ?, ?)
    `).run(id, null, input.body, input.body.length);
  }
  
  // 存储 response hook layers
  if (input.layers) {
    for (let i = 0; i < input.layers.length; i++) {
      const layer = input.layers[i]!;
      db.query(`
        INSERT OR REPLACE INTO hook_layers (request_id, direction, layer_index, plugin_name, modified, status_code, status_message)
        VALUES (?, 'response', ?, ?, ?, ?, ?)
      `).run(id, i, layer.plugin_name, layer.modified ? 1 : 0, layer.status_code ?? null, layer.status_message ?? null);
      
      if (layer.headers) {
        db.query(`
          INSERT OR REPLACE INTO request_headers (request_id, stage, headers)
          VALUES (?, ?, ?)
        `).run(id, `response_layer_${i}`, JSON.stringify(layer.headers));
      }
      
      if (layer.body && layer.body.length > 0) {
        db.query(`
          INSERT OR REPLACE INTO request_bodies (request_id, stage, content_type, body, body_size)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, `response_layer_${i}`, layer.content_type ?? null, layer.body, layer.body.length);
      }
    }
  }
  
  requestEvents.emit("updated", id);
  dbNotifier.notify("update", "requests", id);
  return true;
}

/**
 * 标记请求为错误
 */
export function markRequestError(id: number, errorMessage: string): boolean {
  db.query(`
    UPDATE requests SET status = 'error', error_message = ? WHERE id = ?
  `).run(errorMessage, id);
  
  dbNotifier.notify("update", "requests", id);
  return true;
}

/**
 * 标记请求为中断
 */
export function markRequestAborted(id: number, reason: AbortReason): boolean {
  db.query(`
    UPDATE requests SET status = 'aborted', abort_reason = ? WHERE id = ?
  `).run(reason, id);
  
  dbNotifier.notify("update", "requests", id);
  return true;
}

/**
 * 获取请求列表摘要（内部使用，返回 v7 原生格式）
 */
function getRequestsSummaryInternal(options?: {
  filters?: {
    instance_name?: string | null;
    forward_name?: string | null;
    method?: string;
    status_code?: number;
    url_pattern?: string;
  };
  pagination?: {
    page: number;
    limit: number;
    order?: "asc" | "desc";
  };
}): InternalListSummary[] {
  const where: string[] = [];
  const params: any[] = [];
  
  if (options?.filters?.instance_name !== undefined) {
    if (options.filters.instance_name === null) {
      where.push("instance_name IS NULL");
    } else {
      where.push("instance_name = ?");
      params.push(options.filters.instance_name);
    }
  }
  if (options?.filters?.forward_name !== undefined) {
    if (options.filters.forward_name === null) {
      where.push("forward_name IS NULL");
    } else {
      where.push("forward_name = ?");
      params.push(options.filters.forward_name);
    }
  }
  if (options?.filters?.method) {
    where.push("method = ?");
    params.push(options.filters.method);
  }
  if (options?.filters?.status_code) {
    where.push("status_code = ?");
    params.push(options.filters.status_code);
  }
  if (options?.filters?.url_pattern) {
    const raw = options.filters.url_pattern.trim().toLowerCase();
    if (raw.length > 0) {
      const looksLikeUrlPrefix =
        raw === "http" ||
        raw === "https" ||
        raw.startsWith("http://") ||
        raw.startsWith("https://") ||
        raw.startsWith("http:") ||
        raw.startsWith("https:");
      if (looksLikeUrlPrefix) {
        where.push("url_lc LIKE ?");
        params.push(`${raw}%`);
      } else {
        const prefix = raw.startsWith("/") ? raw : `/${raw}`;
        where.push("path_lc LIKE ?");
        params.push(`${prefix}%`);
      }
    }
  }
  
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderDirection = options?.pagination?.order === "asc" ? "ASC" : "DESC";
  
  let sql = `
    SELECT id, request_id, timestamp, instance_name, forward_name, forward_id,
           method, url, status, error_message, abort_reason, status_code,
           content_type, ttfb_ms, body_ms, request_body_size, response_body_size,
           has_request_hook_changes, has_response_hook_changes, is_websocket, plugin_info
    FROM requests ${whereSql}
    ORDER BY id ${orderDirection}
  `;
  
  if (options?.pagination) {
    const offset = (options.pagination.page - 1) * options.pagination.limit;
    sql += ` LIMIT ${options.pagination.limit} OFFSET ${offset}`;
  }
  
  const rows = db.query(sql).all(...params) as any[];
  
  return rows.map(row => ({
    id: row.id,
    request_id: row.request_id,
    timestamp: row.timestamp,
    instance_name: row.instance_name,
    forward_name: row.forward_name,
    forward_id: row.forward_id,
    method: row.method,
    url: row.url,
    status: row.status,
    error_message: row.error_message,
    abort_reason: row.abort_reason,
    status_code: row.status_code,
    content_type: row.content_type,
    ttfb_ms: row.ttfb_ms,
    body_ms: row.body_ms,
    request_body_size: row.request_body_size,
    response_body_size: row.response_body_size,
    has_request_hook_changes: Boolean(row.has_request_hook_changes),
    has_response_hook_changes: Boolean(row.has_response_hook_changes),
    is_websocket: Boolean(row.is_websocket),
    plugin_info: row.plugin_info,
  }));
}

/**
 * 获取请求总数
 */
export function getRequestsCount(filters?: {
  instance_name?: string | null;
  forward_name?: string | null;
  method?: string;
  status_code?: number;
  url_pattern?: string;
}): number {
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
  
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const row = db.query(`SELECT COUNT(*) as count FROM requests ${whereSql}`).get(...params) as { count: number };
  return row.count;
}

/**
 * 获取请求完整详情
 */
export function getRequestDetail(id: number): RequestDetail | null {
  // 获取主表记录
  const row = db.query(`
    SELECT * FROM requests WHERE id = ?
  `).get(id) as any;
  
  if (!row) return null;
  
  // 获取所有 headers
  const headersRows = db.query(`
    SELECT stage, headers FROM request_headers WHERE request_id = ?
  `).all(id) as Array<{ stage: string; headers: string }>;
  
  const headersMap = new Map<string, Record<string, string | string[]>>();
  for (const h of headersRows) {
    headersMap.set(h.stage, parseHeaders(h.headers));
  }
  
  // 获取所有 bodies
  // 注意：SQLite BLOB 返回 Uint8Array，需要转换为 Buffer
  const bodiesRows = db.query(`
    SELECT stage, content_type, body, body_size FROM request_bodies WHERE request_id = ?
  `).all(id) as Array<{ stage: string; content_type: string | null; body: Uint8Array | null; body_size: number }>;
  
  const bodiesMap = new Map<string, { content_type: string | null; body: Buffer | null; body_size: number }>();
  for (const b of bodiesRows) {
    // 将 Uint8Array 转换为 Buffer，以便后续 bufferToDataUrl 能正确处理
    const bodyBuffer = b.body ? Buffer.from(b.body) : null;
    bodiesMap.set(b.stage, { content_type: b.content_type, body: bodyBuffer, body_size: b.body_size });
  }
  
  // 获取 hook layers
  const layersRows = db.query(`
    SELECT direction, layer_index, plugin_name, modified, status_code, status_message
    FROM hook_layers WHERE request_id = ?
    ORDER BY layer_index ASC
  `).all(id) as Array<{
    direction: string;
    layer_index: number;
    plugin_name: string;
    modified: number;
    status_code: number | null;
    status_message: string | null;
  }>;
  
  const requestLayers: HookLayerDetail[] = [];
  const responseLayers: HookLayerDetail[] = [];
  
  for (const layer of layersRows) {
    const stage = `${layer.direction}_layer_${layer.layer_index}`;
    const layerDetail: HookLayerDetail = {
      plugin_name: layer.plugin_name,
      modified: Boolean(layer.modified),
      status_code: layer.status_code,
      status_message: layer.status_message,
      headers: headersMap.get(stage),
      body: bodiesMap.get(stage)?.body,
      body_size: bodiesMap.get(stage)?.body_size,
      content_type: bodiesMap.get(stage)?.content_type,
    };
    
    if (layer.direction === "request") {
      requestLayers.push(layerDetail);
    } else {
      responseLayers.push(layerDetail);
    }
  }
  
  return {
    id: row.id,
    request_id: row.request_id,
    timestamp: row.timestamp,
    instance_name: row.instance_name,
    forward_name: row.forward_name,
    forward_id: row.forward_id,
    method: row.method,
    url: row.url,
    status: row.status,
    error_message: row.error_message,
    abort_reason: row.abort_reason,
    status_code: row.status_code,
    status_message: row.status_message,
    content_type: row.content_type,
    ttfb_ms: row.ttfb_ms,
    body_ms: row.body_ms,
    
    request_headers: headersMap.get("request_origin") ?? {},
    forwarded_headers: headersMap.get("request_forwarded"),
    response_headers: headersMap.get("response_origin"),
    hooked_request_headers: headersMap.get("request_hooked"),
    hooked_response_headers: headersMap.get("response_hooked"),
    
    request_body: bodiesMap.get("request_origin")?.body ?? null,
    request_body_size: row.request_body_size,
    response_body: bodiesMap.get("response_origin")?.body ?? null,
    response_body_size: row.response_body_size,
    hooked_request_body: bodiesMap.get("request_hooked")?.body,
    hooked_response_body: bodiesMap.get("response_hooked")?.body,
    
    has_request_hook_changes: Boolean(row.has_request_hook_changes),
    has_response_hook_changes: Boolean(row.has_response_hook_changes),
    
    request_hook_layers: requestLayers.length > 0 ? requestLayers : undefined,
    response_hook_layers: responseLayers.length > 0 ? responseLayers : undefined,
    
    is_websocket: Boolean(row.is_websocket),
    websocket_direction: row.websocket_direction,
  };
}

/**
 * 删除请求
 */
export function deleteRequest(id: number): boolean {
  const result = db.query("DELETE FROM requests WHERE id = ?").run(id);
  if (result.changes > 0) {
    dbNotifier.notify("delete", "requests", id);
    requestEvents.emit("delete-request", id);
    return true;
  }
  return false;
}

/**
 * 清空所有请求
 */
export function clearAllRequests(): boolean {
  db.query("DELETE FROM requests").run();
  requestEvents.emit("clear-all");
  return true;
}

/**
 * 清理孤儿 streaming/pending 记录
 */
export function cleanupOrphanRequests(): number {
  const result = db.query(`
    UPDATE requests
    SET status = 'aborted', abort_reason = 'server_restart'
    WHERE status IN ('streaming', 'pending')
  `).run();
  
  if (result.changes > 0) {
    console.log(`[Database] Cleaned up ${result.changes} orphan streaming/pending requests`);
  }
  
  return result.changes;
}

/**
 * 模糊搜索请求（内部使用，返回 v7 原生格式）
 */
function searchRequestsFuzzyInternal(
  needle: string,
  options?: {
    filters?: {
      instance_name?: string | null;
      forward_name?: string | null;
      method?: string;
      status_code?: number;
    };
    pagination?: {
      page: number;
      limit: number;
      order?: "asc" | "desc";
    };
  },
): InternalListSummary[] {
  const raw = needle.trim().toLowerCase();
  if (raw.length === 0) return [];
  
  // 构建 FTS match query
  const tokens = raw.match(/[a-z0-9]+/g) ?? [];
  if (tokens.length === 0) return [];
  
  const match = tokens.map(t => t.length >= 3 ? `${t}*` : t).join(" ");
  
  const where: string[] = [];
  const params: any[] = [match];
  
  if (options?.filters?.instance_name !== undefined) {
    if (options.filters.instance_name === null) {
      where.push("r.instance_name IS NULL");
    } else {
      where.push("r.instance_name = ?");
      params.push(options.filters.instance_name);
    }
  }
  if (options?.filters?.forward_name !== undefined) {
    if (options.filters.forward_name === null) {
      where.push("r.forward_name IS NULL");
    } else {
      where.push("r.forward_name = ?");
      params.push(options.filters.forward_name);
    }
  }
  if (options?.filters?.method) {
    where.push("r.method = ?");
    params.push(options.filters.method);
  }
  if (options?.filters?.status_code) {
    where.push("r.status_code = ?");
    params.push(options.filters.status_code);
  }
  
  const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";
  const orderDirection = options?.pagination?.order === "asc" ? "ASC" : "DESC";
  
  let sql = `
    SELECT r.id, r.request_id, r.timestamp, r.instance_name, r.forward_name, r.forward_id,
           r.method, r.url, r.status, r.error_message, r.abort_reason, r.status_code,
           r.content_type, r.ttfb_ms, r.body_ms, r.request_body_size, r.response_body_size,
           r.has_request_hook_changes, r.has_response_hook_changes, r.is_websocket, r.plugin_info
    FROM requests r
    JOIN requests_fts fts ON fts.rowid = r.id
    WHERE requests_fts MATCH ? ${whereSql}
    ORDER BY r.id ${orderDirection}
  `;
  
  if (options?.pagination) {
    const offset = (options.pagination.page - 1) * options.pagination.limit;
    sql += ` LIMIT ${options.pagination.limit} OFFSET ${offset}`;
  }
  
  const rows = db.query(sql).all(...params) as any[];
  
  return rows.map(row => ({
    id: row.id,
    request_id: row.request_id,
    timestamp: row.timestamp,
    instance_name: row.instance_name,
    forward_name: row.forward_name,
    forward_id: row.forward_id,
    method: row.method,
    url: row.url,
    status: row.status,
    error_message: row.error_message,
    abort_reason: row.abort_reason,
    status_code: row.status_code,
    content_type: row.content_type,
    ttfb_ms: row.ttfb_ms,
    body_ms: row.body_ms,
    request_body_size: row.request_body_size,
    response_body_size: row.response_body_size,
    has_request_hook_changes: Boolean(row.has_request_hook_changes),
    has_response_hook_changes: Boolean(row.has_response_hook_changes),
    is_websocket: Boolean(row.is_websocket),
    plugin_info: row.plugin_info,
  }));
}

/**
 * 获取模糊搜索结果数量
 */
export function searchRequestsCountFuzzy(
  needle: string,
  filters?: {
    instance_name?: string | null;
    forward_name?: string | null;
    method?: string;
    status_code?: number;
  },
): number {
  const raw = needle.trim().toLowerCase();
  if (raw.length === 0) return 0;
  
  const tokens = raw.match(/[a-z0-9]+/g) ?? [];
  if (tokens.length === 0) return 0;
  
  const match = tokens.map(t => t.length >= 3 ? `${t}*` : t).join(" ");
  
  const where: string[] = [];
  const params: any[] = [match];
  
  if (filters?.instance_name !== undefined) {
    if (filters.instance_name === null) {
      where.push("r.instance_name IS NULL");
    } else {
      where.push("r.instance_name = ?");
      params.push(filters.instance_name);
    }
  }
  if (filters?.forward_name !== undefined) {
    if (filters.forward_name === null) {
      where.push("r.forward_name IS NULL");
    } else {
      where.push("r.forward_name = ?");
      params.push(filters.forward_name);
    }
  }
  if (filters?.method) {
    where.push("r.method = ?");
    params.push(filters.method);
  }
  if (filters?.status_code) {
    where.push("r.status_code = ?");
    params.push(filters.status_code);
  }
  
  const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";
  
  const row = db.query(`
    SELECT COUNT(*) as count
    FROM requests r
    JOIN requests_fts fts ON fts.rowid = r.id
    WHERE requests_fts MATCH ? ${whereSql}
  `).get(...params) as { count: number };
  
  return row.count;
}

// ============================================================================
// 兼容层 - 为了让 proxy-server.ts 和 viewer-server.ts 能继续使用旧接口
// ============================================================================

import { bufferToDataUrl, dataUrlToBuffer } from "./data-url";
import type { HookLayer } from "../types/proxy";

/** 旧版请求数据格式（用于兼容 proxy-server.ts） */
export interface LegacyRequestData {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  forwardedHeaders?: Record<string, string | string[]>;
  targetUrl?: string;
  bodyDataUrl: string | null;
  bodySize: number;
}

export interface LegacyResponseData {
  statusCode: number | null;
  statusMessage: string | null;
  headers: Record<string, string | string[]>;
  bodyDataUrl: string | null;
  bodySize: number;
  ttfbMs?: number;
  bodyMs?: number;
  contentType?: string | null;
}

export interface LegacyLoggedRequest {
  id?: number;
  request_id: string;
  timestamp: string;
  instance_name: string | null;
  forward_name: string | null;
  forward_id: string | null;
  group_name: string | null;
  status: RequestStatus;
  abort_reason: AbortReason | null;
  is_websocket: boolean;
  websocket_direction: WebSocketDirection;
  error_message: string | null;
  request: LegacyRequestData;
  hookedRequest?: LegacyRequestData;
  requestHookLayers?: HookLayer[];
  response?: LegacyResponseData;
  hookedResponse?: LegacyResponseData;
  responseHookLayers?: HookLayer[];
  plugin_info?: PluginInfo;
}

// Helper: 解析 dataUrl 返回 Buffer
function parseDataUrl(dataUrl: string | null | undefined): Buffer | null {
  if (!dataUrl) return null;
  try {
    return dataUrlToBuffer(dataUrl).buffer;
  } catch {
    return null;
  }
}

/**
 * 创建请求（兼容 proxy-server.ts 的旧接口）
 */
export function createProxyRequest(request: Omit<LegacyLoggedRequest, "id">): number {
  // 解析 body data URL
  const requestBody = parseDataUrl(request.request.bodyDataUrl);
  const hookedRequestBody = parseDataUrl(request.hookedRequest?.bodyDataUrl);
  
  // 从 headers 中解析 plugin_info（如果没有显式提供）
  let pluginInfo = request.plugin_info;
  if (!pluginInfo) {
    const allHeaders = {
      ...request.request.headers,
      ...request.hookedRequest?.headers,
    };
    const parsed = parsePrivateHeaders(allHeaders);
    if (parsed.pluginOrigin || parsed.pluginsProcessed.length > 0) {
      pluginInfo = {
        pluginOrigin: parsed.pluginOrigin ?? undefined,
        pluginsProcessed: parsed.pluginsProcessed.length > 0 ? parsed.pluginsProcessed : undefined,
        requestType: parsed.requestType ?? undefined,
        sessionId: parsed.sessionId ?? undefined,
        pingCount: parsed.pingCount ?? undefined,
      };
    }
  }
  
  // 创建请求
  const id = createRequest({
    request_id: request.request_id,
    timestamp: request.timestamp,
    instance_name: request.instance_name,
    forward_name: request.forward_name,
    forward_id: request.forward_id,
    method: request.request.method,
    url: request.request.url,
    request_headers: request.request.headers,
    request_body: requestBody,
    request_content_type: extractContentType(request.request.headers),
    forwarded_headers: request.request.forwardedHeaders,
    target_url: request.request.targetUrl,
    is_websocket: request.is_websocket,
    websocket_direction: request.websocket_direction,
    plugin_info: pluginInfo,
  });
  
  // 如果有 request hook 变更，更新
  if (request.hookedRequest) {
    updateRequestHook(id, {
      hooked_method: request.hookedRequest.method,
      hooked_url: request.hookedRequest.url,
      hooked_headers: request.hookedRequest.headers,
      hooked_body: hookedRequestBody,
      hooked_content_type: extractContentType(request.hookedRequest.headers),
      layers: request.requestHookLayers?.map(layer => ({
        plugin_name: layer.pluginName,
        modified: layer.modified,
        headers: layer.headers,
        body: parseDataUrl(layer.bodyDataUrl),
        content_type: layer.contentType ?? null,
      })),
    });
  }
  
  return id;
}

/**
 * 更新请求（兼容 proxy-server.ts 的旧接口）
 */
export function updateProxyRequest(id: number, updates: Partial<LegacyLoggedRequest>): boolean {
  // 处理状态更新
  if (updates.status === "error" && updates.error_message) {
    markRequestError(id, updates.error_message);
  } else if (updates.status === "aborted" && updates.abort_reason) {
    markRequestAborted(id, updates.abort_reason);
  }
  
  // 处理响应数据
  if (updates.response) {
    const responseBody = parseDataUrl(updates.response.bodyDataUrl) ?? Buffer.alloc(0);
    
    // 初始化响应
    initResponse(id, {
      status_code: updates.response.statusCode ?? 0,
      status_message: updates.response.statusMessage ?? "",
      headers: updates.response.headers,
      content_type: updates.response.contentType,
      ttfb_ms: updates.response.ttfbMs,
    });
    
    // 处理 hooked response
    const hasHookChanges = !!updates.hookedResponse;
    const originalBody = hasHookChanges ? responseBody : undefined;
    const originalContentType = hasHookChanges ? updates.response.contentType : undefined;
    const originalHeaders = hasHookChanges ? updates.response.headers : undefined;
    
    const finalBody = parseDataUrl(updates.hookedResponse?.bodyDataUrl) ?? responseBody;
    
    // 从响应 headers 中解析 plugin_info
    let pluginInfo: PluginInfo | undefined;
    const allHeaders = {
      ...updates.response.headers,
      ...updates.hookedResponse?.headers,
    };
    const parsed = parsePrivateHeaders(allHeaders);
    if (parsed.pluginOrigin || parsed.pluginsProcessed.length > 0) {
      pluginInfo = {
        pluginOrigin: parsed.pluginOrigin ?? undefined,
        pluginsProcessed: parsed.pluginsProcessed.length > 0 ? parsed.pluginsProcessed : undefined,
        requestType: parsed.requestType ?? undefined,
        sessionId: parsed.sessionId ?? undefined,
        pingCount: parsed.pingCount ?? undefined,
      };
    }
    
    // 完成响应
    finalizeResponse(id, {
      body: finalBody,
      body_ms: updates.response.bodyMs,
      has_hook_changes: hasHookChanges,
      original_body: originalBody,
      original_content_type: originalContentType,
      original_headers: originalHeaders,
      original_status_code: hasHookChanges ? updates.response.statusCode ?? undefined : undefined,
      original_status_message: hasHookChanges ? updates.response.statusMessage ?? undefined : undefined,
      layers: updates.responseHookLayers?.map(layer => ({
        plugin_name: layer.pluginName,
        modified: layer.modified,
        status_code: layer.statusCode,
        status_message: layer.statusMessage,
        headers: layer.headers,
        body: parseDataUrl(layer.bodyDataUrl),
        content_type: layer.contentType ?? null,
      })),
      plugin_info: pluginInfo,
    });
  }
  
  return true;
}

/**
 * 获取请求（兼容旧接口）
 */
export function getProxyRequestById(id: number): LegacyLoggedRequest | null {
  const detail = getRequestDetail(id);
  if (!detail) return null;
  
  return convertDetailToLegacy(detail);
}

/**
 * 获取指定 ID 之后的请求
 */
export function getRequestsAfterId(lastId: number): LegacyLoggedRequest[] {
  const rows = db.query(`
    SELECT id FROM requests WHERE id > ? ORDER BY id ASC
  `).all(lastId) as Array<{ id: number }>;
  
  const results: LegacyLoggedRequest[] = [];
  for (const row of rows) {
    const detail = getRequestDetail(row.id);
    if (detail) {
      results.push(convertDetailToLegacy(detail));
    }
  }
  return results;
}

/**
 * 删除请求
 */
export function deleteProxyRequest(id: number): boolean {
  return deleteRequest(id);
}

/**
 * 清空所有请求（别名导出）
 */
export { clearAllRequests as clearAllProxyRequests };

/**
 * 清理孤儿请求（别名导出，用于 cli.ts）
 */
export { cleanupOrphanRequests as cleanupOrphanStreamingRequests };

/**
 * 创建 WebSocket 消息记录（兼容旧接口）
 */
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
    group_name: params.instance_name && params.forward_name 
      ? `${params.instance_name}/${params.forward_name}` 
      : params.instance_name,
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

// Helper: 从 headers 中提取 content-type
function extractContentType(headers: Record<string, string | string[]>): string | null {
  const ct = headers["content-type"] || headers["Content-Type"];
  if (Array.isArray(ct)) return ct[0] ?? null;
  return ct ?? null;
}

// ============================================================================
// 更多兼容函数 - viewer-server.ts 需要的列表查询 API
// ============================================================================

/** 旧版 LoggedRequest 格式导出为 LoggedRequest */
export type LoggedRequest = LegacyLoggedRequest;

/** 旧版 ListSummary 格式（用于兼容 viewer-server.ts） */
export interface ListSummary {
  id: string; // 注意：这里是 string 类型，与 InternalListSummary 的 number 不同
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

// 将 v7 内部 ListSummary 转换为旧版格式
function convertToLegacyListSummary(item: InternalListSummary): ListSummary {
  // 解析 plugin_info JSON
  let pluginInfo: PluginInfo | undefined;
  if (item.plugin_info) {
    try {
      pluginInfo = JSON.parse(item.plugin_info);
    } catch {
      // ignore
    }
  }
  
  return {
    id: String(item.id),
    timestamp: item.timestamp,
    ttfbMs: item.ttfb_ms ?? undefined,
    bodyMs: item.body_ms ?? undefined,
    instanceName: item.instance_name,
    forwardName: item.forward_name,
    forwardId: item.forward_id,
    status: item.status,
    abortReason: item.abort_reason,
    isWebSocket: item.is_websocket,
    targetUrl: item.url,
    request: {
      method: item.method,
      url: item.url,
      bodySize: item.request_body_size,
    },
    response: item.status_code !== null ? {
      statusCode: item.status_code,
      bodySize: item.response_body_size,
    } : null,
    pluginInfo,
  };
}

/** 获取所有请求（兼容旧接口）*/
export function getAllRequests(
  filters?: ProxyRequestFilters,
  pagination?: { page: number; limit: number },
): LegacyLoggedRequest[] {
  // 使用内部函数获取 ID 列表
  const summaries = getRequestsSummaryInternal({
    filters: filters ? {
      instance_name: filters.instance_name,
      forward_name: filters.forward_name,
      method: filters.method,
      status_code: filters.status_code,
      url_pattern: filters.url_pattern,
    } : undefined,
    pagination: pagination ? {
      page: pagination.page,
      limit: pagination.limit,
    } : undefined,
  });
  
  // 获取完整详情
  const results: LegacyLoggedRequest[] = [];
  for (const summary of summaries) {
    const detail = getRequestDetail(summary.id);
    if (detail) {
      results.push(convertDetailToLegacy(detail));
    }
  }
  return results;
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
  order?: "asc" | "desc";
}

/** 获取请求列表摘要（兼容旧接口）*/
export function getAllRequestsSummary(
  filters?: ProxyRequestFilters,
  pagination?: ProxyRequestPagination,
): ListSummary[] {
  const summaries = getRequestsSummaryInternal({
    filters: {
      instance_name: filters?.instance_name,
      forward_name: filters?.forward_name,
      method: filters?.method,
      status_code: filters?.status_code,
      url_pattern: filters?.url_pattern,
    },
    pagination: pagination ? {
      page: pagination.page,
      limit: pagination.limit,
      order: pagination.order,
    } : undefined,
  });
  
  return summaries.map(convertToLegacyListSummary);
}

/** 获取模糊搜索请求摘要（兼容旧接口）*/
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
  const summaries = searchRequestsFuzzyInternal(needle, {
    filters: {
      instance_name: filters?.instance_name,
      forward_name: filters?.forward_name,
      method: filters?.method,
      status_code: filters?.status_code,
    },
    pagination: {
      page: options.page,
      limit: options.limit,
      order: options.order,
    },
  });
  
  return summaries.map(convertToLegacyListSummary);
}

/** 模糊搜索结果数量（兼容旧接口）*/
export function getRequestsCountFuzzy(
  filters?: ProxyRequestFilters,
  urlPattern?: string,
): number {
  // 对于非模糊搜索，使用普通 count
  if (!urlPattern || urlPattern.trim().length === 0) {
    return getRequestsCount(filters);
  }
  
  // 对于 URL 模式匹配，使用 FTS
  return searchRequestsCountFuzzy(urlPattern, {
    instance_name: filters?.instance_name,
    forward_name: filters?.forward_name,
    method: filters?.method,
    status_code: filters?.status_code,
  });
}

/** 获取带限制的模糊搜索结果（兼容旧接口）*/
export function getAllRequestsFuzzyLimited(
  needle: string,
  limit: number,
  filters?: ProxyRequestFilters,
): LegacyLoggedRequest[] {
  const summaries = searchRequestsFuzzyInternal(needle, {
    filters: {
      instance_name: filters?.instance_name,
      forward_name: filters?.forward_name,
      method: filters?.method,
      status_code: filters?.status_code,
    },
    pagination: { page: 1, limit },
  });
  
  // 需要获取完整详情
  const results: LegacyLoggedRequest[] = [];
  for (const summary of summaries) {
    const detail = getRequestDetail(summary.id);
    if (detail) {
      results.push(convertDetailToLegacy(detail));
    }
  }
  return results;
}

/** 获取指定 ID 范围的请求（兼容旧接口）*/
export function getRequestsByIdRange(startId: number, endId: number): LegacyLoggedRequest[] {
  const rows = db.query(`
    SELECT id FROM requests WHERE id >= ? AND id <= ? ORDER BY id ASC
  `).all(startId, endId) as Array<{ id: number }>;
  
  const results: LegacyLoggedRequest[] = [];
  for (const row of rows) {
    const detail = getRequestDetail(row.id);
    if (detail) {
      results.push(convertDetailToLegacy(detail));
    }
  }
  return results;
}

// Helper: 将 RequestDetail 转换为旧版 LoggedRequest 格式
function convertDetailToLegacy(detail: RequestDetail): LegacyLoggedRequest {
  const result: LegacyLoggedRequest = {
    id: detail.id,
    request_id: detail.request_id,
    timestamp: detail.timestamp,
    instance_name: detail.instance_name,
    forward_name: detail.forward_name,
    forward_id: detail.forward_id,
    group_name: detail.instance_name && detail.forward_name 
      ? `${detail.instance_name}/${detail.forward_name}` 
      : detail.instance_name,
    status: detail.status,
    abort_reason: detail.abort_reason,
    is_websocket: detail.is_websocket,
    websocket_direction: detail.websocket_direction,
    error_message: detail.error_message,
    request: {
      method: detail.method,
      url: detail.url,
      headers: detail.request_headers,
      forwardedHeaders: detail.forwarded_headers,
      bodyDataUrl: detail.request_body 
        ? bufferToDataUrl(detail.request_body, extractContentType(detail.request_headers))
        : null,
      bodySize: detail.request_body_size,
    },
  };
  
  // Hooked request
  if (detail.has_request_hook_changes) {
    result.hookedRequest = {
      method: detail.method, // TODO: 存储 hooked method
      url: detail.url, // TODO: 存储 hooked url
      headers: detail.hooked_request_headers ?? detail.request_headers,
      bodyDataUrl: detail.hooked_request_body
        ? bufferToDataUrl(detail.hooked_request_body, extractContentType(detail.hooked_request_headers ?? detail.request_headers))
        : null,
      bodySize: detail.hooked_request_body?.length ?? 0,
    };
  }
  
  // Request hook layers
  if (detail.request_hook_layers && detail.request_hook_layers.length > 0) {
    result.requestHookLayers = detail.request_hook_layers.map(layer => ({
      pluginName: layer.plugin_name,
      modified: layer.modified,
      headers: layer.headers,
      bodyDataUrl: layer.body ? bufferToDataUrl(layer.body, layer.content_type) : null,
      contentType: layer.content_type,
    }));
  }
  
  // Response
  if (detail.status_code !== null || detail.response_body) {
    result.response = {
      statusCode: detail.status_code,
      statusMessage: detail.status_message,
      headers: detail.response_headers ?? {},
      bodyDataUrl: detail.response_body
        ? bufferToDataUrl(detail.response_body, detail.content_type)
        : null,
      bodySize: detail.response_body_size,
      ttfbMs: detail.ttfb_ms ?? undefined,
      bodyMs: detail.body_ms ?? undefined,
      contentType: detail.content_type,
    };
  }
  
  // Hooked response
  if (detail.has_response_hook_changes) {
    result.hookedResponse = {
      statusCode: detail.status_code,
      statusMessage: detail.status_message,
      headers: detail.hooked_response_headers ?? detail.response_headers ?? {},
      bodyDataUrl: detail.hooked_response_body
        ? bufferToDataUrl(detail.hooked_response_body, detail.content_type)
        : null,
      bodySize: detail.hooked_response_body?.length ?? 0,
      ttfbMs: detail.ttfb_ms ?? undefined,
      bodyMs: detail.body_ms ?? undefined,
      contentType: detail.content_type,
    };
    
    // 当有 hooked response 时，response 应该是原始数据
    // 但 detail.response_body 存储的是原始数据（response_origin），所以这里是对的
  }
  
  // Response hook layers
  if (detail.response_hook_layers && detail.response_hook_layers.length > 0) {
    result.responseHookLayers = detail.response_hook_layers.map(layer => ({
      pluginName: layer.plugin_name,
      modified: layer.modified,
      statusCode: layer.status_code ?? undefined,
      statusMessage: layer.status_message ?? undefined,
      headers: layer.headers,
      bodyDataUrl: layer.body ? bufferToDataUrl(layer.body, layer.content_type) : null,
      contentType: layer.content_type,
    }));
  }
  
  return result;
}

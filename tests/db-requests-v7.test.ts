/**
 * Database v7 分表架构测试
 * 
 * 重点测试：
 * 1. SSE (text/event-stream) 流式响应存储
 * 2. Hook layers body 存储
 * 3. 大 body 性能
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import * as path from "node:path";

// 测试专用的内存数据库
let testDb: Database;

// Mock db module
const mockDb = {
  query(sql: string) {
    return testDb.query(sql);
  },
  run(sql: string, ...params: any[]) {
    return testDb.run(sql, ...params);
  },
  exec(sql: string) {
    return testDb.exec(sql);
  },
};

// 直接实现测试用的数据库操作（不依赖 mock）
function createTestSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      timestamp DATETIME NOT NULL,
      instance_name TEXT,
      forward_name TEXT,
      forward_id TEXT,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      url_lc TEXT,
      path_lc TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      abort_reason TEXT,
      status_code INTEGER,
      status_message TEXT,
      content_type TEXT,
      ttfb_ms INTEGER,
      body_ms INTEGER,
      request_body_size INTEGER DEFAULT 0,
      response_body_size INTEGER DEFAULT 0,
      has_request_hook_changes INTEGER DEFAULT 0,
      has_response_hook_changes INTEGER DEFAULT 0,
      is_websocket INTEGER DEFAULT 0,
      websocket_direction TEXT
    );

    CREATE TABLE IF NOT EXISTS request_headers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL,
      stage TEXT NOT NULL,
      headers TEXT NOT NULL,
      UNIQUE(request_id, stage)
    );

    CREATE TABLE IF NOT EXISTS request_bodies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL,
      stage TEXT NOT NULL,
      content_type TEXT,
      body BLOB,
      body_size INTEGER DEFAULT 0,
      UNIQUE(request_id, stage)
    );

    CREATE TABLE IF NOT EXISTS hook_layers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      layer_index INTEGER NOT NULL,
      plugin_name TEXT NOT NULL,
      modified INTEGER NOT NULL DEFAULT 0,
      status_code INTEGER,
      status_message TEXT,
      UNIQUE(request_id, direction, layer_index)
    );
  `);
}

// 测试用的数据库操作函数
function createRequest(db: Database, input: {
  request_id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Buffer;
  content_type?: string;
}): number {
  const url_lc = input.url.toLowerCase();
  let path_lc: string | null = null;
  try {
    path_lc = new URL(input.url).pathname.toLowerCase();
  } catch {}

  const result = db.query(`
    INSERT INTO requests (request_id, timestamp, method, url, url_lc, path_lc, status, request_body_size)
    VALUES (?, datetime('now'), ?, ?, ?, ?, 'pending', ?)
  `).run(input.request_id, input.method, input.url, url_lc, path_lc, input.body?.length ?? 0);

  const id = Number(result.lastInsertRowid);

  db.query(`
    INSERT INTO request_headers (request_id, stage, headers) VALUES (?, 'request_origin', ?)
  `).run(id, JSON.stringify(input.headers));

  if (input.body && input.body.length > 0) {
    db.query(`
      INSERT INTO request_bodies (request_id, stage, content_type, body, body_size)
      VALUES (?, 'request_origin', ?, ?, ?)
    `).run(id, input.content_type ?? null, input.body, input.body.length);
  }

  return id;
}

function initResponse(db: Database, id: number, input: {
  status_code: number;
  status_message: string;
  headers: Record<string, string>;
  content_type: string;
  ttfb_ms: number;
}): void {
  db.query(`
    UPDATE requests SET status = 'streaming', status_code = ?, status_message = ?, content_type = ?, ttfb_ms = ?
    WHERE id = ?
  `).run(input.status_code, input.status_message, input.content_type, input.ttfb_ms, id);

  db.query(`
    INSERT OR REPLACE INTO request_headers (request_id, stage, headers) VALUES (?, 'response_origin', ?)
  `).run(id, JSON.stringify(input.headers));
}

function updateStreamingProgress(db: Database, id: number, bodySize: number): void {
  db.query(`UPDATE requests SET response_body_size = ? WHERE id = ?`).run(bodySize, id);
}

function finalizeResponse(db: Database, id: number, input: {
  body: Buffer;
  body_ms: number;
  has_hook_changes?: boolean;
  original_body?: Buffer;
  original_content_type?: string;
  layers?: Array<{
    plugin_name: string;
    modified: boolean;
    body?: Buffer;
    content_type?: string;
  }>;
}): void {
  db.query(`
    UPDATE requests SET status = 'completed', response_body_size = ?, body_ms = ?, has_response_hook_changes = ?
    WHERE id = ?
  `).run(input.body.length, input.body_ms, input.has_hook_changes ? 1 : 0, id);

  if (input.has_hook_changes && input.original_body) {
    // 存储原始响应
    db.query(`
      INSERT OR REPLACE INTO request_bodies (request_id, stage, content_type, body, body_size)
      VALUES (?, 'response_origin', ?, ?, ?)
    `).run(id, input.original_content_type ?? null, input.original_body, input.original_body.length);

    // 存储 hooked 响应
    db.query(`
      INSERT OR REPLACE INTO request_bodies (request_id, stage, content_type, body, body_size)
      VALUES (?, 'response_hooked', ?, ?, ?)
    `).run(id, null, input.body, input.body.length);
  } else {
    // 只存储最终响应
    db.query(`
      INSERT OR REPLACE INTO request_bodies (request_id, stage, content_type, body, body_size)
      VALUES (?, 'response_origin', ?, ?, ?)
    `).run(id, null, input.body, input.body.length);
  }

  // 存储 layers
  if (input.layers) {
    for (let i = 0; i < input.layers.length; i++) {
      const layer = input.layers[i]!;
      db.query(`
        INSERT OR REPLACE INTO hook_layers (request_id, direction, layer_index, plugin_name, modified)
        VALUES (?, 'response', ?, ?, ?)
      `).run(id, i, layer.plugin_name, layer.modified ? 1 : 0);

      if (layer.body && layer.body.length > 0) {
        db.query(`
          INSERT OR REPLACE INTO request_bodies (request_id, stage, content_type, body, body_size)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, `response_layer_${i}`, layer.content_type ?? null, layer.body, layer.body.length);
      }
    }
  }
}

function getRequestDetail(db: Database, id: number): any {
  const row = db.query(`SELECT * FROM requests WHERE id = ?`).get(id) as any;
  if (!row) return null;

  const headersRows = db.query(`
    SELECT stage, headers FROM request_headers WHERE request_id = ?
  `).all(id) as Array<{ stage: string; headers: string }>;

  const headersMap = new Map<string, Record<string, string>>();
  for (const h of headersRows) {
    headersMap.set(h.stage, JSON.parse(h.headers));
  }

  const bodiesRows = db.query(`
    SELECT stage, content_type, body, body_size FROM request_bodies WHERE request_id = ?
  `).all(id) as Array<{ stage: string; content_type: string | null; body: Uint8Array | null; body_size: number }>;

  const bodiesMap = new Map<string, { content_type: string | null; body: Buffer | null; body_size: number }>();
  for (const b of bodiesRows) {
    // SQLite BLOB 返回 Uint8Array，需要转换为 Buffer
    const body = b.body ? Buffer.from(b.body) : null;
    bodiesMap.set(b.stage, { content_type: b.content_type, body, body_size: b.body_size });
  }

  const layersRows = db.query(`
    SELECT direction, layer_index, plugin_name, modified FROM hook_layers WHERE request_id = ? ORDER BY layer_index
  `).all(id) as Array<{ direction: string; layer_index: number; plugin_name: string; modified: number }>;

  return {
    ...row,
    headers: headersMap,
    bodies: bodiesMap,
    layers: layersRows,
  };
}

describe("Database v7 - SSE Streaming", () => {
  beforeEach(() => {
    testDb = new Database(":memory:");
    createTestSchema(testDb);
  });

  afterAll(() => {
    testDb?.close();
  });

  test("should store SSE response with streaming progress updates", () => {
    // 模拟一个 SSE 请求
    const requestBody = JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    });

    const id = createRequest(testDb, {
      request_id: "sse-test-1",
      method: "POST",
      url: "https://api.openai.com/v1/chat/completions",
      headers: { "content-type": "application/json" },
      body: Buffer.from(requestBody),
      content_type: "application/json",
    });

    expect(id).toBeGreaterThan(0);

    // 收到响应头
    initResponse(testDb, id, {
      status_code: 200,
      status_message: "OK",
      headers: { "content-type": "text/event-stream" },
      content_type: "text/event-stream",
      ttfb_ms: 150,
    });

    // 验证 streaming 状态
    let detail = getRequestDetail(testDb, id);
    expect(detail.status).toBe("streaming");
    expect(detail.status_code).toBe(200);
    expect(detail.content_type).toBe("text/event-stream");

    // 模拟流式数据到达
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    let totalSize = 0;
    for (const chunk of sseChunks) {
      totalSize += Buffer.from(chunk).length;
      updateStreamingProgress(testDb, id, totalSize);
    }

    // 验证进度更新
    detail = getRequestDetail(testDb, id);
    expect(detail.response_body_size).toBe(totalSize);
    expect(detail.status).toBe("streaming");

    // 完成响应
    const fullBody = Buffer.from(sseChunks.join(""));
    finalizeResponse(testDb, id, {
      body: fullBody,
      body_ms: 500,
    });

    // 验证最终状态
    detail = getRequestDetail(testDb, id);
    expect(detail.status).toBe("completed");
    expect(detail.body_ms).toBe(500);
    expect(detail.bodies.get("response_origin")).toBeDefined();
    expect(detail.bodies.get("response_origin")?.body?.toString()).toBe(sseChunks.join(""));
  });

  test("should store SSE response with hook modifications", () => {
    const id = createRequest(testDb, {
      request_id: "sse-hook-test",
      method: "POST",
      url: "https://api.openai.com/v1/responses",
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"model":"gpt-4"}'),
      content_type: "application/json",
    });

    initResponse(testDb, id, {
      status_code: 200,
      status_message: "OK",
      headers: { "content-type": "text/event-stream" },
      content_type: "text/event-stream",
      ttfb_ms: 100,
    });

    // 原始 SSE 响应
    const originalSSE = 'event: response.created\ndata: {"id":"resp_1"}\n\n';
    // Hook 转换后的 SSE
    const hookedSSE = 'event: message_start\ndata: {"type":"message_start"}\n\n';

    // 完成响应，有 hook 变更
    finalizeResponse(testDb, id, {
      body: Buffer.from(hookedSSE),
      body_ms: 300,
      has_hook_changes: true,
      original_body: Buffer.from(originalSSE),
      original_content_type: "text/event-stream",
      layers: [
        {
          plugin_name: "responses4claudecode",
          modified: true,
          body: Buffer.from(hookedSSE),
          content_type: "text/event-stream",
        },
      ],
    });

    const detail = getRequestDetail(testDb, id);

    // 验证原始响应和 hooked 响应都被存储
    expect(detail.has_response_hook_changes).toBe(1);
    expect(detail.bodies.get("response_origin")?.body?.toString()).toBe(originalSSE);
    expect(detail.bodies.get("response_hooked")?.body?.toString()).toBe(hookedSSE);

    // 验证 layer body 也被存储
    expect(detail.layers.length).toBe(1);
    expect(detail.layers[0].plugin_name).toBe("responses4claudecode");
    expect(detail.layers[0].modified).toBe(1);
    expect(detail.bodies.get("response_layer_0")?.body?.toString()).toBe(hookedSSE);
  });

  test("should handle large SSE response efficiently", () => {
    const id = createRequest(testDb, {
      request_id: "large-sse-test",
      method: "POST",
      url: "https://api.example.com/stream",
      headers: {},
    });

    initResponse(testDb, id, {
      status_code: 200,
      status_message: "OK",
      headers: { "content-type": "text/event-stream" },
      content_type: "text/event-stream",
      ttfb_ms: 50,
    });

    // 模拟大量 SSE 事件（约 1MB）
    const eventCount = 10000;
    const events: string[] = [];
    for (let i = 0; i < eventCount; i++) {
      events.push(`data: {"index":${i},"content":"${"x".repeat(100)}"}\n\n`);
    }
    const largeBody = Buffer.from(events.join(""));

    const startTime = Date.now();
    finalizeResponse(testDb, id, {
      body: largeBody,
      body_ms: 2000,
    });
    const elapsed = Date.now() - startTime;

    // 写入应该在合理时间内完成（< 1s）
    expect(elapsed).toBeLessThan(1000);

    const detail = getRequestDetail(testDb, id);
    expect(detail.response_body_size).toBe(largeBody.length);
    expect(detail.bodies.get("response_origin")?.body_size).toBe(largeBody.length);
  });

  test("should store multiple hook layers for response", () => {
    const id = createRequest(testDb, {
      request_id: "multi-layer-test",
      method: "POST",
      url: "https://api.example.com/v1/messages",
      headers: {},
    });

    initResponse(testDb, id, {
      status_code: 200,
      status_message: "OK",
      headers: {},
      content_type: "text/event-stream",
      ttfb_ms: 100,
    });

    const originalBody = Buffer.from('event: original\ndata: {}\n\n');
    const layer0Body = Buffer.from('event: layer0\ndata: {}\n\n');
    const layer1Body = Buffer.from('event: layer1\ndata: {}\n\n');
    const finalBody = Buffer.from('event: final\ndata: {}\n\n');

    finalizeResponse(testDb, id, {
      body: finalBody,
      body_ms: 500,
      has_hook_changes: true,
      original_body: originalBody,
      layers: [
        { plugin_name: "plugin-a", modified: true, body: layer0Body },
        { plugin_name: "plugin-b", modified: false }, // 未修改，无 body
        { plugin_name: "plugin-c", modified: true, body: layer1Body },
      ],
    });

    const detail = getRequestDetail(testDb, id);

    expect(detail.layers.length).toBe(3);
    expect(detail.bodies.get("response_origin")?.body?.toString()).toBe(originalBody.toString());
    expect(detail.bodies.get("response_hooked")?.body?.toString()).toBe(finalBody.toString());
    expect(detail.bodies.get("response_layer_0")?.body?.toString()).toBe(layer0Body.toString());
    expect(detail.bodies.get("response_layer_1")).toBeUndefined(); // 未修改，无 body
    expect(detail.bodies.get("response_layer_2")?.body?.toString()).toBe(layer1Body.toString());
  });
});

describe("Database v7 - Request Hook Layers", () => {
  beforeEach(() => {
    testDb = new Database(":memory:");
    createTestSchema(testDb);
  });

  test("should store request body with hook modifications", () => {
    const originalBody = JSON.stringify({ model: "claude-3", messages: [] });
    const hookedBody = JSON.stringify({ model: "gpt-4", input: [] });

    const id = createRequest(testDb, {
      request_id: "req-hook-test",
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: { "content-type": "application/json" },
      body: Buffer.from(originalBody),
      content_type: "application/json",
    });

    // 存储 hooked 请求
    testDb.query(`UPDATE requests SET has_request_hook_changes = 1 WHERE id = ?`).run(id);
    testDb.query(`
      INSERT INTO request_bodies (request_id, stage, content_type, body, body_size)
      VALUES (?, 'request_hooked', 'application/json', ?, ?)
    `).run(id, Buffer.from(hookedBody), Buffer.from(hookedBody).length);

    // 存储 request layer
    testDb.query(`
      INSERT INTO hook_layers (request_id, direction, layer_index, plugin_name, modified)
      VALUES (?, 'request', 0, 'anthropic4codex', 1)
    `).run(id);
    testDb.query(`
      INSERT INTO request_bodies (request_id, stage, content_type, body, body_size)
      VALUES (?, 'request_layer_0', 'application/json', ?, ?)
    `).run(id, Buffer.from(hookedBody), Buffer.from(hookedBody).length);

    const detail = getRequestDetail(testDb, id);

    expect(detail.has_request_hook_changes).toBe(1);
    expect(detail.bodies.get("request_origin")?.body?.toString()).toBe(originalBody);
    expect(detail.bodies.get("request_hooked")?.body?.toString()).toBe(hookedBody);
    expect(detail.bodies.get("request_layer_0")?.body?.toString()).toBe(hookedBody);
    expect(detail.layers.find((l: any) => l.direction === "request")).toBeDefined();
  });
});

describe("Database v7 - List Query Performance", () => {
  beforeEach(() => {
    testDb = new Database(":memory:");
    createTestSchema(testDb);
  });

  test("should query list efficiently without loading bodies", () => {
    // 创建 100 个请求，每个有大 body
    for (let i = 0; i < 100; i++) {
      const id = createRequest(testDb, {
        request_id: `perf-test-${i}`,
        method: "POST",
        url: `https://api.example.com/request/${i}`,
        headers: {},
        body: Buffer.alloc(100000, "x"), // 100KB body
      });

      finalizeResponse(testDb, id, {
        body: Buffer.alloc(200000, "y"), // 200KB response
        body_ms: 100,
      });
    }

    // 查询列表（只查 requests 表，不碰 bodies）
    const startTime = Date.now();
    const rows = testDb.query(`
      SELECT id, request_id, method, url, status, status_code, request_body_size, response_body_size
      FROM requests
      ORDER BY id DESC
      LIMIT 20
    `).all();
    const elapsed = Date.now() - startTime;

    expect(rows.length).toBe(20);
    // 列表查询应该非常快（< 50ms）
    expect(elapsed).toBeLessThan(50);

    // 确认没有加载 body
    const firstRow = rows[0] as any;
    expect(firstRow.request_body_size).toBe(100000);
    expect(firstRow.response_body_size).toBe(200000);
    expect(firstRow.body).toBeUndefined(); // 列表不应包含 body
  });
});

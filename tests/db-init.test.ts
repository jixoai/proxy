/**
 * 数据库初始化测试
 * 
 * 确保数据库初始化后，所有依赖的模块都能正常工作
 */

import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { initDatabase, db } from "../src/lib/db";
import { clearDataDir, setDataDir, getDbPath } from "../src/lib/runtime-paths";

describe("Database Initialization", () => {
  const TEST_DATA_DIR = path.join(process.cwd(), ".tmp", "db-init-tests", "data");

  beforeAll(async () => {
    setDataDir(TEST_DATA_DIR);
    clearDataDir();
    await initDatabase();
  });

  afterAll(() => {
    clearDataDir();
  });

  test("should create all required v7 tables", () => {
    // 检查 v7 需要的表
    const tables = db.query(`
      SELECT name FROM sqlite_master 
      WHERE type='table' 
      ORDER BY name
    `).all() as Array<{ name: string }>;
    
    const tableNames = tables.map(t => t.name);
    
    // v7 架构需要的表
    expect(tableNames).toContain("requests");
    expect(tableNames).toContain("request_headers");
    expect(tableNames).toContain("request_bodies");
    expect(tableNames).toContain("hook_layers");
    expect(tableNames).toContain("schema_meta");
    
    // FTS 表
    expect(tableNames.some(t => t.startsWith("requests_fts"))).toBe(true);
  });

  test("should NOT have legacy proxy_requests table", () => {
    const tables = db.query(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='proxy_requests'
    `).all() as Array<{ name: string }>;
    
    // v7 迁移后，旧表应该被删除
    expect(tables.length).toBe(0);
  });

  test("should have correct schema version", () => {
    const version = db.query(`
      SELECT value FROM schema_meta WHERE key = 'version'
    `).get() as { value: string } | null;
    
    expect(version).not.toBeNull();
    expect(parseInt(version!.value, 10)).toBe(10);
  });

  test("requests table should have all required columns", () => {
    const columns = db.query("PRAGMA table_info(requests)").all() as Array<{ name: string }>;
    const columnNames = columns.map(c => c.name);
    
    // 必需的列
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("request_id");
    expect(columnNames).toContain("timestamp");
    expect(columnNames).toContain("instance_name");
    expect(columnNames).toContain("forward_name");
    expect(columnNames).toContain("method");
    expect(columnNames).toContain("url");
    expect(columnNames).toContain("status");
    expect(columnNames).toContain("status_code");
    expect(columnNames).toContain("response_body_size");
  });

  test("db-requests module should work after initialization", async () => {
    // 动态导入以确保在初始化后使用
    const { 
      createProxyRequest, 
      getProxyRequestById,
      clearAllRequests 
    } = await import("../src/lib/db-requests");
    
    // 清理
    clearAllRequests();
    
    // 创建测试请求
    const id = createProxyRequest({
      request_id: "test-1",
      timestamp: new Date().toISOString(),
      instance_name: "test",
      forward_name: "test",
      forward_id: "test-id",
      group_name: "test/test",
      status: "pending",
      abort_reason: null,
      is_websocket: false,
      websocket_direction: null,
      error_message: null,
      request: {
        method: "GET",
        url: "http://localhost/test",
        headers: {},
        bodyDataUrl: null,
        bodySize: 0,
      },
    });
    
    expect(id).toBeGreaterThan(0);
    
    // 读取
    const fetched = getProxyRequestById(id);
    expect(fetched).not.toBeNull();
    expect(fetched?.request_id).toBe("test-1");
    
    // 清理
    clearAllRequests();
  });

  test("should correctly store and retrieve request/response bodies", async () => {
    const { 
      createProxyRequest, 
      updateProxyRequest,
      getProxyRequestById,
      clearAllRequests 
    } = await import("../src/lib/db-requests");
    const { bufferToDataUrl } = await import("../src/lib/data-url");
    
    // 清理
    clearAllRequests();
    
    // 创建带有 body 的请求
    const requestBody = JSON.stringify({ model: "gpt-4", messages: [] });
    const requestBodyDataUrl = bufferToDataUrl(Buffer.from(requestBody), "application/json");
    
    const id = createProxyRequest({
      request_id: "test-body-1",
      timestamp: new Date().toISOString(),
      instance_name: "test",
      forward_name: "test",
      forward_id: "test-id",
      group_name: "test/test",
      status: "pending",
      abort_reason: null,
      is_websocket: false,
      websocket_direction: null,
      error_message: null,
      request: {
        method: "POST",
        url: "http://localhost/v1/chat/completions",
        headers: { "content-type": "application/json" },
        bodyDataUrl: requestBodyDataUrl,
        bodySize: requestBody.length,
      },
    });
    
    expect(id).toBeGreaterThan(0);
    
    // 更新响应
    const responseBody = JSON.stringify({ id: "chatcmpl-123", choices: [] });
    const responseBodyDataUrl = bufferToDataUrl(Buffer.from(responseBody), "application/json");
    
    updateProxyRequest(id, {
      status: "completed",
      response: {
        statusCode: 200,
        statusMessage: "OK",
        headers: { "content-type": "application/json" },
        bodyDataUrl: responseBodyDataUrl,
        bodySize: responseBody.length,
        ttfbMs: 100,
        bodyMs: 50,
        contentType: "application/json",
      },
    });
    
    // 读取并验证
    const fetched = getProxyRequestById(id);
    expect(fetched).not.toBeNull();
    expect(fetched?.status).toBe("completed");
    
    // 验证请求 body
    expect(fetched?.request.bodyDataUrl).not.toBeNull();
    expect(fetched?.request.bodyDataUrl).toContain("data:application/json;base64,");
    expect(fetched?.request.bodySize).toBe(requestBody.length);
    
    // 验证响应 body
    expect(fetched?.response).not.toBeNull();
    expect(fetched?.response?.bodyDataUrl).not.toBeNull();
    expect(fetched?.response?.bodyDataUrl).toContain("data:application/json;base64,");
    expect(fetched?.response?.bodySize).toBe(responseBody.length);
    
    // 清理
    clearAllRequests();
  });

  test("should correctly store and retrieve hooked response bodies", async () => {
    const { 
      createProxyRequest, 
      updateProxyRequest,
      getProxyRequestById,
      clearAllRequests 
    } = await import("../src/lib/db-requests");
    const { bufferToDataUrl } = await import("../src/lib/data-url");
    
    // 清理
    clearAllRequests();
    
    // 创建请求
    const requestBody = JSON.stringify({ model: "gpt-4", messages: [] });
    const requestBodyDataUrl = bufferToDataUrl(Buffer.from(requestBody), "application/json");
    
    const id = createProxyRequest({
      request_id: "test-hooked-1",
      timestamp: new Date().toISOString(),
      instance_name: "test",
      forward_name: "test",
      forward_id: "test-id",
      group_name: "test/test",
      status: "pending",
      abort_reason: null,
      is_websocket: false,
      websocket_direction: null,
      error_message: null,
      request: {
        method: "POST",
        url: "http://localhost/v1/chat/completions",
        headers: { "content-type": "application/json" },
        bodyDataUrl: requestBodyDataUrl,
        bodySize: requestBody.length,
      },
    });
    
    // 模拟有 hook 修改的响应
    const originalResponseBody = JSON.stringify({ id: "original-123", choices: [{ message: { content: "Original" } }] });
    const hookedResponseBody = JSON.stringify({ id: "hooked-123", choices: [{ message: { content: "Hooked by plugin" } }] });
    
    const originalBodyDataUrl = bufferToDataUrl(Buffer.from(originalResponseBody), "application/json");
    const hookedBodyDataUrl = bufferToDataUrl(Buffer.from(hookedResponseBody), "application/json");
    
    updateProxyRequest(id, {
      status: "completed",
      // 原始响应
      response: {
        statusCode: 200,
        statusMessage: "OK",
        headers: { "content-type": "application/json" },
        bodyDataUrl: originalBodyDataUrl,
        bodySize: originalResponseBody.length,
        ttfbMs: 100,
        bodyMs: 50,
        contentType: "application/json",
      },
      // Hooked 响应
      hookedResponse: {
        statusCode: 200,
        statusMessage: "OK",
        headers: { "content-type": "application/json", "x-hooked": "true" },
        bodyDataUrl: hookedBodyDataUrl,
        bodySize: hookedResponseBody.length,
        ttfbMs: 100,
        bodyMs: 50,
        contentType: "application/json",
      },
      // Hook layers
      responseHookLayers: [
        {
          pluginName: "test-plugin",
          modified: true,
          statusCode: 200,
          statusMessage: "OK",
          headers: { "content-type": "application/json" },
          bodyDataUrl: hookedBodyDataUrl,
          contentType: "application/json",
        },
      ],
    });
    
    // 读取并验证
    const fetched = getProxyRequestById(id);
    expect(fetched).not.toBeNull();
    expect(fetched?.status).toBe("completed");
    
    // 验证原始响应 body 存在
    expect(fetched?.response).not.toBeNull();
    expect(fetched?.response?.bodyDataUrl).not.toBeNull();
    expect(fetched?.response?.bodyDataUrl).toContain("data:application/json;base64,");
    
    // 验证 hooked 响应 body 存在
    expect(fetched?.hookedResponse).not.toBeNull();
    expect(fetched?.hookedResponse?.bodyDataUrl).not.toBeNull();
    expect(fetched?.hookedResponse?.bodyDataUrl).toContain("data:application/json;base64,");
    
    // 验证 response hook layers 存在
    expect(fetched?.responseHookLayers).not.toBeUndefined();
    expect(fetched?.responseHookLayers?.length).toBe(1);
    expect(fetched?.responseHookLayers?.[0]?.pluginName).toBe("test-plugin");
    expect(fetched?.responseHookLayers?.[0]?.modified).toBe(true);
    expect(fetched?.responseHookLayers?.[0]?.bodyDataUrl).not.toBeNull();
    
    // 清理
    clearAllRequests();
  });

  test("should correctly store and retrieve request hook layers", async () => {
    const { 
      createProxyRequest, 
      getProxyRequestById,
      clearAllRequests 
    } = await import("../src/lib/db-requests");
    const { bufferToDataUrl } = await import("../src/lib/data-url");
    
    // 清理
    clearAllRequests();
    
    // 创建带有 request hook layers 的请求
    const requestBody = JSON.stringify({ model: "gpt-4", messages: [] });
    const hookedRequestBody = JSON.stringify({ model: "gpt-4o", messages: [], injected: true });
    const requestBodyDataUrl = bufferToDataUrl(Buffer.from(requestBody), "application/json");
    const hookedRequestBodyDataUrl = bufferToDataUrl(Buffer.from(hookedRequestBody), "application/json");
    
    const id = createProxyRequest({
      request_id: "test-req-hook-1",
      timestamp: new Date().toISOString(),
      instance_name: "test",
      forward_name: "test",
      forward_id: "test-id",
      group_name: "test/test",
      status: "pending",
      abort_reason: null,
      is_websocket: false,
      websocket_direction: null,
      error_message: null,
      request: {
        method: "POST",
        url: "http://localhost/v1/chat/completions",
        headers: { "content-type": "application/json" },
        bodyDataUrl: requestBodyDataUrl,
        bodySize: requestBody.length,
      },
      // Hooked request
      hookedRequest: {
        method: "POST",
        url: "http://localhost/v1/chat/completions",
        headers: { "content-type": "application/json", "x-injected": "true" },
        bodyDataUrl: hookedRequestBodyDataUrl,
        bodySize: hookedRequestBody.length,
      },
      // Request hook layers
      requestHookLayers: [
        {
          pluginName: "openai4droid",
          modified: true,
          headers: { "content-type": "application/json" },
          bodyDataUrl: hookedRequestBodyDataUrl,
          contentType: "application/json",
        },
      ],
    });
    
    // 读取并验证
    const fetched = getProxyRequestById(id);
    expect(fetched).not.toBeNull();
    
    // 验证原始请求 body
    expect(fetched?.request.bodyDataUrl).not.toBeNull();
    expect(fetched?.request.bodySize).toBe(requestBody.length);
    
    // 验证 hooked request body
    expect(fetched?.hookedRequest).not.toBeUndefined();
    expect(fetched?.hookedRequest?.bodyDataUrl).not.toBeNull();
    expect(fetched?.hookedRequest?.bodySize).toBe(hookedRequestBody.length);
    
    // 验证 request hook layers
    expect(fetched?.requestHookLayers).not.toBeUndefined();
    expect(fetched?.requestHookLayers?.length).toBe(1);
    expect(fetched?.requestHookLayers?.[0]?.pluginName).toBe("openai4droid");
    expect(fetched?.requestHookLayers?.[0]?.modified).toBe(true);
    expect(fetched?.requestHookLayers?.[0]?.bodyDataUrl).not.toBeNull();
    
    // 清理
    clearAllRequests();
  });

  test("should NOT have hookedResponse when no hook changes", async () => {
    const { 
      createProxyRequest, 
      updateProxyRequest,
      getProxyRequestById,
      clearAllRequests 
    } = await import("../src/lib/db-requests");
    const { bufferToDataUrl } = await import("../src/lib/data-url");
    
    // 清理
    clearAllRequests();
    
    // 创建请求（无 body）
    const id = createProxyRequest({
      request_id: "test-no-hook-1",
      timestamp: new Date().toISOString(),
      instance_name: "test",
      forward_name: "test",
      forward_id: "test-id",
      group_name: "test/test",
      status: "pending",
      abort_reason: null,
      is_websocket: false,
      websocket_direction: null,
      error_message: null,
      request: {
        method: "GET",
        url: "http://localhost/v1/models",
        headers: {},
        bodyDataUrl: null,
        bodySize: 0,
      },
    });
    
    // 响应没有 hook 修改
    const responseBody = JSON.stringify({ models: [] });
    const responseBodyDataUrl = bufferToDataUrl(Buffer.from(responseBody), "application/json");
    
    updateProxyRequest(id, {
      status: "completed",
      response: {
        statusCode: 200,
        statusMessage: "OK",
        headers: { "content-type": "application/json" },
        bodyDataUrl: responseBodyDataUrl,
        bodySize: responseBody.length,
        ttfbMs: 50,
        bodyMs: 20,
        contentType: "application/json",
      },
      // 没有 hookedResponse
      hookedResponse: undefined,
      // 有 layer 但 modified=false
      responseHookLayers: [
        {
          pluginName: "test-plugin",
          modified: false,
          statusCode: undefined,
          statusMessage: undefined,
          headers: undefined,
          bodyDataUrl: null,
          contentType: null,
        },
      ],
    });
    
    // 读取并验证
    const fetched = getProxyRequestById(id);
    expect(fetched).not.toBeNull();
    
    // 验证响应存在
    expect(fetched?.response).not.toBeNull();
    expect(fetched?.response?.bodyDataUrl).not.toBeNull();
    
    // 验证 hookedResponse 不存在（因为没有 hook 修改）
    expect(fetched?.hookedResponse).toBeUndefined();
    
    // 验证 responseHookLayers 存在但 modified=false
    expect(fetched?.responseHookLayers).not.toBeUndefined();
    expect(fetched?.responseHookLayers?.length).toBe(1);
    expect(fetched?.responseHookLayers?.[0]?.modified).toBe(false);
    
    // 清理
    clearAllRequests();
  });

  test("should handle hooked_response_body without hooked_response_headers", async () => {
    // 这个测试模拟实际情况：response_hooked body 存在，但 response_hooked headers 不存在
    const { db } = await import("../src/lib/db");
    const { getProxyRequestById, clearAllRequests } = await import("../src/lib/db-requests");
    const { bufferToDataUrl, dataUrlToBuffer } = await import("../src/lib/data-url");
    
    clearAllRequests();
    
    // 直接在数据库中插入数据，模拟实际存储情况
    const requestBody = Buffer.from(JSON.stringify({ model: "gpt-4" }));
    const hookedRequestBody = Buffer.from(JSON.stringify({ model: "gpt-4", injected: true }));
    const responseBody = Buffer.from(JSON.stringify({ id: "123", choices: [] }));
    const hookedResponseBody = Buffer.from(JSON.stringify({ id: "123", choices: [], usage: {} }));
    
    // 插入主表
    const result = db.query(`
      INSERT INTO requests (
        request_id, timestamp, instance_name, forward_name, forward_id,
        method, url, status, has_request_hook_changes, has_response_hook_changes,
        status_code, status_message, request_body_size, response_body_size
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "test-hooked-no-headers", new Date().toISOString(), "test", "test", "test-id",
      "POST", "http://localhost/test", "completed", 1, 1,
      200, "OK", requestBody.length, responseBody.length
    );
    const id = Number(result.lastInsertRowid);
    
    // 插入 headers（注意：没有 response_hooked headers）
    db.query(`INSERT INTO request_headers (request_id, stage, headers) VALUES (?, ?, ?)`).run(id, "request_origin", "{}");
    db.query(`INSERT INTO request_headers (request_id, stage, headers) VALUES (?, ?, ?)`).run(id, "request_hooked", "{}");
    db.query(`INSERT INTO request_headers (request_id, stage, headers) VALUES (?, ?, ?)`).run(id, "response_origin", "{}");
    // 不插入 response_hooked headers
    
    // 插入 bodies（包括 response_hooked body）
    db.query(`INSERT INTO request_bodies (request_id, stage, content_type, body, body_size) VALUES (?, ?, ?, ?, ?)`).run(id, "request_origin", "application/json", requestBody, requestBody.length);
    db.query(`INSERT INTO request_bodies (request_id, stage, content_type, body, body_size) VALUES (?, ?, ?, ?, ?)`).run(id, "request_hooked", "application/json", hookedRequestBody, hookedRequestBody.length);
    db.query(`INSERT INTO request_bodies (request_id, stage, content_type, body, body_size) VALUES (?, ?, ?, ?, ?)`).run(id, "response_origin", "application/json", responseBody, responseBody.length);
    db.query(`INSERT INTO request_bodies (request_id, stage, content_type, body, body_size) VALUES (?, ?, ?, ?, ?)`).run(id, "response_hooked", "application/json", hookedResponseBody, hookedResponseBody.length);
    
    // 读取并验证
    const fetched = getProxyRequestById(id);
    expect(fetched).not.toBeNull();
    
    // 验证 hookedRequest 存在
    expect(fetched?.hookedRequest).not.toBeUndefined();
    expect(fetched?.hookedRequest?.bodyDataUrl).not.toBeNull();
    
    // 关键：验证 hookedResponse 存在（即使没有 hooked headers）
    expect(fetched?.hookedResponse).not.toBeUndefined();
    expect(fetched?.hookedResponse?.bodyDataUrl).not.toBeNull();
    const fetchedHookedResBody = dataUrlToBuffer(fetched!.hookedResponse!.bodyDataUrl!);
    expect(fetchedHookedResBody.buffer.toString()).toBe(hookedResponseBody.toString());
    
    clearAllRequests();
  });

  test("full request-response flow with hooks should store all body stages", async () => {
    const { 
      createProxyRequest, 
      updateProxyRequest,
      getProxyRequestById,
      clearAllRequests 
    } = await import("../src/lib/db-requests");
    const { bufferToDataUrl, dataUrlToBuffer } = await import("../src/lib/data-url");
    
    // 清理
    clearAllRequests();
    
    // 原始请求
    const originalRequestBody = JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "Hello" }] });
    const originalRequestBodyDataUrl = bufferToDataUrl(Buffer.from(originalRequestBody), "application/json");
    
    // Hooked 请求（注入了 system prompt）
    const hookedRequestBody = JSON.stringify({ 
      model: "gpt-4", 
      messages: [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "Hello" }
      ] 
    });
    const hookedRequestBodyDataUrl = bufferToDataUrl(Buffer.from(hookedRequestBody), "application/json");
    
    // 创建请求
    const id = createProxyRequest({
      request_id: "test-full-flow-1",
      timestamp: new Date().toISOString(),
      instance_name: "openai-proxy",
      forward_name: "chat",
      forward_id: "forward-1",
      group_name: "openai-proxy/chat",
      status: "pending",
      abort_reason: null,
      is_websocket: false,
      websocket_direction: null,
      error_message: null,
      request: {
        method: "POST",
        url: "http://localhost:27001/v1/chat/completions",
        headers: { "content-type": "application/json", "authorization": "Bearer sk-xxx" },
        bodyDataUrl: originalRequestBodyDataUrl,
        bodySize: originalRequestBody.length,
      },
      hookedRequest: {
        method: "POST",
        url: "http://localhost:27001/v1/chat/completions",
        headers: { "content-type": "application/json", "authorization": "Bearer sk-xxx", "x-injected": "true" },
        bodyDataUrl: hookedRequestBodyDataUrl,
        bodySize: hookedRequestBody.length,
      },
      requestHookLayers: [
        {
          pluginName: "openai4droid",
          modified: true,
          headers: { "content-type": "application/json" },
          bodyDataUrl: hookedRequestBodyDataUrl,
          contentType: "application/json",
        },
      ],
    });
    
    // 原始响应
    const originalResponseBody = JSON.stringify({ 
      id: "chatcmpl-123", 
      choices: [{ message: { role: "assistant", content: "Hi there!" } }] 
    });
    const originalResponseBodyDataUrl = bufferToDataUrl(Buffer.from(originalResponseBody), "application/json");
    
    // Hooked 响应（添加了 usage 信息）
    const hookedResponseBody = JSON.stringify({ 
      id: "chatcmpl-123", 
      choices: [{ message: { role: "assistant", content: "Hi there!" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });
    const hookedResponseBodyDataUrl = bufferToDataUrl(Buffer.from(hookedResponseBody), "application/json");
    
    // 更新响应
    updateProxyRequest(id, {
      status: "completed",
      response: {
        statusCode: 200,
        statusMessage: "OK",
        headers: { "content-type": "application/json" },
        bodyDataUrl: originalResponseBodyDataUrl,
        bodySize: originalResponseBody.length,
        ttfbMs: 150,
        bodyMs: 80,
        contentType: "application/json",
      },
      hookedResponse: {
        statusCode: 200,
        statusMessage: "OK",
        headers: { "content-type": "application/json", "x-usage-injected": "true" },
        bodyDataUrl: hookedResponseBodyDataUrl,
        bodySize: hookedResponseBody.length,
        ttfbMs: 150,
        bodyMs: 80,
        contentType: "application/json",
      },
      responseHookLayers: [
        {
          pluginName: "openai4droid",
          modified: true,
          statusCode: 200,
          statusMessage: "OK",
          headers: { "content-type": "application/json" },
          bodyDataUrl: hookedResponseBodyDataUrl,
          contentType: "application/json",
        },
      ],
    });
    
    // 读取并验证所有 body 阶段
    const fetched = getProxyRequestById(id);
    expect(fetched).not.toBeNull();
    expect(fetched?.status).toBe("completed");
    
    // 1. 验证原始请求 body
    expect(fetched?.request.bodyDataUrl).not.toBeNull();
    const fetchedReqBody = dataUrlToBuffer(fetched!.request.bodyDataUrl!);
    expect(fetchedReqBody.buffer.toString()).toBe(originalRequestBody);
    
    // 2. 验证 hooked 请求 body
    expect(fetched?.hookedRequest).not.toBeUndefined();
    expect(fetched?.hookedRequest?.bodyDataUrl).not.toBeNull();
    const fetchedHookedReqBody = dataUrlToBuffer(fetched!.hookedRequest!.bodyDataUrl!);
    expect(fetchedHookedReqBody.buffer.toString()).toBe(hookedRequestBody);
    
    // 3. 验证 request hook layer body
    expect(fetched?.requestHookLayers).not.toBeUndefined();
    expect(fetched?.requestHookLayers?.length).toBe(1);
    expect(fetched?.requestHookLayers?.[0]?.bodyDataUrl).not.toBeNull();
    const fetchedReqLayerBody = dataUrlToBuffer(fetched!.requestHookLayers![0]!.bodyDataUrl!);
    expect(fetchedReqLayerBody.buffer.toString()).toBe(hookedRequestBody);
    
    // 4. 验证原始响应 body
    expect(fetched?.response).not.toBeNull();
    expect(fetched?.response?.bodyDataUrl).not.toBeNull();
    const fetchedResBody = dataUrlToBuffer(fetched!.response!.bodyDataUrl!);
    expect(fetchedResBody.buffer.toString()).toBe(originalResponseBody);
    
    // 5. 验证 hooked 响应 body
    expect(fetched?.hookedResponse).not.toBeUndefined();
    expect(fetched?.hookedResponse?.bodyDataUrl).not.toBeNull();
    const fetchedHookedResBody = dataUrlToBuffer(fetched!.hookedResponse!.bodyDataUrl!);
    expect(fetchedHookedResBody.buffer.toString()).toBe(hookedResponseBody);
    
    // 6. 验证 response hook layer body
    expect(fetched?.responseHookLayers).not.toBeUndefined();
    expect(fetched?.responseHookLayers?.length).toBe(1);
    expect(fetched?.responseHookLayers?.[0]?.bodyDataUrl).not.toBeNull();
    const fetchedResLayerBody = dataUrlToBuffer(fetched!.responseHookLayers![0]!.bodyDataUrl!);
    expect(fetchedResLayerBody.buffer.toString()).toBe(hookedResponseBody);
    
    // 清理
    clearAllRequests();
  });
});

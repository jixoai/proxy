import { describe, it, expect } from "bun:test";
import { createDroidPlugin } from "../plugin";
import { createMockStore, type RequestHookParams, type ResponseHookParams } from "@jixo/proxy-plugin";

/** 创建测试用的 RequestHookParams */
function createRequestParams(params: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}): RequestHookParams {
  return {
    meta: {
      method: params.method,
      url: params.url,
      headers: params.headers,
    },
    body: params.body,
    store: createMockStore(),
  };
}

/** 创建测试用的 ResponseHookParams */
function createResponseParams(params: {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
  /** 是否模拟请求已被处理（默认 true） */
  activated?: boolean;
  /** 模拟请求体大小（字节），用于 server anomaly 判断 */
  requestBodyLength?: number;
}): ResponseHookParams {
  return {
    meta: {
      statusCode: params.statusCode,
      headers: params.headers,
    },
    body: params.body,
    store: createMockStore(
      params.activated !== false
        ? {
            activated: true as const,
            // 默认模拟为“大请求”，避免触发 server anomaly 分支影响基础重写逻辑
            requestBodyLength: params.requestBodyLength ?? 700 * 1024,
          }
        : undefined,
    ),
  };
}

describe("createDroidPlugin", () => {
  it("should create a plugin with correct name", () => {
    const plugin = createDroidPlugin();
    expect(plugin.name).toBe("anthropic4droid");
  });

  it("should have onRequest handler", () => {
    const plugin = createDroidPlugin();
    expect(plugin.onRequest).toBeDefined();
  });

  it("should have onResponse handler", () => {
    const plugin = createDroidPlugin();
    expect(plugin.onResponse).toBeDefined();
  });

  it("should rewrite Droid request", async () => {
    const plugin = createDroidPlugin();
    const body = JSON.stringify({
      model: "claude-3-opus",
      system: "You are Droid, an AI assistant.",
      messages: [{ role: "user", content: "Hello" }],
    });

    const params = createRequestParams({
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-123",
      },
      body: Buffer.from(body),
    });

    const result = await plugin.onRequest!(params);

    expect(result).not.toBeNull();
    // 检查不是 { modified: false }（跳过）
    expect(!("modified" in result!) || result!.modified !== false).toBe(true);

    const modifiedResult = result as { meta?: { headers?: Record<string, string> }; body?: Buffer };
    expect(modifiedResult.meta?.headers).toBeDefined();
    expect(modifiedResult.body).toBeDefined();

    const headers = modifiedResult.meta!.headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toContain("claude-code");
    expect(headers["authorization"]).toBe("Bearer sk-ant-123");

    const parsedBody = JSON.parse(modifiedResult.body!.toString("utf-8"));
    expect(Array.isArray(parsedBody.system)).toBe(true);
    expect(parsedBody.system[0].text).toContain("Claude Code");
  });

  it("should return null for non-Droid request", async () => {
    const plugin = createDroidPlugin();
    const body = JSON.stringify({
      system: "You are Claude.",
      messages: [],
    });

    const params = createRequestParams({
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: { "content-type": "application/json" },
      body: Buffer.from(body),
    });

    const result = await plugin.onRequest!(params);

    expect(result).toBeNull();
  });

  it("should rewrite upstream request failed error response", async () => {
    const plugin = createDroidPlugin();
    const body = JSON.stringify({
      type: "error",
      error: {
        code: 400,
        type: "server_error",
        message: "Upstream request failed",
      },
    });

    const params = createResponseParams({
      statusCode: 400,
      headers: { "content-type": "application/json" },
      body: Buffer.from(body),
    });

    const result = await plugin.onResponse!(params);

    expect(result).not.toBeNull();
    // 检查不是 { modified: false }（跳过）
    expect(!("modified" in result!) || result!.modified !== false).toBe(true);

    const modifiedResult = result as { meta?: { statusCode?: number }; body?: Buffer };
    expect(modifiedResult.meta?.statusCode).toBe(400);

    const parsedBody = JSON.parse(modifiedResult.body!.toString("utf-8"));
    expect(parsedBody.error.code).toBe("context_length_exceeded");
    expect(parsedBody.error.type).toBe("invalid_request_error");
  });

  it("should return null for normal response", async () => {
    const plugin = createDroidPlugin();
    const body = JSON.stringify({
      type: "message",
      content: [{ type: "text", text: "Hello!" }],
    });

    const params = createResponseParams({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from(body),
    });

    const result = await plugin.onResponse!(params);

    // 虽然请求被处理过，但正常响应不需要重写
    expect(result).toBeNull();
  });

  it("should skip response if request was not processed", async () => {
    const plugin = createDroidPlugin();
    const body = JSON.stringify({
      type: "error",
      error: {
        code: 400,
        type: "server_error",
        message: "Upstream request failed",
      },
    });

    const params = createResponseParams({
      statusCode: 400,
      headers: { "content-type": "application/json" },
      body: Buffer.from(body),
      activated: false, // 请求未被处理
    });

    const result = await plugin.onResponse!(params);

    // 请求未被处理，跳过响应重写
    expect(result).toBeNull();
  });
});
